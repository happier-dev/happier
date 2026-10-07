import { isSessionTurnTranscriptAnchorProjectionProtocolActive } from "@/app/session/turns/sessionTurnTranscriptAnchorProjectionProtocolContract";
import { featuresSchema, type FeaturesResponse } from '../types';
import {
    applyFeatureDependencies,
    evaluateFeatureBuildPolicy,
    evaluateServerFeatureDecisions,
    FEATURE_IDS,
    FEATURE_CATALOG,
    FeatureGatesSchema,
    isFeatureServerRepresented,
    tryWriteServerEnabledBitInPlace,
    type FeatureDecision,
    type FeatureId,
} from '@happier-dev/protocol';

import type { ServerFeatureResolver } from './serverFeatureRegistry';
import { resolveServerFeatureBuildPolicy } from './serverFeatureBuildPolicy';
import { applyBrowserCapabilityFeatureGateClosure } from '../browserFeature';
import { isSessionSystemRecordsProtocolV1Active } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';
import { resolveAuthPolicyFromEnv } from '@/app/auth/authPolicy';
import { resolveEffectiveHomeSignInServicePolicy } from '@/app/auth/methods/signInServicePolicy';
import { resolveSetupSurfacePolicyFeature } from '../setupSurfacePolicyFeature';

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
    const next: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        const existing = next[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            next[key] = mergeDeep(existing, value);
        } else {
            next[key] = value;
        }
    }
    return next as T;
}

/** The resolvers' merged, validated payload: every bit is the resolvers' own answer (no policy, no closure). */
function assembleServerFeaturePayload(
    env: NodeJS.ProcessEnv,
    resolvers: readonly ServerFeatureResolver[],
): FeaturesResponse {
    if (resolvers.length === 0) {
        throw new Error('resolveServerFeaturePayload: resolvers list is empty');
    }

    const setupSurfacePolicy = resolveSetupSurfacePolicyFeature();
    const mergedFeatures: Record<string, unknown> = mergeDeep(
        {},
        setupSurfacePolicy.features as Record<string, unknown>,
    );
    const mergedCapabilities: Record<string, unknown> = {};
    for (const resolver of resolvers) {
        const partial = resolver(env);
        if (partial.features && typeof partial.features === 'object') {
            Object.assign(mergedFeatures, mergeDeep(mergedFeatures, partial.features as Record<string, unknown>));
        }
        if (partial.capabilities && typeof partial.capabilities === 'object') {
            const patch = partial.capabilities as Record<string, unknown>;
            Object.assign(mergedCapabilities, mergeDeep(mergedCapabilities, patch));
        }
    }

    const authPolicy = resolveAuthPolicyFromEnv(env);
    const accountDirectory = isPlainObject(mergedCapabilities.accountDirectory)
        ? mergedCapabilities.accountDirectory
        : null;
    const accountDirectoryCapable = accountDirectory?.homeDirectory === true;
    // This assembler is synchronous and reads no database, so it publishes the
    // deployment recommendation without the persisted Home narrowing; the
    // `/v1/features` route replaces it with the effective Home value it resolves.
    const deploymentSignInService = authPolicy.signInService ?? null;
    const signInService = resolveEffectiveHomeSignInServicePolicy({
        envPolicy: deploymentSignInService,
        narrowing: null,
        accountDirectoryCapable,
    }) ?? undefined;
    const accountServicePresentation = accountDirectoryCapable
        ? authPolicy.accountServicePresentation ?? undefined
        : undefined;
    const homeDisplayName = env.HAPPIER_HOME_DISPLAY_NAME?.trim();

    // `turns` is advertised only while the transcript anchor projection is active: before that,
    // `SessionTurn` rows may still be v0 and their anchors cannot be trusted to describe turn
    // boundaries, so the route would have nothing sound to serve.
    Object.assign(mergedCapabilities, mergeDeep(mergedCapabilities, {
        session: {
            messages: {
                role: true,
                turns: isSessionTurnTranscriptAnchorProjectionProtocolActive(),
            },
        },
    }));
    if (isSessionSystemRecordsProtocolV1Active()) {
        Object.assign(mergedCapabilities, mergeDeep(mergedCapabilities, {
            session: { systemRecords: { protocolVersions: [1] } },
        }));
    }

    const parsedFeatureGates = FeatureGatesSchema.safeParse(mergedFeatures);
    if (!parsedFeatureGates.success) {
        throw new Error(`Invalid /v1/features feature gates: ${parsedFeatureGates.error.message}`);
    }

    const parsed = featuresSchema.safeParse({
        features: mergedFeatures,
        capabilities: mergedCapabilities,
        ...(signInService ? { signInService } : {}),
        ...(accountServicePresentation ? { accountServicePresentation } : {}),
        ...(homeDisplayName ? { homePresentation: { v: 1, displayName: homeDisplayName } } : {}),
    });
    if (!parsed.success) {
        throw new Error(`Invalid /v1/features payload: ${parsed.error.message}`);
    }

    const payload = parsed.data;
    if (deploymentSignInService?.mode === 'self' && !accountDirectoryCapable) {
        payload.capabilities.auth.misconfig.push({
            code: 'auth_sign_in_service_self_unavailable',
            message: 'Self sign-in service mode requires the Account Directory capability',
            kind: 'auth-sign-in-service-config',
            envVars: ['HAPPIER_AUTH_SIGN_IN_SERVICE_MODE'],
        });
    }

    return payload;
}

export function resolveServerFeaturePayload(
    env: NodeJS.ProcessEnv,
    resolvers: readonly ServerFeatureResolver[],
): FeaturesResponse {
    const payload = assembleServerFeaturePayload(env, resolvers);

    // 1) Enforce build-policy denies on represented server features (fail-closed).
    const buildPolicy = resolveServerFeatureBuildPolicy(env);
    for (const featureId of FEATURE_IDS) {
        if (evaluateFeatureBuildPolicy(buildPolicy, featureId) !== 'deny') continue;
        tryWriteServerEnabledBitInPlace(payload, featureId, false);
    }

    // Diagnostic-only capability annotations (never used as feature gates by clients).
    payload.capabilities.voice.disabledByBuildPolicy =
        evaluateFeatureBuildPolicy(buildPolicy, "voice.happierVoice") === "deny" ||
        evaluateFeatureBuildPolicy(buildPolicy, "voice") === "deny";

    // 2) Enforce dependencies between represented server features to a fixed point.
    applyFeatureDependencies({ serverPayload: payload });
    applyBrowserCapabilityFeatureGateClosure(payload);

    return payload;
}

/** A bit-only decision from the same producers and policy, without unrelated diagnostics. */
export function resolveServerFeatureGate(
    env: NodeJS.ProcessEnv,
    resolvers: readonly ServerFeatureResolver[],
    featureId: FeatureId,
): boolean {
    if (resolvers.length === 0) throw new Error('resolveServerFeaturePayload: resolvers list is empty');
    const required = new Set<FeatureId>();
    const include = (id: FeatureId): void => {
        if (required.has(id)) return;
        required.add(id);
        for (const dependencyId of FEATURE_CATALOG[id].dependencies) include(dependencyId);
    };
    include(featureId);
    const roots = new Set([...required].map(id => id.split('.')[0]));
    let mergedFeatures: Record<string, unknown> = {
        ...resolveSetupSurfacePolicyFeature().features,
    };
    for (const resolver of resolvers) {
        // Plain externally composed resolvers have no declared projection, so preserve them.
        if (resolver.featureRoots && !resolver.featureRoots.some(root => roots.has(root))) continue;
        const partial = resolver(env);
        if (partial.features) mergedFeatures = mergeDeep(mergedFeatures, partial.features as Record<string, unknown>);
    }
    const parsed = FeatureGatesSchema.safeParse(mergedFeatures);
    if (!parsed.success) throw new Error(`Invalid /v1/features feature gates: ${parsed.error.message}`);
    const projection: Pick<FeaturesResponse, 'features'> = { features: parsed.data };
    const buildPolicy = resolveServerFeatureBuildPolicy(env);
    const decisions = evaluateServerFeatureDecisions({
        serverPayload: projection,
        featureIds: [featureId],
        buildPolicy: id => evaluateFeatureBuildPolicy(buildPolicy, id),
    });
    return decisions.get(featureId)?.state === 'enabled';
}

/**
 * Why each server feature is on or off for this configuration (plan §3.8, invariant I9): the same
 * assembled payload, build policy and dependency engine as `resolveServerFeaturePayload`, answered
 * as typed decisions (`blockedBy`, `blockingDependencyId`) instead of closed bits. The Home console
 * reads these; it never reconstructs the closure.
 */
export function resolveServerFeatureDecisions(
    env: NodeJS.ProcessEnv,
    resolvers: readonly ServerFeatureResolver[],
): FeatureDecision[] {
    const payload = assembleServerFeaturePayload(env, resolvers);
    const buildPolicy = resolveServerFeatureBuildPolicy(env);
    const decisions = evaluateServerFeatureDecisions({
        serverPayload: payload,
        buildPolicy: (featureId) => evaluateFeatureBuildPolicy(buildPolicy, featureId),
    });
    return [...decisions.values()].filter((decision) => isFeatureServerRepresented(decision.featureId));
}
