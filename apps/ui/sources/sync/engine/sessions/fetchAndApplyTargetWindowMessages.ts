import type { ApiMessage } from '@/sync/api/types/apiTypes';
import {
    activateSessionMessagesWindow,
    applySessionMessagesWindowPage,
    type SessionMessagesWindowState,
} from '@/sync/runtime/sessionMessagesWindowState';
import { buildSessionMessagesPath, type SessionMessagesPageScope } from '@/sync/api/session/sessionMessagesApi';
import { parseStableSessionMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import type { NormalizedMessage } from '@/sync/typesRaw';

import {
    runSessionMessagesPagePipeline,
    type SessionMessagesEncryption,
    type SessionMessagesPageOptions,
} from './sessionMessagesPagePipeline';
import type { SessionReceivedMessages } from './sessionMessageCurrentness';

type TargetWindowTarget =
    | Readonly<{ kind: 'seq'; seq: number }>
    | Readonly<{ kind: 'route-message-id'; routeMessageId: string; seqHint: number }>;

type TargetWindowDirection = 'initial' | 'older' | 'newer';

type TargetWindowFetchResult = Readonly<{
    status: 'loaded' | 'not_found' | 'skipped_missing_session' | 'stale';
    windowId: string;
    targetSeq: number;
    targetPresent: boolean;
    rawSeqs: readonly number[];
    appliedSeqs: readonly number[];
    olderCursor: number | null;
    newerCursor: number | null;
    hasMoreOlder: boolean | null;
    hasMoreNewer: boolean | null;
}>;

type TargetWindowPageResult = Awaited<ReturnType<typeof runSessionMessagesPagePipeline>>;

// Monotonicity of this map is load-bearing. Entries are intentionally never removed between jumps
// within a session: removing an entry would reset the counter and allow an old in-flight request to
// win newest-initiated ordering after a session reconnect or window close/reopen.
const latestTargetWindowRequestEpochBySessionId = new Map<string, number>();
let nextTargetWindowRequestEpoch = 0;

function normalizeSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.trunc(value);
}

function targetSeq(target: TargetWindowTarget): number {
    return target.kind === 'seq' ? Math.trunc(target.seq) : Math.trunc(target.seqHint);
}

function routeTargetMatchesMessage(routeMessageId: string, message: ApiMessage): boolean {
    const stableRef = parseStableSessionMessageRouteId(routeMessageId);
    if (stableRef?.kind === 'server') return message.id === stableRef.value;
    if (stableRef?.kind === 'local') return message.localId === stableRef.value;
    return false;
}

function targetMatchesMessage(target: TargetWindowTarget, message: ApiMessage): boolean {
    if (target.kind === 'seq') {
        return message.seq === target.seq;
    }
    return routeTargetMatchesMessage(target.routeMessageId, message);
}

function hasTargetMessage(target: TargetWindowTarget, messages: readonly ApiMessage[]): boolean {
    return messages.some((message) => targetMatchesMessage(target, message));
}

function normalizedMessageMatchesToolRoute(routeMessageId: string, message: NormalizedMessage): boolean {
    const stableRef = parseStableSessionMessageRouteId(routeMessageId);
    if (stableRef?.kind !== 'tool') return false;
    if (message.role !== 'agent') return false;
    return message.content.some((content) => content.type === 'tool-call' && content.id === stableRef.value);
}

function hasTargetNormalizedMessage(target: TargetWindowTarget, messages: readonly NormalizedMessage[]): boolean {
    if (target.kind === 'seq') {
        return messages.some((message) => message.seq === target.seq);
    }

    const stableRef = parseStableSessionMessageRouteId(target.routeMessageId);
    if (stableRef?.kind === 'server') {
        return messages.some((message) => message.id === stableRef.value);
    }
    if (stableRef?.kind === 'local') {
        return messages.some((message) => message.localId === stableRef.value);
    }
    return messages.some((message) => normalizedMessageMatchesToolRoute(target.routeMessageId, message));
}

function hasAlreadyReceivedTargetMessage(
    target: TargetWindowTarget,
    messages: readonly ApiMessage[],
    receivedMessages: ReadonlyMap<string, number> | undefined,
): boolean {
    if (!receivedMessages) return false;
    return messages.some((message) =>
        targetMatchesMessage(target, message)
        && receivedMessages.has(message.id)
    );
}

function normalizeCursorFromPage(value: unknown): number | null {
    return normalizeSeq(value);
}

function normalizeHasMore(value: unknown, nextCursor: number | null): boolean {
    return typeof value === 'boolean' ? value : nextCursor !== null;
}

function markTargetWindowRequestInitiated(sessionId: string): number {
    nextTargetWindowRequestEpoch += 1;
    latestTargetWindowRequestEpochBySessionId.set(sessionId, nextTargetWindowRequestEpoch);
    return nextTargetWindowRequestEpoch;
}

function isLatestTargetWindowRequest(sessionId: string, requestEpoch: number): boolean {
    return latestTargetWindowRequestEpochBySessionId.get(sessionId) === requestEpoch;
}

/**
 * Clears all pending target-window request epochs. Call this on logout/account-switch so that any
 * in-flight first-activation fetches fail the newest-initiated-wins guard on commit.
 */
export function clearTargetWindowRequestEpochs(): void {
    latestTargetWindowRequestEpochBySessionId.clear();
    nextTargetWindowRequestEpoch = 0;
}

function shouldDropTargetWindowCommit(params: Readonly<{
    sessionId: string;
    requestEpoch: number;
    startedWindowState: SessionMessagesWindowState;
    commitWindowState: SessionMessagesWindowState;
    windowId: string;
}>): boolean {
    // Drop if a newer jump was initiated after this request started.
    if (!isLatestTargetWindowRequest(params.sessionId, params.requestEpoch)) return true;
    // Drop if the window state changed between our fetch start and commit (e.g., a concurrent jump
    // activated a different window, or a live-tail reset occurred). A stable epoch means the world
    // did not move and we are free to activate even if a different window was previously active.
    if (params.commitWindowState.lifecycleEpoch !== params.startedWindowState.lifecycleEpoch) return true;
    return false;
}

export async function fetchAndApplyTargetWindowMessages(params: {
    sessionId: string;
    windowId: string;
    target: TargetWindowTarget;
    direction: TargetWindowDirection;
    limit: number;
    scope?: SessionMessagesPageScope;
    sidechainId?: string | null;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    isRouteMessageIdLoaded?: (routeMessageId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: SessionReceivedMessages;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    getWindowState: () => SessionMessagesWindowState;
    setWindowState: (state: SessionMessagesWindowState) => void;
    now: () => number;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<TargetWindowFetchResult> {
    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0
        ? params.sidechainId.trim()
        : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchAndApplyTargetWindowMessages: sidechainId is required when scope=sidechain');
    }

    const targetSequence = targetSeq(params.target);
    const currentWindowState = params.getWindowState();
    const requestEpoch = markTargetWindowRequestInitiated(params.sessionId);
    // Only reuse an existing window cursor if the active window belongs to the same jump target.
    // Fresh activations use the initial dual-page path even when the strategy has a direction
    // hint, because newer-side pages are exclusive and can otherwise exclude the target row.
    const sameWindowActive = currentWindowState.isWindowMode && currentWindowState.windowId === params.windowId;
    const useInitialMaterialization = params.direction === 'initial' || !sameWindowActive;
    const pageDirection = !useInitialMaterialization && params.direction === 'newer' ? 'newer' : 'older';
    const beforeSeq = pageDirection === 'older'
        ? (useInitialMaterialization ? targetSequence + 1 : (currentWindowState.olderCursor ?? targetSequence + 1))
        : undefined;
    const afterSeq = pageDirection === 'newer'
        ? (currentWindowState.newerCursor ?? targetSequence)
        : undefined;
    const requestPath = buildSessionMessagesPath({
        sessionId: params.sessionId,
        scope,
        sidechainId,
        limit: params.limit,
        beforeSeq,
        afterSeq,
    });

    const loadPage = async (page: Readonly<{
        direction: 'older' | 'newer';
        requestPath: string;
        beforeSeq?: number;
        afterSeq?: number;
    }>): Promise<TargetWindowPageResult> => runSessionMessagesPagePipeline({
        sessionId: params.sessionId,
        purpose: 'target-window',
        page: {
            direction: page.direction,
            requestPath: page.requestPath,
            scope,
            sidechainId,
            limit: params.limit,
            beforeSeq: page.beforeSeq,
            afterSeq: page.afterSeq,
        },
        lifecyclePolicy: 'suppress',
        getSessionEncryption: params.getSessionEncryption,
        isSessionKnown: params.isSessionKnown,
        request: params.request,
        sessionReceivedMessages: params.sessionReceivedMessages,
        applyMessages: params.applyMessages,
        log: params.log,
        sessionEncryptionMode: params.sessionEncryptionMode,
        initialMessageDecryptBatchSize: params.initialMessageDecryptBatchSize,
        messageDecryptBatchSize: params.messageDecryptBatchSize,
        messageDecryptYieldDelayMs: params.messageDecryptYieldDelayMs,
        yieldToMessageDecryptBatch: params.yieldToMessageDecryptBatch,
    });

    const result = await loadPage({
        direction: pageDirection,
        requestPath,
        beforeSeq,
        afterSeq,
    });
    if (result.skippedMissingSession) {
        return {
            status: 'skipped_missing_session',
            windowId: params.windowId,
            targetSeq: targetSequence,
            targetPresent: false,
            rawSeqs: result.rawSeqs,
            appliedSeqs: result.appliedSeqs,
            olderCursor: currentWindowState.olderCursor,
            newerCursor: currentWindowState.newerCursor,
            hasMoreOlder: currentWindowState.hasMoreOlder,
            hasMoreNewer: currentWindowState.hasMoreNewer,
        };
    }

    const receivedMessages = params.sessionReceivedMessages.get(params.sessionId);
    const targetPresent = hasTargetNormalizedMessage(params.target, result.normalizedMessages)
        || hasAlreadyReceivedTargetMessage(params.target, result.page.messages, receivedMessages)
        || (
            params.target.kind === 'route-message-id'
            && params.isRouteMessageIdLoaded?.(params.target.routeMessageId) === true
        )
        || (
            params.direction !== 'initial'
            && currentWindowState.isWindowMode
            && currentWindowState.windowId === params.windowId
            && currentWindowState.targetSeq === targetSequence
        );
    if (!targetPresent) {
        return {
            status: 'not_found',
            windowId: params.windowId,
            targetSeq: targetSequence,
            targetPresent: false,
            rawSeqs: result.rawSeqs,
            appliedSeqs: result.appliedSeqs,
            olderCursor: currentWindowState.olderCursor,
            newerCursor: currentWindowState.newerCursor,
            hasMoreOlder: currentWindowState.hasMoreOlder,
            hasMoreNewer: currentWindowState.hasMoreNewer,
        };
    }

    let commitWindowState = params.getWindowState();
    if (shouldDropTargetWindowCommit({
        sessionId: params.sessionId,
        requestEpoch,
        startedWindowState: currentWindowState,
        commitWindowState,
        windowId: params.windowId,
    })) {
        return {
            status: 'stale',
            windowId: params.windowId,
            targetSeq: targetSequence,
            targetPresent: true,
            rawSeqs: result.rawSeqs,
            appliedSeqs: result.appliedSeqs,
            olderCursor: commitWindowState.olderCursor,
            newerCursor: commitWindowState.newerCursor,
            hasMoreOlder: commitWindowState.hasMoreOlder,
            hasMoreNewer: commitWindowState.hasMoreNewer,
        };
    }

    const pageResults: TargetWindowPageResult[] = [result];
    if (useInitialMaterialization) {
        pageResults.push(await loadPage({
            direction: 'newer',
            requestPath: buildSessionMessagesPath({
                sessionId: params.sessionId,
                scope,
                sidechainId,
                limit: params.limit,
                afterSeq: targetSequence,
            }),
            afterSeq: targetSequence,
        }));
    }

    const rawSeqs = pageResults.flatMap((pageResult) => pageResult.rawSeqs);
    const minSeq = rawSeqs.length > 0 ? Math.min(...rawSeqs) : targetSequence;
    const maxSeq = rawSeqs.length > 0 ? Math.max(...rawSeqs) : targetSequence;
    const nextBeforeSeq = normalizeCursorFromPage(result.page.nextBeforeSeq);
    const newerInitialResult = useInitialMaterialization ? pageResults[1] : null;
    const nextAfterSeq = normalizeCursorFromPage((newerInitialResult ?? result).page.nextAfterSeq);
    const appliedSeqs = pageResults.flatMap((pageResult) => pageResult.appliedSeqs);
    commitWindowState = params.getWindowState();
    if (shouldDropTargetWindowCommit({
        sessionId: params.sessionId,
        requestEpoch,
        startedWindowState: currentWindowState,
        commitWindowState,
        windowId: params.windowId,
    })) {
        return {
            status: 'stale',
            windowId: params.windowId,
            targetSeq: targetSequence,
            targetPresent: true,
            rawSeqs,
            appliedSeqs,
            olderCursor: commitWindowState.olderCursor,
            newerCursor: commitWindowState.newerCursor,
            hasMoreOlder: commitWindowState.hasMoreOlder,
            hasMoreNewer: commitWindowState.hasMoreNewer,
        };
    }

    const shouldActivateWindow = useInitialMaterialization
        || !commitWindowState.isWindowMode
        || commitWindowState.windowId !== params.windowId;
    const nextState = shouldActivateWindow
        ? activateSessionMessagesWindow(commitWindowState, {
            windowId: params.windowId,
            targetSeq: targetSequence,
            windowMinSeq: minSeq,
            windowMaxSeq: maxSeq,
            olderCursor: useInitialMaterialization ? nextBeforeSeq : (pageDirection === 'newer' ? targetSequence : nextBeforeSeq),
            newerCursor: useInitialMaterialization
                ? (nextAfterSeq ?? maxSeq)
                : (pageDirection === 'newer' ? nextAfterSeq : maxSeq),
            hasMoreOlder: useInitialMaterialization
                ? normalizeHasMore(result.page.hasMore, nextBeforeSeq)
                : (pageDirection === 'newer' ? null : normalizeHasMore(result.page.hasMore, nextBeforeSeq)),
            hasMoreNewer: useInitialMaterialization
                ? normalizeHasMore(newerInitialResult?.page.hasMore, nextAfterSeq)
                : (pageDirection === 'newer' ? normalizeHasMore(result.page.hasMore, nextAfterSeq) : null),
            activatedAtMs: params.now(),
        })
        : applySessionMessagesWindowPage(commitWindowState, {
            windowId: params.windowId,
            direction: pageDirection,
            messages: result.page.messages,
            nextCursor: pageDirection === 'newer' ? nextAfterSeq : nextBeforeSeq,
            hasMore: normalizeHasMore(result.page.hasMore, pageDirection === 'newer' ? nextAfterSeq : nextBeforeSeq),
        });
    params.setWindowState(nextState);

    return {
        status: 'loaded',
        windowId: params.windowId,
        targetSeq: targetSequence,
        targetPresent: true,
        rawSeqs,
        appliedSeqs,
        olderCursor: nextState.olderCursor,
        newerCursor: nextState.newerCursor,
        hasMoreOlder: nextState.hasMoreOlder,
        hasMoreNewer: nextState.hasMoreNewer,
    };
}
