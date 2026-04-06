import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import {
    didSessionListRenderableProjectGroupingFieldsChange,
    didSessionListRenderableReachabilityPeerFieldsChange,
    didSessionListRenderableStructuralFieldsChange,
    didSessionListRenderableWarmCacheFieldsChange,
} from '../../domains/session/listing/sessionListRenderable';

export type SessionListRenderableChangeImpact = Readonly<{
    didWarmCacheRelevantRenderableChange: boolean;
    needsSessionListViewDataRebuild: boolean;
    needsProjectManagerUpdate: boolean;
    needsReachablePeerReevaluation: boolean;
}>;

export function resolveSessionListRenderableChangeImpact(
    previousRenderable: SessionListRenderableSession | undefined,
    nextRenderable: SessionListRenderableSession,
): SessionListRenderableChangeImpact {
    return {
        didWarmCacheRelevantRenderableChange: didSessionListRenderableWarmCacheFieldsChange(previousRenderable, nextRenderable),
        needsSessionListViewDataRebuild: didSessionListRenderableStructuralFieldsChange(previousRenderable, nextRenderable),
        needsProjectManagerUpdate: didSessionListRenderableProjectGroupingFieldsChange(previousRenderable, nextRenderable),
        needsReachablePeerReevaluation: didSessionListRenderableReachabilityPeerFieldsChange(previousRenderable, nextRenderable),
    };
}
