import { createFeatureDecision, type FeatureDecision, type FeatureId } from '@happier-dev/protocol';
import type { Settings } from '@/sync/domains/settings/settings';

import { storage } from '@/sync/domains/state/storage';
import {
    getServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
    resolveRuntimeFeatureDecisionFromSnapshot,
    type ServerFeaturesRuntimeSnapshot,
} from './featureDecisionRuntime';
import { getFeatureBuildPolicyDecision } from './featureBuildPolicy';
import { resolveLocalFeaturePolicyEnabled } from './featureLocalPolicy';
import { getUiFeatureDefinition } from './featureRegistry';

export type RuntimeFeatureDecisionInputs = Readonly<{
    featureId: FeatureId;
    settings: Settings;
    snapshot: ServerFeaturesRuntimeSnapshot;
}>;

export type ResolveRuntimeFeatureDecisionParams = Readonly<{
    featureId: FeatureId;
    settings?: Settings;
    serverId?: string;
    timeoutMs?: number;
    force?: boolean;
}>;

export async function loadRuntimeFeatureDecisionInputs(
    params: ResolveRuntimeFeatureDecisionParams,
): Promise<RuntimeFeatureDecisionInputs> {
    const settings = params.settings ?? storage.getState().settings;
    const definition = getUiFeatureDefinition(params.featureId);
    const buildPolicy = getFeatureBuildPolicyDecision(params.featureId);
    const localPolicyEnabled = resolveLocalFeaturePolicyEnabled(params.featureId, settings);
    const probesEnabled = definition.serverRequired && buildPolicy !== 'deny' && localPolicyEnabled;

    const snapshot: ServerFeaturesRuntimeSnapshot = probesEnabled
        ? await getServerFeaturesSnapshot({
            timeoutMs: params.timeoutMs,
            force: params.force,
            serverId: params.serverId,
        })
        : { status: 'loading' };

    return {
        featureId: params.featureId,
        settings,
        snapshot,
    };
}

export async function resolveRuntimeFeatureDecision(
    params: ResolveRuntimeFeatureDecisionParams,
): Promise<FeatureDecision> {
    const inputs = await loadRuntimeFeatureDecisionInputs(params);
    const decision = resolveRuntimeFeatureDecisionFromSnapshot(inputs);
    if (decision) {
        return decision;
    }

    return createFeatureDecision({
        featureId: inputs.featureId,
        state: 'unknown',
        blockedBy: 'server',
        blockerCode: 'probe_failed',
        diagnostics: [],
        evaluatedAt: Date.now(),
        scope: {
            scopeKind: 'runtime',
            ...(params.serverId ? { serverId: params.serverId } : {}),
        },
    });
}

export async function isRuntimeFeatureEnabled(
    params: ResolveRuntimeFeatureDecisionParams,
): Promise<boolean> {
    const decision = await resolveRuntimeFeatureDecision(params);
    return decision.state === 'enabled';
}
