import { featuresSchema, type FeaturesResponse } from '../types';
import {
    applyFeatureDependencies,
    evaluateFeatureBuildPolicy,
    FEATURE_IDS,
    FeatureGatesSchema,
    tryWriteServerEnabledBitInPlace,
} from '@happier-dev/protocol';

import type { ServerFeatureResolver } from './serverFeatureRegistry';
import { resolveServerFeatureBuildPolicy } from './serverFeatureBuildPolicy';
import { readPeerMediationFeatureEnv } from './readFeatureEnv';
import { applyBrowserCapabilityFeatureGateClosure } from '../browserFeature';

const DEFAULT_SETUP_SURFACE_POLICY_FEATURES: Record<string, unknown> = Object.freeze({
    setup: {
        relay: {
            allowRelaySelection: { enabled: true },
            allowHappierCloud: { enabled: true },
            allowCustomRelayUrl: { enabled: true },
            allowLocalRelayHost: { enabled: true },
            allowRemoteSshRelayHost: { enabled: true },
        },
        relayAccess: {
            allowTailscale: { enabled: true },
            allowCloudflareTunnel: { enabled: true },
        },
    },
    remoteHosts: {
        management: { enabled: true },
        secretMaterial: { enabled: false },
    },
});

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

export function resolveServerFeaturePayload(
    env: NodeJS.ProcessEnv,
    resolvers: readonly ServerFeatureResolver[],
): FeaturesResponse {
    if (resolvers.length === 0) {
        throw new Error('resolveServerFeaturePayload: resolvers list is empty');
    }

    const mergedFeatures: Record<string, unknown> = mergeDeep({}, DEFAULT_SETUP_SURFACE_POLICY_FEATURES);
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

    const peerMediationEnv = readPeerMediationFeatureEnv(env);
    if (peerMediationEnv.grantSigningKeys.length > 0) {
        Object.assign(mergedCapabilities, mergeDeep(mergedCapabilities, {
            machines: {
                peerMediation: {
                    grantSigningKeys: peerMediationEnv.grantSigningKeys,
                    directRouteGrantProofMintVersions: [2],
                    tcpTunnelRelayAuthorizationMintVersions: [2],
                },
            },
        }));
    }
    Object.assign(mergedCapabilities, mergeDeep(mergedCapabilities, { session: { messages: { role: true } } }));

    const parsedFeatureGates = FeatureGatesSchema.safeParse(mergedFeatures);
    if (!parsedFeatureGates.success) {
        throw new Error(`Invalid /v1/features feature gates: ${parsedFeatureGates.error.message}`);
    }

    const parsed = featuresSchema.safeParse({ features: mergedFeatures, capabilities: mergedCapabilities });
    if (!parsed.success) {
        throw new Error(`Invalid /v1/features payload: ${parsed.error.message}`);
    }

    const payload = parsed.data;

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
