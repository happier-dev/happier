/**
 * Voice transcript perf bounds.
 *
 * These are render/runtime bounds owned by the transcript layer (the protocol
 * `runtimeConfig` owner is out of scope for this lane, so the transcript-render
 * window and the in-memory unreconciled-event ring live with their only consumer
 * here). Keep them small and explicit so the projector/selector enforce a hard
 * cap instead of growing unbounded on long calls.
 */

/**
 * Active render window: the maximum number of transcript items the selector
 * projects for live rendering. This is a HARD CAP, not merely a default. Older
 * items page in through the existing session-message pagination/selector path;
 * they are not dropped from the store.
 */
export const VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW = 200;

/**
 * Canonical render-window resolver and bounding chokepoint. Every selector
 * append/merge/reconcile path resolves its window through this single owner so
 * the cap cannot be exceeded by any caller:
 *
 * - A missing / non-finite / non-positive request falls back to the cap.
 * - An explicit request is truncated to an integer and clamped to the cap, so
 *   `{ limit: 500 }` still resolves to {@link VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW}.
 *
 * Keeping the clamp here (not at the call site) means there is exactly one place
 * that knows the bound; the selector never re-implements bounding.
 */
export function resolveVoiceTranscriptRenderWindow(requestedLimit: number | undefined): number {
    if (typeof requestedLimit !== 'number' || !Number.isFinite(requestedLimit) || requestedLimit <= 0) {
        return VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW;
    }
    return Math.min(Math.trunc(requestedLimit), VOICE_TRANSCRIPT_ACTIVE_RENDER_WINDOW);
}

/**
 * Maximum number of in-memory unreconciled (provisional/ephemeral) projections
 * the projector retains before retiring the oldest. Reconciled ephemerals are
 * retired immediately on promotion; this ring only bounds the still-pending set.
 */
export const VOICE_TRANSCRIPT_UNRECONCILED_EVENT_RING_MAX = 500;

/**
 * Maximum number of per-conversation memo entries the transcript selector keeps
 * cached. The selector memoizes one entry per `conversationSessionId` it has
 * projected; without a cap that map grows for the lifetime of a long-lived app.
 * Bounding it with LRU eviction keeps recently-viewed conversations memoized
 * while retiring the least-recently-used keys, the same hard-cap discipline the
 * render window (200) and unreconciled ring (500) enforce in this layer.
 */
export const VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX = 64;
