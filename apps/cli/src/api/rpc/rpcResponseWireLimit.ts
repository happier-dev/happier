/**
 * Canonical ceiling for a single daemon RPC response frame (machine- and session-scoped).
 *
 * Protected contract: the daemon → relay socket channel carries one RPC reply per frame.
 * Evidence basis (operator daemon/relay logs, not code): a machine websocket dropped
 * whenever an `scm.status.snapshot` reply reached ~17.4 MB encoded; the death threshold is
 * bracketed at ~12-14 MB, while replies up to 11.03 MB were delivered successfully across
 * 4,897 snapshots and 7 days with 2 unrelated disconnects. The relay's code-side cap
 * (`maxHttpBufferSize`, apps/server default 25,000,000) is ABOVE the observed death point,
 * so it is not the operative boundary.
 *
 * Why the default sits below the observed-working band: the only payload class ever
 * observed in the 8-11 MB band was `scm.status.snapshot`, whose entry list is now bounded
 * (~4 MiB) and delivered as a summary + paged entries; no other single reply is expected
 * near that size at supported configuration. The 8 MB default therefore keeps ~33% margin
 * to the 12 MB death floor while leaving every supported single-reply path reachable —
 * provided the knobs that size those replies are bounded to the envelope, which is what
 * MAX_SINGLE_REPLY_PAYLOAD_BYTES enforces (HAPPIER_FILES_READ_MAX_BYTES). Deployments that
 * prove a higher relay cap may raise the ceiling with HAPPIER_RPC_RESPONSE_MAX_BYTES.
 *
 * Largest legitimate single replies (encoded/encrypted, not pre-encryption objects):
 * - files read: bounded by MAX_SINGLE_REPLY_PAYLOAD_BYTES (raw) → ~8 MB base64 at the bound;
 * - transfer chunk download: filesTransferChunkBytes env max 5 MB → ~6.7 MB base64;
 * - transcript / session-event pages: maxPayloadChars capped at 32,768 chars;
 * - prompt asset/registry and workspace blob transfers cross the wire in chunked transfer
 *   sessions, so their per-reply size is chunk-sized, not asset/pack-sized.
 */
export const DEFAULT_RPC_RESPONSE_MAX_BYTES = 8_000_000;

/**
 * Largest RAW payload a single reply may carry, derived from the wire ceiling: base64 (plus
 * encryption envelope) expands a payload by ~4/3, so a raw payload must stay under 3/4 of
 * the frame ceiling to be deliverable. Single-reply payload knobs are bounded by this, so a
 * supported configuration cannot produce a reply the wire guard would have to refuse.
 */
export const MAX_SINGLE_REPLY_PAYLOAD_BYTES = Math.floor(DEFAULT_RPC_RESPONSE_MAX_BYTES * 3 / 4);

/** Upper env bound: the relay's code-side Socket.IO frame cap; never configure above it. */
export const RPC_RESPONSE_MAX_BYTES_ENV_MAX = 25_000_000;

/** Canonical env override for the daemon RPC response wire ceiling. */
export const HAPPIER_RPC_RESPONSE_MAX_BYTES = 'HAPPIER_RPC_RESPONSE_MAX_BYTES';
