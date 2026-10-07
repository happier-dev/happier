import { createFeatureDecision, type FeatureDecision, type FeatureDecisionScope } from '@happier-dev/protocol/features/decision';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';

import { storage } from '@/sync/domains/state/storage';
import {
    getServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
    resolveRuntimeFeatureDecisionFromSnapshot,
    type ServerFeaturesRuntimeSnapshot,
} from '@/sync/domains/features/featureDecisionRuntime';
import { resolveFeatureDecisionSnapshotStrategy } from './featureDecisionProbeStrategy';
import type { FeatureLocalPolicySettings } from './featureLocalPolicy';

export type RuntimeFeatureDecisionInputs = Readonly<{
    featureId: FeatureId;
    settings: FeatureLocalPolicySettings;
    snapshot: ServerFeaturesRuntimeSnapshot;
    scope: FeatureDecisionScope;
}>;

export type RuntimeFeatureDecisionSpawnScope = Readonly<{
    scopeKind: 'spawn';
    serverId: string | null | undefined;
}>;

export type ResolveRuntimeFeatureDecisionParams = Readonly<{
    featureId: FeatureId;
    settings?: FeatureLocalPolicySettings;
    serverId?: string;
    scope?: RuntimeFeatureDecisionSpawnScope;
    timeoutMs?: number;
    force?: boolean;
}>;

export class RuntimeFeatureDecisionUnavailableError extends Error {
    readonly retryable = true;

    constructor(readonly decision: FeatureDecision) {
        super(`Runtime feature decision is temporarily unavailable for ${decision.featureId}`);
        this.name = 'RuntimeFeatureDecisionUnavailableError';
    }
}

function resolveRuntimeFeatureDecisionRequestContext(
    params: ResolveRuntimeFeatureDecisionParams,
): Readonly<{ scope: FeatureDecisionScope; serverId?: string }> {
    const rawServerId = params.scope ? params.scope.serverId : params.serverId;
    const serverId = typeof rawServerId === 'string' ? rawServerId.trim() : '';
    return {
        scope: params.scope
            ? { scopeKind: 'spawn', ...(serverId ? { serverId } : {}) }
            : { scopeKind: 'runtime' },
        ...(serverId ? { serverId } : {}),
    };
}

export async function loadRuntimeFeatureDecisionInputs(
    params: ResolveRuntimeFeatureDecisionParams,
): Promise<RuntimeFeatureDecisionInputs> {
    const settings = params.settings ?? storage.getState().settings;
    const requestContext = resolveRuntimeFeatureDecisionRequestContext(params);
    const snapshotStrategy = resolveFeatureDecisionSnapshotStrategy({
        featureId: params.featureId,
        settings,
        scopeKind: requestContext.scope.scopeKind,
        hasMainSelectionServerIds: false,
    });

    const snapshot: ServerFeaturesRuntimeSnapshot = snapshotStrategy.runtimeEnabled || snapshotStrategy.spawnEnabled
        ? await getServerFeaturesSnapshot({
            timeoutMs: params.timeoutMs,
            force: params.force,
            serverId: requestContext.serverId,
        })
        : { status: 'loading' };

    return {
        featureId: params.featureId,
        settings,
        snapshot,
        scope: requestContext.scope,
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
        scope: inputs.scope,
    });
}

export async function isRuntimeFeatureEnabled(
    params: ResolveRuntimeFeatureDecisionParams,
): Promise<boolean> {
    const decision = await resolveRuntimeFeatureDecision(params);
    return decision.state === 'enabled';
}

/**
 * State-loading paths must preserve a transient observation instead of
 * materializing it as a durable disabled/empty result. Unknown decisions use
 * the sync owner's existing retry and backoff lifecycle.
 */
export async function resolveRuntimeFeatureDecisionOrThrow(
    params: ResolveRuntimeFeatureDecisionParams,
): Promise<FeatureDecision> {
    const decision = await resolveRuntimeFeatureDecision(params);
    if (decision.state === 'unknown') {
        throw new RuntimeFeatureDecisionUnavailableError(decision);
    }
    return decision;
}
