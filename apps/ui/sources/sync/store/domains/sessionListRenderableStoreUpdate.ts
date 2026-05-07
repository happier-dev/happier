import {
    areSessionListRenderablesEqual,
    didSessionListRenderableStructuralFieldsChange,
    didSessionListRenderableWarmCacheFieldsChange,
    preserveSessionListRenderableStaleFields,
    preserveSessionListRenderableTransientState,
    type SessionListRenderableSession,
} from '../../domains/session/listing/sessionListRenderable';

export type SessionListRenderablePatch = Readonly<{
    sessionId: string;
    patch: Partial<SessionListRenderableSession>;
}>;

export type SessionListRenderableStoreUpdatePlan = Readonly<{
    nextRenderables: Record<string, SessionListRenderableSession>;
    noop: boolean;
    changedCount: number;
    removedCount: number;
    missingCount: number;
    noopPatchCount: number;
    listViewFieldChangeCount: number;
    staleMetadataPreservedCount: number;
    stalePendingFlagsPreservedCount: number;
    needsSessionListViewDataRebuild: boolean;
    didWarmCacheRelevantRenderableChange: boolean;
}>;

function didPreserveMetadata(
    previous: SessionListRenderableSession | undefined,
    incoming: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    return incoming.metadata == null
        && previous?.metadata != null
        && next.metadata === previous.metadata
        && next.metadataVersion === previous.metadataVersion;
}

function didPreservePendingFlags(
    previous: SessionListRenderableSession | undefined,
    incoming: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return false;
    return incoming.active === true
        && typeof incoming.hasPendingPermissionRequests !== 'boolean'
        && typeof incoming.hasPendingUserActionRequests !== 'boolean'
        && next.agentStateVersion === previous.agentStateVersion
        && (
            next.hasPendingPermissionRequests === previous.hasPendingPermissionRequests
            || next.hasPendingUserActionRequests === previous.hasPendingUserActionRequests
        );
}

export function planSessionListRenderableReplacement(input: Readonly<{
    previousRenderables: Record<string, SessionListRenderableSession>;
    incomingRenderables: ReadonlyArray<SessionListRenderableSession>;
    isSessionListViewDataUninitialized: boolean;
}>): SessionListRenderableStoreUpdatePlan {
    const previousRenderables = input.previousRenderables;
    const previousIds = Object.keys(previousRenderables);
    const incomingIds = new Set<string>();
    let nextRenderables = previousRenderables;
    let didAnyRenderableChange = previousIds.length !== input.incomingRenderables.length;
    let changedCount = 0;
    let removedCount = 0;
    let listViewFieldChangeCount = 0;
    let staleMetadataPreservedCount = 0;
    let stalePendingFlagsPreservedCount = 0;
    let needsSessionListViewDataRebuild = input.isSessionListViewDataUninitialized;
    let didWarmCacheRelevantRenderableChange = false;

    for (const incomingRenderable of input.incomingRenderables) {
        incomingIds.add(incomingRenderable.id);
        const previousRenderable = previousRenderables[incomingRenderable.id];
        const stalePreservedRenderable = preserveSessionListRenderableStaleFields(previousRenderable, incomingRenderable);
        const nextRenderableBase = preserveSessionListRenderableTransientState(
            previousRenderable,
            stalePreservedRenderable,
        );
        const nextRenderable = areSessionListRenderablesEqual(previousRenderable, nextRenderableBase)
            ? previousRenderable
            : nextRenderableBase;

        if (didPreserveMetadata(previousRenderable, incomingRenderable, nextRenderable)) {
            staleMetadataPreservedCount += 1;
        }
        if (didPreservePendingFlags(previousRenderable, incomingRenderable, nextRenderable)) {
            stalePendingFlagsPreservedCount += 1;
        }

        const didListViewFieldsChange = didSessionListRenderableStructuralFieldsChange(previousRenderable, nextRenderable);

        if (!previousRenderable || nextRenderable !== previousRenderable) {
            didAnyRenderableChange = true;
            changedCount += 1;
            if (didListViewFieldsChange) {
                listViewFieldChangeCount += 1;
            }
            if (didSessionListRenderableWarmCacheFieldsChange(previousRenderable, nextRenderable)) {
                didWarmCacheRelevantRenderableChange = true;
            }
            if (nextRenderables === previousRenderables) {
                nextRenderables = { ...previousRenderables };
            }
            nextRenderables[incomingRenderable.id] = nextRenderable;
        }

        if (!needsSessionListViewDataRebuild) {
            if (didListViewFieldsChange) {
                needsSessionListViewDataRebuild = true;
            }
        }
    }

    for (const sessionId of previousIds) {
        if (!incomingIds.has(sessionId)) {
            if (nextRenderables === previousRenderables) {
                nextRenderables = { ...previousRenderables };
            }
            delete nextRenderables[sessionId];
            removedCount += 1;
            didWarmCacheRelevantRenderableChange = true;
            needsSessionListViewDataRebuild = true;
        }
    }

    return {
        nextRenderables,
        noop: !didAnyRenderableChange && !needsSessionListViewDataRebuild,
        changedCount,
        removedCount,
        missingCount: 0,
        noopPatchCount: 0,
        listViewFieldChangeCount,
        staleMetadataPreservedCount,
        stalePendingFlagsPreservedCount,
        needsSessionListViewDataRebuild,
        didWarmCacheRelevantRenderableChange,
    };
}

export function planSessionListRenderablePatches(input: Readonly<{
    previousRenderables: Record<string, SessionListRenderableSession>;
    patches: ReadonlyArray<SessionListRenderablePatch>;
    isSessionListViewDataUninitialized: boolean;
}>): SessionListRenderableStoreUpdatePlan {
    const previousRenderables = input.previousRenderables;
    let nextRenderables = previousRenderables;
    let changedCount = 0;
    let missingCount = 0;
    let noopPatchCount = 0;
    let listViewFieldChangeCount = 0;
    let needsSessionListViewDataRebuild = input.isSessionListViewDataUninitialized;
    let didWarmCacheRelevantRenderableChange = false;

    for (const { sessionId, patch } of input.patches) {
        const previousRenderable = nextRenderables[sessionId];
        if (!previousRenderable) {
            missingCount += 1;
            continue;
        }

        const nextRenderable: SessionListRenderableSession = {
            ...previousRenderable,
            ...patch,
            id: previousRenderable.id,
        };

        if (areSessionListRenderablesEqual(previousRenderable, nextRenderable)) {
            noopPatchCount += 1;
            continue;
        }

        changedCount += 1;
        const didListViewFieldsChange = didSessionListRenderableStructuralFieldsChange(previousRenderable, nextRenderable);
        if (didListViewFieldsChange) {
            listViewFieldChangeCount += 1;
        }
        if (didSessionListRenderableWarmCacheFieldsChange(previousRenderable, nextRenderable)) {
            didWarmCacheRelevantRenderableChange = true;
        }

        if (!needsSessionListViewDataRebuild) {
            if (didListViewFieldsChange) {
                needsSessionListViewDataRebuild = true;
            }
        }

        if (nextRenderables === previousRenderables) {
            nextRenderables = { ...previousRenderables };
        }
        nextRenderables[sessionId] = nextRenderable;
    }

    return {
        nextRenderables,
        noop: nextRenderables === previousRenderables && !needsSessionListViewDataRebuild,
        changedCount,
        removedCount: 0,
        missingCount,
        noopPatchCount,
        listViewFieldChangeCount,
        staleMetadataPreservedCount: 0,
        stalePendingFlagsPreservedCount: 0,
        needsSessionListViewDataRebuild,
        didWarmCacheRelevantRenderableChange,
    };
}
