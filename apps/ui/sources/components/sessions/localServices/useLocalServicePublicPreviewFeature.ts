import { useMemo } from 'react';

import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import {
    useServerFeaturesRuntimeSnapshot,
    useServerFeaturesSnapshotForServerId,
} from '@/sync/domains/features/featureDecisionRuntime';

function normalizeServerId(value: string | null | undefined): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

export function useLocalServicePublicPreviewFeatureEnabled(
    serverId: string | null | undefined,
): boolean {
    const normalizedServerId = normalizeServerId(serverId);
    const decision = useFeatureDecision(
        'localServices.publicPreview',
        normalizedServerId
            ? { scopeKind: 'spawn', serverId: normalizedServerId }
            : { scopeKind: 'runtime' },
    );

    return decision?.state === 'enabled';
}

export type LocalServiceCapabilityDisabledReasons = Readonly<{
    /** `capabilities.localServices.preview.disabledReasons` */
    preview: readonly string[];
    /** `capabilities.localServices.publicPreview.disabledReasons` */
    publicPreview: readonly string[];
}>;

const NO_DISABLED_REASONS: LocalServiceCapabilityDisabledReasons = {
    preview: [],
    publicPreview: [],
};

/**
 * The server's own account of which local-service preview prerequisite is unmet.
 *
 * `apps/server/sources/app/features/localServicesFeature.ts:52-110` computes one code per failed
 * prerequisite. Without a reader the client can only say "previews are disabled", and an operator
 * cannot tell which of eleven environment variables is wrong.
 *
 * This lives beside `useLocalServicePublicPreviewFeatureEnabled` and resolves the snapshot the same
 * way — by `serverId` when the surface is bound to one, otherwise the active runtime server — so the
 * gate and the reason for it can never come from two different servers. **Call it only from the
 * surface owner** (`LocalServicesSurfaceHost`), which already mounts this machinery for the feature
 * decision above, and pass the result down: it subscribes and can trigger a features load, which a
 * per-row leaf must not do.
 *
 * Reasons are empty while server features are loading or unreachable, so callers keep whatever
 * generic copy they already show rather than naming a prerequisite the server has not reported.
 */
export function useLocalServiceCapabilityDisabledReasons(
    serverId: string | null | undefined,
): LocalServiceCapabilityDisabledReasons {
    const normalizedServerId = normalizeServerId(serverId);
    const spawnSnapshot = useServerFeaturesSnapshotForServerId(normalizedServerId, {
        enabled: Boolean(normalizedServerId),
    });
    const runtimeSnapshot = useServerFeaturesRuntimeSnapshot({ enabled: !normalizedServerId });
    const snapshot = normalizedServerId ? spawnSnapshot : runtimeSnapshot;

    return useMemo(() => {
        if (snapshot.status !== 'ready') return NO_DISABLED_REASONS;
        const localServices = snapshot.features.capabilities.localServices;
        return {
            preview: localServices.preview.disabledReasons,
            publicPreview: localServices.publicPreview.disabledReasons,
        };
    }, [snapshot]);
}
