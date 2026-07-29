import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import {
    didSessionListRenderableProjectGroupingFieldsChange,
    didSessionListRenderableReachabilityPeerFieldsChange,
    didSessionListRenderableWarmCacheFieldsChange,
    isSessionListRenderableWarmCacheProgressOnlyChange,
} from '../../domains/session/listing/sessionListRenderable';
import {
    shouldRebuildSessionListIndexForRenderableChange,
    type SessionListIndexRebuildSettings,
} from '../../domains/session/listing/sessionListIndexRebuildImpact';

export type SessionListRenderableChangeImpact = Readonly<{
    didWarmCacheRelevantRenderableChange: boolean;
    isWarmCacheProgressOnlyChange: boolean;
    needsSessionListIndexRebuild: boolean;
    needsProjectManagerUpdate: boolean;
    needsReachablePeerReevaluation: boolean;
}>;

export function resolveSessionListRenderableChangeImpact(
    previousRenderable: SessionListRenderableSession | undefined,
    nextRenderable: SessionListRenderableSession,
    options?: Readonly<{
        sessionListIndexSettings?: SessionListIndexRebuildSettings | null;
        nowMs?: number;
    }>,
): SessionListRenderableChangeImpact {
    const didWarmCacheRelevantRenderableChange = didSessionListRenderableWarmCacheFieldsChange(
        previousRenderable,
        nextRenderable,
    );
    return {
        didWarmCacheRelevantRenderableChange,
        isWarmCacheProgressOnlyChange: didWarmCacheRelevantRenderableChange
            && (
                isSessionListRenderableWarmCacheProgressOnlyChange(previousRenderable, nextRenderable)
            ),
        needsSessionListIndexRebuild: shouldRebuildSessionListIndexForRenderableChange(
            previousRenderable,
            nextRenderable,
            options?.sessionListIndexSettings,
        ),
        needsProjectManagerUpdate: didSessionListRenderableProjectGroupingFieldsChange(previousRenderable, nextRenderable),
        needsReachablePeerReevaluation: didSessionListRenderableReachabilityPeerFieldsChange(previousRenderable, nextRenderable),
    };
}
