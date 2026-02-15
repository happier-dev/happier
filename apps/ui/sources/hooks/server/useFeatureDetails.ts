import * as React from 'react';
import type { FeatureId, FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

import { useSettings } from '@/sync/domains/state/storage';
import {
    useServerFeaturesMainSelectionSnapshot,
    useServerFeaturesRuntimeSnapshot,
    useServerFeaturesSnapshotForServerId,
} from '@/sync/domains/features/featureDecisionRuntime';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { getUiFeatureDefinition } from '@/sync/domains/features/featureRegistry';
import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import type { FeatureScopeParams } from './featureScope';

export type FeatureDetailsScopeParams = FeatureScopeParams;

type FeatureDetailsParams<T> = Readonly<{
    featureId: FeatureId;
    fallback: T;
    select: (features: ServerFeatures) => T;
    scope?: FeatureDetailsScopeParams;
    aggregate?: (values: ReadonlyArray<T>) => T;
}>;

export function useFeatureDetails<T>(params: FeatureDetailsParams<T>): T {
    const settings = useSettings();
    const selection = useEffectiveServerSelection();
    const scopeKind = params.scope?.scopeKind ?? 'main_selection';
    const definition = getUiFeatureDefinition(params.featureId);
    const buildPolicy = getFeatureBuildPolicyDecision(params.featureId);
    const localPolicyEnabled = resolveLocalFeaturePolicyEnabled(params.featureId, settings);
    const probesEnabled = definition.serverRequired && buildPolicy !== 'deny' && localPolicyEnabled;

    const runtimeSnapshot = useServerFeaturesRuntimeSnapshot({
        enabled: probesEnabled && (scopeKind === 'runtime' || (scopeKind === 'main_selection' && selection.serverIds.length === 0)),
    });

    const spawnServerId = params.scope && params.scope.scopeKind === 'spawn'
        ? params.scope.serverId
        : null;
    const spawnSnapshot = useServerFeaturesSnapshotForServerId(
        spawnServerId,
        { enabled: probesEnabled && scopeKind === 'spawn' },
    );

    const mainSelectionSnapshot = useServerFeaturesMainSelectionSnapshot(
        selection.serverIds,
        { enabled: probesEnabled && scopeKind === 'main_selection' && selection.serverIds.length > 0 },
    );

    return React.useMemo(() => {
        if (scopeKind === 'spawn') {
            if (spawnSnapshot.status !== 'ready') return params.fallback;
            return params.select(spawnSnapshot.features);
        }

        if (scopeKind === 'runtime' || (scopeKind === 'main_selection' && selection.serverIds.length === 0)) {
            if (runtimeSnapshot.status !== 'ready') return params.fallback;
            return params.select(runtimeSnapshot.features);
        }

        if (mainSelectionSnapshot.status !== 'ready') return params.fallback;

        const values: T[] = [];
        for (const serverId of mainSelectionSnapshot.serverIds) {
            const snap = mainSelectionSnapshot.snapshotsByServerId[serverId];
            if (!snap || snap.status !== 'ready') return params.fallback;
            values.push(params.select(snap.features));
        }

        if (values.length === 0) return params.fallback;
        if (params.aggregate) return params.aggregate(values);

        const first = values[0] as T;
        for (let i = 1; i < values.length; i += 1) {
            if (!Object.is(first, values[i])) return params.fallback;
        }
        return first;
    }, [
        mainSelectionSnapshot,
        params,
        runtimeSnapshot,
        scopeKind,
        selection.serverIds.length,
        spawnSnapshot,
    ]);
}
