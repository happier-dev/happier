import type { TranscriptNavigationEntryPressHandler } from './transcriptNavigationTypes';

/**
 * Registry of the transcript host's jump handler, keyed by session.
 *
 * It deliberately carries nothing else: navigation entries come from the session-scoped
 * derivation owner (`useSessionTranscriptNavigationEntries`) and the reader's current
 * position comes from the navigation visibility store, so both work with no transcript
 * mounted. Publishing either of them here again would re-create the split-brain those
 * owners removed.
 */
export type TranscriptNavigationPaneSnapshot = Readonly<{
    sessionId: string;
    onEntryPress: TranscriptNavigationEntryPressHandler | null;
}>;

export type TranscriptNavigationPaneStore = Readonly<{
    get: (sessionId: string) => TranscriptNavigationPaneSnapshot;
    set: (
        sessionId: string,
        next: Readonly<{
            onEntryPress: TranscriptNavigationEntryPressHandler;
        }> | null,
    ) => void;
    subscribe: (sessionId: string, listener: () => void) => () => void;
}>;

const emptySnapshotsBySessionId = new Map<string, TranscriptNavigationPaneSnapshot>();

/**
 * How long a reveal-then-jump press waits for the transcript host to register its jump
 * handler. The host publishes from a layout effect, and React tears layout effects down
 * inside a hidden/frozen scene, so on the mobile right-panel route the handler is genuinely
 * absent until the transcript screen is revealed again. Past this budget the press reports
 * `not-found`, which renders the inline retry affordance instead of hanging silently.
 */
export const TRANSCRIPT_NAVIGATION_JUMP_HANDLER_WAIT_TIMEOUT_MS = 4_000;

function normalizeSessionId(sessionId: string): string {
    return sessionId.trim();
}

export function createEmptyTranscriptNavigationPaneSnapshot(sessionId: string): TranscriptNavigationPaneSnapshot {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const existing = emptySnapshotsBySessionId.get(normalizedSessionId);
    if (existing) return existing;
    const snapshot = {
        onEntryPress: null,
        sessionId: normalizedSessionId,
    };
    emptySnapshotsBySessionId.set(normalizedSessionId, snapshot);
    return snapshot;
}

function normalizeSnapshot(
    sessionId: string,
    next: Parameters<TranscriptNavigationPaneStore['set']>[1],
): TranscriptNavigationPaneSnapshot {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!next) return createEmptyTranscriptNavigationPaneSnapshot(normalizedSessionId);
    return {
        onEntryPress: next.onEntryPress,
        sessionId: normalizedSessionId,
    };
}

function snapshotsEqual(left: TranscriptNavigationPaneSnapshot, right: TranscriptNavigationPaneSnapshot): boolean {
    return left.sessionId === right.sessionId
        && left.onEntryPress === right.onEntryPress;
}

export function createTranscriptNavigationPaneStore(): TranscriptNavigationPaneStore {
    const snapshotsBySessionId = new Map<string, TranscriptNavigationPaneSnapshot>();
    const listenersBySessionId = new Map<string, Set<() => void>>();

    function notify(sessionId: string) {
        for (const listener of listenersBySessionId.get(sessionId) ?? []) {
            listener();
        }
    }

    return {
        get(sessionId) {
            const normalizedSessionId = normalizeSessionId(sessionId);
            return snapshotsBySessionId.get(normalizedSessionId)
                ?? createEmptyTranscriptNavigationPaneSnapshot(normalizedSessionId);
        },
        set(sessionId, next) {
            const normalizedSessionId = normalizeSessionId(sessionId);
            const current = snapshotsBySessionId.get(normalizedSessionId)
                ?? createEmptyTranscriptNavigationPaneSnapshot(normalizedSessionId);
            const normalizedNext = normalizeSnapshot(normalizedSessionId, next);
            if (snapshotsEqual(current, normalizedNext)) return;
            if (!next) {
                snapshotsBySessionId.delete(normalizedSessionId);
            } else {
                snapshotsBySessionId.set(normalizedSessionId, normalizedNext);
            }
            notify(normalizedSessionId);
        },
        subscribe(sessionId, listener) {
            const normalizedSessionId = normalizeSessionId(sessionId);
            let listeners = listenersBySessionId.get(normalizedSessionId);
            if (!listeners) {
                listeners = new Set();
                listenersBySessionId.set(normalizedSessionId, listeners);
            }
            listeners.add(listener);
            return () => {
                const current = listenersBySessionId.get(normalizedSessionId);
                if (!current) return;
                current.delete(listener);
                if (current.size === 0) {
                    listenersBySessionId.delete(normalizedSessionId);
                }
            };
        },
    };
}

export const transcriptNavigationPaneStore = createTranscriptNavigationPaneStore();

export function readTranscriptNavigationJumpHandler(sessionId: string): TranscriptNavigationEntryPressHandler | null {
    return transcriptNavigationPaneStore.get(sessionId).onEntryPress;
}

/**
 * Resolves the session's transcript jump handler *after* the caller's reveal has had a
 * chance to commit.
 *
 * Ordering matters: a navigation press first asks its host to reveal the transcript
 * (navigate back to the transcript route). Calling the currently-registered handler
 * synchronously would scroll a scene that is still hidden, and on a frozen scene there is
 * usually no handler registered at all until the transcript screen un-freezes and re-runs
 * the host's layout effect. So: always yield a task first, then take the handler,
 * otherwise wait for the host to publish one.
 */
export function awaitTranscriptNavigationJumpHandler(
    sessionId: string,
    options: Readonly<{ timeoutMs?: number }> = {},
): Promise<TranscriptNavigationEntryPressHandler | null> {
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(0, Math.trunc(options.timeoutMs))
        : TRANSCRIPT_NAVIGATION_JUMP_HANDLER_WAIT_TIMEOUT_MS;

    return new Promise<TranscriptNavigationEntryPressHandler | null>((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        const settle = (handler: TranscriptNavigationEntryPressHandler | null) => {
            if (settled) return;
            settled = true;
            unsubscribe?.();
            if (timeoutId !== null) clearTimeout(timeoutId);
            resolve(handler);
        };

        unsubscribe = transcriptNavigationPaneStore.subscribe(sessionId, () => {
            const handler = readTranscriptNavigationJumpHandler(sessionId);
            if (handler) settle(handler);
        });
        timeoutId = setTimeout(() => settle(readTranscriptNavigationJumpHandler(sessionId)), timeoutMs);
        setTimeout(() => {
            const handler = readTranscriptNavigationJumpHandler(sessionId);
            if (handler) settle(handler);
        }, 0);
    });
}
