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
import { resolveFeatureDecisionSnapshotStrategy } from '@/sync/domains/features/featureDecisionProbeStrategy';
import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import type { FeatureScopeParams } from './featureScope';

export type FeatureDecisionScopeParams = FeatureScopeParams;

export function useFeatureDecision(featureId: FeatureId, scope?: FeatureDecisionScopeParams): FeatureDecision | null {
    const settings = useSettings();
    const scopeKind = scope?.scopeKind ?? 'main_selection';
    const selection = useEffectiveServerSelection();
    const snapshotStrategy = resolveFeatureDecisionSnapshotStrategy({
        featureId,
        settings,
        scopeKind,
        hasMainSelectionServerIds: selection.serverIds.length > 0,
    });
    const runtimeSnapshot = useServerFeaturesRuntimeSnapshot({ enabled: snapshotStrategy.runtimeEnabled });
    const spawnServerId = scope?.scopeKind === 'spawn'
        ? (typeof scope.serverId === 'string' ? scope.serverId.trim() : '')
        : '';
    const spawnSnapshot = useServerFeaturesSnapshotForServerId(spawnServerId, {
        enabled: snapshotStrategy.spawnEnabled,
    });
    const mainSelectionSnapshot = useServerFeaturesMainSelectionSnapshot(selection.serverIds, {
        enabled: snapshotStrategy.mainSelectionEnabled,
    });

    return React.useMemo(
        () => {
            if (scopeKind === 'runtime') {
                return resolveRuntimeFeatureDecisionFromSnapshot({
                    featureId,
                    settings,
                    snapshot: runtimeSnapshot,
                    scope: { scopeKind: 'runtime' },
                });
            }

            if (scopeKind === 'spawn') {
                return resolveRuntimeFeatureDecisionFromSnapshot({
                    featureId,
                    settings,
                    snapshot: spawnSnapshot,
                    scope: { scopeKind: 'spawn', ...(spawnServerId ? { serverId: spawnServerId } : {}) },
                });
            }

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
                snapshot: mainSelectionSnapshot,
            });
        },
        [featureId, mainSelectionSnapshot, runtimeSnapshot, scopeKind, selection.serverIds.length, settings, spawnServerId, spawnSnapshot],
    );
}
