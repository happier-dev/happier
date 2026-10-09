import type { FeatureId } from '@happier-dev/protocol';

import { featureRequiresServerSnapshot } from '@happier-dev/protocol/features/catalog';

import { getFeatureBuildPolicyDecision } from './featureBuildPolicy';
import { resolveLocalFeaturePolicyEnabled, type FeatureLocalPolicySettings } from './featureLocalPolicy';

export type FeatureDecisionSnapshotScopeKind = 'runtime' | 'spawn' | 'main_selection';

export type FeatureDecisionSnapshotStrategy = Readonly<{
    probesEnabled: boolean;
    runtimeEnabled: boolean;
    spawnEnabled: boolean;
    mainSelectionEnabled: boolean;
}>;

export function resolveFeatureDecisionProbesEnabled(featureId: FeatureId, settings: FeatureLocalPolicySettings,
    snapshotDemand: 'decision' | 'details' = 'decision'): boolean {
    const buildPolicy = getFeatureBuildPolicyDecision(featureId);
    const localPolicyEnabled = resolveLocalFeaturePolicyEnabled(featureId, settings);
    // Client-only admission needs no Home, but selecting its Home diagnostics does.
    const requiresSnapshot = snapshotDemand === 'details' || featureRequiresServerSnapshot(featureId);
    return requiresSnapshot && buildPolicy !== 'deny' && localPolicyEnabled;
}

export function resolveFeatureDecisionSnapshotStrategy(params: Readonly<{
    featureId: FeatureId;
    settings: FeatureLocalPolicySettings;
    scopeKind: FeatureDecisionSnapshotScopeKind;
    hasMainSelectionServerIds: boolean;
    snapshotDemand?: 'decision' | 'details';
}>): FeatureDecisionSnapshotStrategy {
    const probesEnabled = resolveFeatureDecisionProbesEnabled(params.featureId, params.settings, params.snapshotDemand);
    return {
        probesEnabled,
        runtimeEnabled: probesEnabled && (params.scopeKind === 'runtime' || (params.scopeKind === 'main_selection' && !params.hasMainSelectionServerIds)),
        spawnEnabled: probesEnabled && params.scopeKind === 'spawn',
        mainSelectionEnabled: probesEnabled && params.scopeKind === 'main_selection' && params.hasMainSelectionServerIds,
    };
}
