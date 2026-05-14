import {
    splitCanvasReduce,
    SPLIT_CANVAS_DEFAULT_MAX_LEAVES,
} from '@/components/appShell/splitCanvas/model/splitCanvasReducer';
import {
    collectSplitCanvasLeaves,
    getFirstSplitCanvasLeafId,
} from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import type {
    SplitCanvasAction,
    SplitCanvasLeafNode,
    SplitCanvasState,
} from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import {
    createInitialSessionSplitCanvasSnapshot,
    createSessionSplitCanvasLeafNode,
    type SessionSplitCanvasLeafPayload,
    type SessionSplitCanvasPersistenceSnapshot,
} from '@/sync/domains/session/sessionSplitCanvasPersistence';

export type SessionSplitCanvasState = SplitCanvasState<SessionSplitCanvasLeafPayload>;

export type SessionSplitCanvasCommand =
    | Readonly<{
        type: 'openSessionInSplit';
        sessionId: string;
        direction: 'right' | 'down';
    }>
    | Readonly<{
        type: 'focusSession';
        sessionId: string;
    }>;

export function findSessionLeafIdBySessionId(
    state: SessionSplitCanvasState,
    sessionId: string,
): string | null {
    for (const leaf of collectSplitCanvasLeaves(state.root)) {
        if (leaf.payload.sessionId === sessionId) {
            return leaf.id;
        }
    }
    return null;
}

function findSessionLeafById(
    state: SessionSplitCanvasState,
    leafId: string | null | undefined,
): SplitCanvasLeafNode<SessionSplitCanvasLeafPayload> | null {
    const normalizedLeafId = String(leafId ?? '').trim();
    if (!normalizedLeafId) {
        return null;
    }

    return collectSplitCanvasLeaves(state.root).find((leaf) => leaf.id === normalizedLeafId) ?? null;
}

function createStateFromSnapshot(
    snapshot: SessionSplitCanvasPersistenceSnapshot,
): SessionSplitCanvasState {
    const leaves = collectSplitCanvasLeaves(snapshot.root);
    const leafIds = new Set(leaves.map((leaf) => leaf.id));
    const fallbackLeafId = leaves[0]?.id ?? null;
    return {
        root: snapshot.root,
        focusedLeafId: snapshot.focusedLeafId && leafIds.has(snapshot.focusedLeafId)
            ? snapshot.focusedLeafId
            : fallbackLeafId,
        maximizedLeafId: snapshot.maximizedLeafId && leafIds.has(snapshot.maximizedLeafId)
            ? snapshot.maximizedLeafId
            : null,
        maxLeaves: snapshot.maxLeaves,
    };
}

function replaceFocusedLeafWithRouteAnchor(
    state: SessionSplitCanvasState,
    sessionId: string,
): SessionSplitCanvasState {
    const focusedLeafId = state.focusedLeafId;
    if (!focusedLeafId) {
        return {
            root: createSessionSplitCanvasLeafNode(sessionId),
            focusedLeafId: `session-leaf:${sessionId}`,
            maximizedLeafId: null,
            maxLeaves: state.maxLeaves,
        };
    }

    return splitCanvasReduce(state, {
        type: 'replaceLeaf',
        leafId: focusedLeafId,
        nextLeaf: createSessionSplitCanvasLeafNode(sessionId),
    });
}

function replaceLeafWithRouteAnchor(
    state: SessionSplitCanvasState,
    leafId: string,
    sessionId: string,
): SessionSplitCanvasState {
    const replacedState = splitCanvasReduce(state, {
        type: 'replaceLeaf',
        leafId,
        nextLeaf: createSessionSplitCanvasLeafNode(sessionId),
    });
    return splitCanvasReduce(replacedState, {
        type: 'focusLeaf',
        leafId: `session-leaf:${sessionId}`,
    });
}

function focusExistingSessionLeaf(
    state: SessionSplitCanvasState,
    sessionId: string,
): SessionSplitCanvasState {
    const existingLeafId = findSessionLeafIdBySessionId(state, sessionId);
    if (!existingLeafId) {
        return state;
    }
    return splitCanvasReduce(state, {
        type: 'focusLeaf',
        leafId: existingLeafId,
    });
}

function openSessionInSplit(
    state: SessionSplitCanvasState,
    sessionId: string,
    direction: 'right' | 'down',
): SessionSplitCanvasState {
    const existingLeafId = findSessionLeafIdBySessionId(state, sessionId);
    if (existingLeafId) {
        return splitCanvasReduce(state, {
            type: 'focusLeaf',
            leafId: existingLeafId,
        });
    }

    const targetLeafId = state.focusedLeafId ?? getFirstSplitCanvasLeafId(state.root);
    if (!targetLeafId) {
        return {
            root: createSessionSplitCanvasLeafNode(sessionId),
            focusedLeafId: `session-leaf:${sessionId}`,
            maximizedLeafId: null,
            maxLeaves: state.maxLeaves,
        };
    }

    return splitCanvasReduce(state, {
        type: 'splitLeaf',
        targetLeafId,
        axis: direction === 'right' ? 'row' : 'column',
        placement: 'after',
        newLeaf: createSessionSplitCanvasLeafNode(sessionId),
    });
}

function materializeRouteAnchor(
    state: SessionSplitCanvasState,
    routeSessionId: string,
    options?: Readonly<{
        previousRouteSessionId?: string | null;
    }>,
): SessionSplitCanvasState {
    const existingLeafId = findSessionLeafIdBySessionId(state, routeSessionId);
    if (existingLeafId) {
        return splitCanvasReduce(state, {
            type: 'focusLeaf',
            leafId: existingLeafId,
        });
    }

    if (collectSplitCanvasLeaves(state.root).length <= 1) {
        return replaceFocusedLeafWithRouteAnchor(state, routeSessionId);
    }

    const openedInSplit = openSessionInSplit(state, routeSessionId, 'right');
    if (openedInSplit !== state) {
        return openedInSplit;
    }

    const previousRouteSessionId = String(options?.previousRouteSessionId ?? '').trim();
    if (previousRouteSessionId) {
        const previousRouteLeafId = findSessionLeafIdBySessionId(state, previousRouteSessionId);
        if (previousRouteLeafId) {
            return replaceLeafWithRouteAnchor(state, previousRouteLeafId, routeSessionId);
        }
    }

    return replaceFocusedLeafWithRouteAnchor(state, routeSessionId);
}

export function resolveSessionSplitCanvasState(input: Readonly<{
    sessionId: string;
    persistedSnapshot?: SessionSplitCanvasPersistenceSnapshot | null;
    maxLeaves?: number;
}>): SessionSplitCanvasState {
    const maxLeaves = input.persistedSnapshot?.maxLeaves ?? input.maxLeaves ?? SPLIT_CANVAS_DEFAULT_MAX_LEAVES;
    const persistedSnapshot = input.persistedSnapshot ?? null;
    if (!persistedSnapshot?.root) {
        return createStateFromSnapshot(createInitialSessionSplitCanvasSnapshot({
            sessionId: input.sessionId,
            maxLeaves,
        }));
    }

    const restoredState = createStateFromSnapshot(persistedSnapshot);
    const existingRouteLeafId = findSessionLeafIdBySessionId(restoredState, input.sessionId);
    if (existingRouteLeafId) {
        const persistedFocusedLeaf = findSessionLeafById(restoredState, restoredState.focusedLeafId);
        return {
            ...restoredState,
            focusedLeafId: persistedFocusedLeaf?.id ?? existingRouteLeafId,
        };
    }

    return materializeRouteAnchor(restoredState, input.sessionId);
}

export function reconcileSessionSplitCanvasRouteAnchor(
    state: SessionSplitCanvasState,
    routeSessionId: string,
    options?: Readonly<{
        previousRouteSessionId?: string | null;
    }>,
): SessionSplitCanvasState {
    const normalizedRouteSessionId = String(routeSessionId ?? '').trim();
    if (!normalizedRouteSessionId) {
        return state;
    }
    return materializeRouteAnchor(state, normalizedRouteSessionId, options);
}

export function runSessionSplitCanvasCommand(
    state: SessionSplitCanvasState,
    command: SessionSplitCanvasCommand,
): SessionSplitCanvasState {
    switch (command.type) {
        case 'focusSession':
            return focusExistingSessionLeaf(state, command.sessionId);
        case 'openSessionInSplit':
            return openSessionInSplit(state, command.sessionId, command.direction);
        default:
            return state;
    }
}

export function collectOpenSessionIds(state: SessionSplitCanvasState): string[] {
    return collectSplitCanvasLeaves(state.root).map((leaf) => leaf.payload.sessionId);
}

export function resolveSessionSplitCanvasRouteAnchorLeafId(
    state: SessionSplitCanvasState,
    routeSessionId: string,
): string | null {
    return findSessionLeafIdBySessionId(state, routeSessionId)
        ?? state.focusedLeafId
        ?? getFirstSplitCanvasLeafId(state.root);
}

export type SessionSplitCanvasKeyboardTargetSource =
    | 'focused'
    | 'lastInteracted'
    | 'route'
    | 'composer';

export type SessionSplitCanvasKeyboardTarget = Readonly<{
    leafId: string;
    sessionId: string;
    source: SessionSplitCanvasKeyboardTargetSource;
}>;

function isSessionSplitCanvasLeafVisible(
    state: SessionSplitCanvasState,
    leafId: string | null | undefined,
): boolean {
    const normalizedLeafId = String(leafId ?? '').trim();
    if (!normalizedLeafId) return false;
    return state.maximizedLeafId == null || state.maximizedLeafId === normalizedLeafId;
}

function resolveKeyboardTargetFromLeaf(
    state: SessionSplitCanvasState,
    leafId: string | null | undefined,
    source: SessionSplitCanvasKeyboardTargetSource,
): SessionSplitCanvasKeyboardTarget | null {
    if (!isSessionSplitCanvasLeafVisible(state, leafId)) {
        return null;
    }
    const leaf = findSessionLeafById(state, leafId);
    if (!leaf) {
        return null;
    }
    return {
        leafId: leaf.id,
        sessionId: leaf.payload.sessionId,
        source,
    };
}

export function resolveSessionSplitCanvasKeyboardTarget(
    state: SessionSplitCanvasState,
    options: Readonly<{
        routeSessionId: string;
        lastInteractedLeafId?: string | null;
        composerOwningLeafId?: string | null;
        targetKind: 'session' | 'composer';
    }>,
): SessionSplitCanvasKeyboardTarget | null {
    if (options.targetKind === 'composer') {
        return resolveKeyboardTargetFromLeaf(state, options.composerOwningLeafId, 'composer');
    }

    return resolveKeyboardTargetFromLeaf(state, state.focusedLeafId, 'focused')
        ?? resolveKeyboardTargetFromLeaf(state, options.lastInteractedLeafId, 'lastInteracted')
        ?? (
            options.routeSessionId.trim()
                ? resolveKeyboardTargetFromLeaf(
                    state,
                    resolveSessionSplitCanvasRouteAnchorLeafId(state, options.routeSessionId),
                    'route',
                )
                : null
        );
}

export function reduceSessionSplitCanvasState(
    state: SessionSplitCanvasState,
    action: SplitCanvasAction<SessionSplitCanvasLeafPayload>,
    options: Readonly<{
        routeSessionId: string;
    }>,
): SessionSplitCanvasState {
    if (action.type === 'closeLeaf') {
        const closingLeaf = collectSplitCanvasLeaves(state.root).find((leaf) => leaf.id === action.leafId) ?? null;
        if (!closingLeaf) {
            return state;
        }
        if (collectSplitCanvasLeaves(state.root).length <= 1) {
            return state;
        }
    }

    return splitCanvasReduce(state, action);
}

export function resolveSessionSplitCanvasRouteSessionAfterAction(
    state: SessionSplitCanvasState,
    action: SplitCanvasAction<SessionSplitCanvasLeafPayload>,
    options: Readonly<{
        routeSessionId: string;
    }>,
): string | null {
    if (action.type !== 'closeLeaf') {
        return null;
    }

    const closingLeaf = collectSplitCanvasLeaves(state.root).find((leaf) => leaf.id === action.leafId) ?? null;
    if (!closingLeaf || closingLeaf.payload.sessionId !== options.routeSessionId) {
        return null;
    }

    const nextState = reduceSessionSplitCanvasState(state, action, options);
    const nextRouteAnchorLeafId = resolveSessionSplitCanvasRouteAnchorLeafId(nextState, options.routeSessionId);
    const nextRouteAnchorLeaf = findSessionLeafById(nextState, nextRouteAnchorLeafId);
    return nextRouteAnchorLeaf?.payload.sessionId ?? null;
}

export function routeSessionOwnsLeaf(
    state: SessionSplitCanvasState,
    leaf: SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>,
    routeSessionId: string,
): boolean {
    return leaf.id === resolveSessionSplitCanvasRouteAnchorLeafId(state, routeSessionId);
}
