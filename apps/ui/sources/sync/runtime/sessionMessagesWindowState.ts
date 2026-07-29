export type SessionMessagesWindowState = Readonly<{
    isWindowMode: boolean;
    windowId: string | null;
    targetSeq: number | null;
    windowMinSeq: number | null;
    windowMaxSeq: number | null;
    olderCursor: number | null;
    newerCursor: number | null;
    hasMoreOlder: boolean | null;
    hasMoreNewer: boolean | null;
    activatedAtMs: number | null;
    lifecycleEpoch: number;
}>;

function normalizeSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.trunc(value);
}

function normalizeEpoch(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
    return Math.trunc(value);
}

function nextLifecycleEpoch(state: SessionMessagesWindowState): number {
    return normalizeEpoch(state.lifecycleEpoch) + 1;
}

export function createInactiveSessionMessagesWindowState(lifecycleEpoch = 0): SessionMessagesWindowState {
    return {
        isWindowMode: false,
        windowId: null,
        targetSeq: null,
        windowMinSeq: null,
        windowMaxSeq: null,
        olderCursor: null,
        newerCursor: null,
        hasMoreOlder: null,
        hasMoreNewer: null,
        activatedAtMs: null,
        lifecycleEpoch: normalizeEpoch(lifecycleEpoch),
    };
}

export function activateSessionMessagesWindow(
    state: SessionMessagesWindowState,
    params: Readonly<{
        windowId: string;
        targetSeq: number;
        windowMinSeq: number;
        windowMaxSeq: number;
        olderCursor: number | null;
        newerCursor: number | null;
        hasMoreOlder: boolean | null;
        hasMoreNewer: boolean | null;
        activatedAtMs: number;
    }>,
): SessionMessagesWindowState {
    const targetSeq = normalizeSeq(params.targetSeq);
    const windowMinSeq = normalizeSeq(params.windowMinSeq);
    const windowMaxSeq = normalizeSeq(params.windowMaxSeq);
    const activatedAtMs = normalizeSeq(params.activatedAtMs);
    if (!params.windowId || targetSeq == null || windowMinSeq == null || windowMaxSeq == null || activatedAtMs == null) {
        return createInactiveSessionMessagesWindowState();
    }

    return {
        isWindowMode: true,
        windowId: params.windowId,
        targetSeq,
        windowMinSeq: Math.min(windowMinSeq, targetSeq, windowMaxSeq),
        windowMaxSeq: Math.max(windowMinSeq, targetSeq, windowMaxSeq),
        olderCursor: normalizeSeq(params.olderCursor),
        newerCursor: normalizeSeq(params.newerCursor),
        hasMoreOlder: params.hasMoreOlder,
        hasMoreNewer: params.hasMoreNewer,
        activatedAtMs,
        lifecycleEpoch: nextLifecycleEpoch(state),
    };
}

export function applySessionMessagesWindowPage(
    state: SessionMessagesWindowState,
    params: Readonly<{
        windowId: string;
        direction: 'older' | 'newer';
        messages: readonly { seq: number }[];
        nextCursor: number | null;
        hasMore: boolean | null;
    }>,
): SessionMessagesWindowState {
    if (!state.isWindowMode || state.windowId !== params.windowId) return state;

    const seqs = params.messages
        .map((message) => normalizeSeq(message.seq))
        .filter((seq): seq is number => seq !== null);
    const minSeq = seqs.length > 0 ? Math.min(...seqs) : null;
    const maxSeq = seqs.length > 0 ? Math.max(...seqs) : null;
    const nextCursor = normalizeSeq(params.nextCursor);

    if (params.direction === 'older') {
        return {
            ...state,
            windowMinSeq: minSeq == null ? state.windowMinSeq : Math.min(state.windowMinSeq ?? minSeq, minSeq),
            olderCursor: nextCursor,
            hasMoreOlder: params.hasMore,
        };
    }

    return {
        ...state,
        windowMaxSeq: maxSeq == null ? state.windowMaxSeq : Math.max(state.windowMaxSeq ?? maxSeq, maxSeq),
        newerCursor: nextCursor,
        hasMoreNewer: params.hasMore,
    };
}

export function resetSessionMessagesWindowForLiveTail(state: SessionMessagesWindowState): SessionMessagesWindowState {
    return createInactiveSessionMessagesWindowState(nextLifecycleEpoch(state));
}

export function resetSessionMessagesWindowForSessionSwitch(state: SessionMessagesWindowState): SessionMessagesWindowState {
    return createInactiveSessionMessagesWindowState(nextLifecycleEpoch(state));
}
