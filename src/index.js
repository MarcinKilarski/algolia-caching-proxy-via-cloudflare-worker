import { CDN_CACHE_TTL, BROWSER_CACHE_TTL } from './config.js';
import { sha256, applyCors, normalizeAlgoliaBody, getCorsHeaders, checkOrigin } from './utils.js';

export default {
	async fetch(request, env, ctx) {
		// Check if request is coming from allowed domain
		const originResponse = checkOrigin(request);
		if (originResponse) return originResponse;

		// Handle Preflight: Browsers check CORS permissions before the actual search
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: getCorsHeaders() });
		}

		try {
			if (request.method.toUpperCase() === "POST") {
				const bodyText = await request.clone().text();

				/**
				 * The "Cache Key" Trick
				 * Algolia uses POST for searches. Since POST requests aren't cached by default,
				 * we normalize the body (remove user-specific IDs) and hash it.
				 * We then create a fake 'GET' URL that represents this specific search query.
				 */
				const filteredBody = normalizeAlgoliaBody(bodyText);
				const requestUrl = new URL(request.url);
				const apiKey = requestUrl.searchParams.get('x-algolia-api-key') || request.headers.get('x-algolia-api-key') || '';
				// We include the API key in the hash to ensure that different API keys
				// for the same search query result in different cache keys, to prevent
				// leaking private data.
				const hashString = filteredBody + apiKey;
				const hash = await sha256(hashString);
				const cacheUrl = new URL(request.url);

				// We append the hash to the URL to make this search unique in the cache
				cacheUrl.pathname = `/cache${cacheUrl.pathname}/${hash}`;

				// We use 'cacheKey' object to check if it already cached in Cloudflare Cache API
				// with its response from Algolia
				const cacheKey = new Request(cacheUrl.toString(), {
					headers: request.headers,
					method: "GET",
				});

				const cache = caches.default;
				let response = await cache.match(cacheKey);

				// If we cannot find a cached version, we go fetch it from Algolia
				if (!response) {
					/**
					 * Dynamic Host Routing
					 * We need to send the request to [APP_ID]-dsn.algolia.net.
					 * We extract the App ID from either the URL params or the headers.
					 */
					const targetUrl = new URL(request.url);
					const algoliaAppId = targetUrl.searchParams.get('x-algolia-application-id') || request.headers.get('x-algolia-application-id');

					if (!algoliaAppId) {
						return applyCors(new Response("Missing Algolia Application ID", { status: 400 }), request);
					}

					// We rewrite the received request URL to the Cloudflare Worker 
					// to point to Algolia's actual API servers and fetch a list of results.
					targetUrl.port = '';
					targetUrl.protocol = 'https:';
					targetUrl.hostname = `${algoliaAppId}-dsn.algolia.net`;

					const originHeaders = new Headers(request.headers);
					originHeaders.set("Host", targetUrl.hostname);
					// We modified the JSON body (stripped user tokens), so the original Content-Length is no longer valid.
					// We must delete it, otherwise Algolia/Cloudflare will hang waiting for more bytes or return a 400 Bad Request.
					originHeaders.delete("Content-Length");

					const originResponse = await fetch(targetUrl.toString(), {
						method: "POST",
						headers: originHeaders,
						body: filteredBody,
					});

					if (!originResponse.ok) {
						return applyCors(originResponse, request);
					}

					/**
					 * Background Caching
					 * We prepare the response for the cache by adding TTL (Time To Live) headers.
					 */
					const responseToCache = new Response(originResponse.body, originResponse);
					responseToCache.headers.set("Cache-Control", `s-maxage=${CDN_CACHE_TTL}`);

					// Remove encoding and length headers to let Cloudflare handle compression correctly.
					// This prevents the browser from receiving decompressed data that still has a 'gzip' header.
					responseToCache.headers.delete("content-encoding");
					responseToCache.headers.delete("content-length");


					// Using ctx.waitUntil ensures the Worker stays alive long enough to finish 
					// writing to the cache even after the user gets their answer.
					ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));

					response = responseToCache;
				}

				// Add browser-level caching instructions before returning the response to a user's browser
				const finalResponse = applyCors(new Response(response.body, response), request);
				finalResponse.headers.set("Cache-Control", `public, max-age=${BROWSER_CACHE_TTL}`);

				return finalResponse;
			}

			// Return a generic OK response for non-POST requests (like health checks)
			return applyCors(new Response("Algolia Caching Proxy is operational.", { status: 200 }), request);

		} catch (e) {
			return new Response("Error thrown: " + e.message, {
				status: 500,
				headers: getCorsHeaders()
			});
		}
	}
};