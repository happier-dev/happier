import { useMemo } from 'react';
import type { FeatureState } from '@happier-dev/protocol/features/decision';

import { resolveFeatureAvailabilityArm, type FeatureAvailabilityArm } from '@/hooks/server/resolveFeatureAvailabilityArm';

import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useFeatureLocalPolicySettings } from '@/hooks/server/useFeatureLocalPolicySettings';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    resolveRuntimeFeatureDecisionFromSnapshot,
    useServerFeaturesRuntimeSnapshot,
    useServerFeaturesSnapshotForServerId,
} from '@/sync/domains/features/featureDecisionRuntime';

function normalizeServerId(value: string | null | undefined): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

function featureScope(serverId: string | null) {
    return serverId ? { scopeKind: 'spawn' as const, serverId } : { scopeKind: 'runtime' as const };
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

const LOADING_SNAPSHOT = Object.freeze({ status: 'loading' as const });

/**
 * The server's own account of which local-service preview prerequisite is unmet.
 *
 * `apps/server/sources/app/features/localServicesFeature.ts:52-110` computes one code per failed
 * prerequisite. Without a reader the client can only say "previews are disabled", and an operator
 * cannot tell which of eleven environment variables is wrong.
 *
 * One surface-level observation supplies both the canonical feature decision and its reasons.
 * Retained hidden Services panes keep their state, but do not own feature loads or retries. The
 * existing exact-Home cache supplies last-known facts immediately on reopen while the presented
 * observation revalidates them. Read that cache at render time: an observer can still hold its
 * previous Home's snapshot before the Home-change effect runs.
 *
 * Reasons are empty while server features are loading or unreachable, so callers keep whatever
 * generic copy they already show rather than naming a prerequisite the server has not reported.
 */
export function useLocalServicePresentationFeatures(
    serverId: string | null | undefined,
    options?: Readonly<{ enabled?: boolean }>,
): Readonly<{
    /**
     * Whether this Home offers Local services at all (the `localServices` decision, classified by the
     * canonical arm owner). Only `available` lets a surface scan or watch; every other arm is drawn as
     * the turned-off, unsupported or unknown state instead of an empty list.
     */
    localServicesArm: FeatureAvailabilityArm;
    publicPreviewFeatureEnabled: boolean;
    /** The decided state, or null while this Home's features are not yet known. */
    publicPreviewFeatureState: FeatureState | null;
    publicPreviewCapabilityDisabledReasons: LocalServiceCapabilityDisabledReasons;
}> {
    const normalizedServerId = normalizeServerId(serverId);
    const presented = useLayoutPresentationActive();
    const enabled = presented && (options?.enabled ?? true);
    const settings = useFeatureLocalPolicySettings();
    useServerFeaturesSnapshotForServerId(normalizedServerId, {
        enabled: enabled && Boolean(normalizedServerId),
    });
    useServerFeaturesRuntimeSnapshot({ enabled: enabled && !normalizedServerId });
    const cachedSnapshot = getCachedServerFeaturesSnapshot(normalizedServerId
        ? { serverId: normalizedServerId }
        : undefined) ?? LOADING_SNAPSHOT;
    const snapshot = enabled ? cachedSnapshot : LOADING_SNAPSHOT;
    // A hidden retained pane keeps the last-known availability from the cache (no load of its own), so it
    // never swaps its list for a loading state while hidden and loses its scroll and open row.
    const localServicesArm = useMemo(() => resolveFeatureAvailabilityArm(resolveRuntimeFeatureDecisionFromSnapshot({
        featureId: 'localServices', settings, snapshot: cachedSnapshot, scope: featureScope(normalizedServerId),
    })), [cachedSnapshot, normalizedServerId, settings]);

    return useMemo(() => {
        if (!enabled) return {
            localServicesArm,
            publicPreviewFeatureEnabled: false,
            publicPreviewFeatureState: null,
            publicPreviewCapabilityDisabledReasons: NO_DISABLED_REASONS,
        };
        const decision = resolveRuntimeFeatureDecisionFromSnapshot({
            featureId: 'localServices.publicPreview',
            settings,
            snapshot,
            scope: featureScope(normalizedServerId),
        });
        const localServices = snapshot.status === 'ready' ? snapshot.features.capabilities.localServices : null;
        return {
            localServicesArm,
            publicPreviewFeatureEnabled: decision?.state === 'enabled',
            publicPreviewFeatureState: decision?.state ?? null,
            publicPreviewCapabilityDisabledReasons: localServices ? {
                preview: localServices.preview.disabledReasons,
                publicPreview: localServices.publicPreview.disabledReasons,
            } : NO_DISABLED_REASONS,
        };
    }, [enabled, localServicesArm, normalizedServerId, settings, snapshot]);
}
