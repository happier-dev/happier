import * as React from 'react';
import type { FeatureDecision, FeatureId } from '@happier-dev/protocol';

import { useSettings } from '@/sync/domains/state/storage';
import {
    resolveMainSelectionFeatureDecision,
    resolveRuntimeFeatureDecisionFromSnapshot,
    useServerFeaturesMainSelectionSnapshot,
    useServerFeaturesRuntimeSnapshot,
    useServerFeaturesSnapshotForServerId,
} from '@/sync/domains/features/featureDecisionRuntime';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { getUiFeatureDefinition } from '@/sync/domains/features/featureRegistry';
import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import type { FeatureScopeParams } from './featureScope';

export type FeatureDecisionScopeParams = FeatureScopeParams;

export function useFeatureDecision(featureId: FeatureId, scope?: FeatureDecisionScopeParams): FeatureDecision | null {
    const settings = useSettings();
    const scopeKind = scope?.scopeKind ?? 'main_selection';

    const definition = getUiFeatureDefinition(featureId);
    const buildPolicy = getFeatureBuildPolicyDecision(featureId);
    const localPolicyEnabled = resolveLocalFeaturePolicyEnabled(featureId, settings);
    const probesEnabled = definition.serverRequired && buildPolicy !== 'deny' && localPolicyEnabled;
    const runtimeSnapshot = useServerFeaturesRuntimeSnapshot({ enabled: probesEnabled });

    if (scopeKind === 'runtime') {
        return React.useMemo(
            () =>
                resolveRuntimeFeatureDecisionFromSnapshot({
                    featureId,
                    settings,
                    snapshot: runtimeSnapshot,
                    scope: { scopeKind: 'runtime' },
                }),
            [featureId, settings, runtimeSnapshot],
        );
    }

    if (scope?.scopeKind === 'spawn') {
        const snapshot = useServerFeaturesSnapshotForServerId(scope.serverId, { enabled: probesEnabled });
        const serverId = typeof scope.serverId === 'string' ? scope.serverId.trim() : '';
        return React.useMemo(
            () =>
                resolveRuntimeFeatureDecisionFromSnapshot({
                    featureId,
                    settings,
                    snapshot,
                    scope: { scopeKind: 'spawn', ...(serverId ? { serverId } : {}) },
                }),
            [featureId, serverId, settings, snapshot],
        );
    }

    const selection = useEffectiveServerSelection();
    const snapshot = useServerFeaturesMainSelectionSnapshot(selection.serverIds, { enabled: probesEnabled });

    return React.useMemo(
        () => {
            if (selection.serverIds.length === 0) {
                // Web same-origin / empty server-profile bootstraps still need to resolve feature state.
                return resolveRuntimeFeatureDecisionFromSnapshot({
                    featureId,
                    settings,
                    snapshot: runtimeSnapshot,
                    scope: { scopeKind: 'main_selection' },
                });
            }

            return resolveMainSelectionFeatureDecision({
                featureId,
                settings,
                snapshot,
            });
        },
        [featureId, runtimeSnapshot, selection.serverIds.length, settings, snapshot],
    );
}
