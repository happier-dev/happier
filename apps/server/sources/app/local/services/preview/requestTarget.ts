/**
 * Canonical owner of the local-service preview request target — the `path` (and the composed
 * `path + search`) that both preview entry points splice into CRLF-terminated wire positions.
 *
 * Why this exists (S-1): Fastify's router (`find-my-way`) percent-DECODES the proxy wildcard
 * before a handler runs, so a client path of `foo%0d%0aX-Injected:%20yes` arrives in
 * `params['*']` as a real CRLF. Two sinks are terminated by CRLF and were splicing that value
 * verbatim:
 *   1. the raw HTTP/1.1 request line written to the upstream tunnel
 *      (`httpAdapter.ts` / `websocketAdapter.ts`), and
 *   2. the `Location` header of the token-exchange redirect
 *      (`api/routes/local/services/{preview,public}/registerRoutes.ts`).
 *
 * The fix re-encodes rather than rejects, so every path a client can legitimately express keeps
 * working while the result is structurally incapable of terminating a request line or a header.
 *
 * Canonical form is RFC 3986 `path-absolute`: every byte outside
 * `unreserved / sub-delims / ":" / "@"` (plus the `/` separator) is percent-encoded. Because
 * `%` is itself encoded, applying this to a router-decoded path reproduces exactly the bytes the
 * client sent on the wire.
 *
 * IMPORTANT: encoding is therefore NOT idempotent and must be applied exactly once, at the entry
 * boundary where the router hands over a decoded value. Values that are already canonical —
 * notably `URL.pathname`, which the WebSocket upgrade routes use — must NOT be re-encoded; the
 * adapters guard them with `isSafeLocalServiceRequestTarget` instead.
 */

const PATH_SAFE_BYTES: ReadonlySet<number> = new Set(
    Array.from(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/",
        (character) => character.charCodeAt(0),
    ),
);

const UPPERCASE_HEX = "0123456789ABCDEF";
const textEncoder = new TextEncoder();

/**
 * Re-encodes a router-decoded wildcard path into a canonical, always-rooted request path.
 */
export function encodeLocalServiceRequestPath(routerDecodedPath: string): string {
    let encoded = "";
    for (const byte of textEncoder.encode(routerDecodedPath.replace(/^\/+/u, ""))) {
        encoded += PATH_SAFE_BYTES.has(byte)
            ? String.fromCharCode(byte)
            : `%${UPPERCASE_HEX[byte >> 4]}${UPPERCASE_HEX[byte & 0x0f]}`;
    }
    return `/${encoded}`;
}

/**
 * Fail-closed guard for the value spliced into a raw HTTP/1.1 request line. A canonical request
 * target never contains a control character or a space; either would terminate the request line
 * or its method/target/version split.
 */
export function isSafeLocalServiceRequestTarget(target: string): boolean {
    if (!target.startsWith("/")) return false;
    for (let index = 0; index < target.length; index += 1) {
        const code = target.charCodeAt(index);
        if (code <= 0x20 || code === 0x7f) return false;
    }
    return true;
}

/**
 * Fail-closed guard for a header name or value spliced into a raw HTTP/1.1 header line. Node's
 * own parser already rejects these upstream of the route handlers, so this keeps the invariant
 * local to the serializer that owns it rather than borrowing it from a caller.
 */
export function isSafeLocalServiceHeaderField(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === 0x0d || code === 0x0a || code === 0x00) return false;
    }
    return true;
}
