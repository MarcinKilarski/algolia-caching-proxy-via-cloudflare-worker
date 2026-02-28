import { ALLOWED_ORIGIN } from './config.js';

/**
 * Generates CORS headers.
 * @returns {Object} CORS headers.
 */
export function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-algolia-application-id, x-algolia-api-key, x-algolia-agent",
    // Setting a high value (e.g., 86400 for 24 hours) reduces unnecessary network requests,
    // improves performance, and decreases server load by allowing subsequent requests to skip the preflight check.
    "Access-Control-Max-Age": "86400", // 24 hours
  };
}

/**
 * Generates a SHA-256 hash of a string.
 * @param {string} message - The string to hash.
 * @returns {Promise<string>} The hex-encoded hash.
 */
export async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Wraps a response with CORS headers.
 * @param {Response} response - The original response.
 * @param {Request} request - The incoming request.
 * @returns {Response} A new response object with CORS headers applied.
 */
export function applyCors(response, request) {
  const newResponse = new Response(response.body, response);
  Object.entries(getCorsHeaders(request)).forEach(([key, value]) => {
    newResponse.headers.set(key, value);
  });

  // Remove encoding and length headers to let Cloudflare handle compression correctly.
  // This prevents the browser from receiving decompressed data that still has a 'gzip' header.
  newResponse.headers.delete("content-encoding");
  newResponse.headers.delete("content-length");

  return newResponse;
}

/**
 * Normalizes the Algolia request body by removing user-specific tokens that break caching.
 * @param {string} body - The raw request body.
 * @returns {string} The normalized body.
 */
export function normalizeAlgoliaBody(body) {
  return body
    .replace(/&?userToken=[^&"\\]*/g, '')
    .replace(/params":"&/g, 'params":"')
    .replace(/&$/, ''); // Clean up trailing ampersands
}

/**
 * Checks if the request origin is allowed based on ALLOWED_ORIGIN configuration.
 * @param {Request} request - The incoming request.
 * @returns {Response|null} A 403 Forbidden response if not allowed, or null if allowed.
 */
export function checkOrigin(request) {
  const origin = request.headers.get("Origin");
  const isWildcardAllowed = Array.isArray(ALLOWED_ORIGIN) ? ALLOWED_ORIGIN.includes('*') : ALLOWED_ORIGIN === '*';

  // Any requests without origin (e.g., direct curl commands or bot traffic not mimicking a browser) 
  // will be met with a 403 Forbidden response, unless we are globally allowing '*' (e.g., for local testing/curl).
  if (!origin) {
    if (isWildcardAllowed) return null;
    return new Response("Forbidden: Missing Origin", { status: 403 });
  }

  const isAllowed = isWildcardAllowed ||
    (Array.isArray(ALLOWED_ORIGIN) ? ALLOWED_ORIGIN.includes(origin) : ALLOWED_ORIGIN === origin);

  if (!isAllowed) {
    return new Response("Forbidden: Origin not allowed", { status: 403 });
  }

  return null;
}