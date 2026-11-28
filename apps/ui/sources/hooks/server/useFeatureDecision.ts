import * as React from 'react';
import type { FeatureDecision} from '@happier-dev/protocol/features/decision';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';

import {
    resolveMainSelectionFeatureDecision,
    resolveRuntimeFeatureDecisionFromSnapshot,
    useServerFeaturesMainSelectionSnapshot,
    useServerFeaturesRuntimeSnapshot,
    useServerFeaturesSnapshotForServerId,
} from '@/sync/domains/features/featureDecisionRuntime';
import { resolveFeatureDecisionSnapshotStrategy } from '@/sync/domains/features/featureDecisionProbeStrategy';
import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import type { FeatureScopeParams } from './featureScope';
import { useFeatureLocalPolicySettings } from './useFeatureLocalPolicySettings';

export type FeatureDecisionScopeParams = FeatureScopeParams;

export function useFeatureDecision(featureId: FeatureId, scope?: FeatureDecisionScopeParams): FeatureDecision | null {
    const ids = React.useMemo(() => [featureId], [featureId]);
    return useFeatureDecisions(ids, scope)[featureId] ?? null;
}

export function useFeatureDecisions(
    featureIds: readonly FeatureId[],
    scope?: FeatureDecisionScopeParams,
): Readonly<Partial<Record<FeatureId, FeatureDecision | null>>> {
    const settings = useFeatureLocalPolicySettings();
    const scopeKind = scope?.scopeKind ?? 'main_selection';
    const selection = useEffectiveServerSelection();
    const hasMainSelectionServerIds = selection.serverIds.length > 0;
    const strategies = featureIds.map(featureId => resolveFeatureDecisionSnapshotStrategy({
        featureId, settings, scopeKind, hasMainSelectionServerIds,
    }));
    const runtimeSnapshot = useServerFeaturesRuntimeSnapshot({ enabled: strategies.some(strategy => strategy.runtimeEnabled) });
    const spawnServerId =
        scope && scope.scopeKind === 'spawn' && typeof scope.serverId === 'string'
            ? scope.serverId.trim()
            : '';
    const spawnSnapshot = useServerFeaturesSnapshotForServerId(spawnServerId, {
        enabled: strategies.some(strategy => strategy.spawnEnabled),
    });
    const mainSelectionSnapshot = useServerFeaturesMainSelectionSnapshot(selection.serverIds, {
        enabled: strategies.some(strategy => strategy.mainSelectionEnabled),
    });

    return React.useMemo(() => Object.fromEntries(featureIds.map((featureId): readonly [FeatureId, FeatureDecision | null] => {
        if (scopeKind === 'main_selection' && hasMainSelectionServerIds) {
            return [featureId, resolveMainSelectionFeatureDecision({ featureId, settings, snapshot: mainSelectionSnapshot })];
        }
        const snapshot = scopeKind === 'spawn' ? spawnSnapshot : runtimeSnapshot;
        const decisionScope = scopeKind === 'spawn'
            ? { scopeKind, ...(spawnServerId ? { serverId: spawnServerId } : {}) }
            : { scopeKind };
        return [featureId, resolveRuntimeFeatureDecisionFromSnapshot({ featureId, settings, snapshot, scope: decisionScope })];
    })), [featureIds, hasMainSelectionServerIds, mainSelectionSnapshot, runtimeSnapshot, scopeKind, settings, spawnServerId, spawnSnapshot]);
}
