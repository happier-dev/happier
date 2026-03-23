import { featuresSchema, type FeaturesResponse } from '../types';
import {
    evaluateFeatureBuildPolicy,
    FEATURE_CATALOG,
    FEATURE_IDS,
    readServerEnabledBit,
    tryWriteServerEnabledBitInPlace,
} from '@happier-dev/protocol';

import type { ServerFeatureResolver } from './serverFeatureRegistry';
import { resolveServerFeatureBuildPolicy } from './serverFeatureBuildPolicy';

const DEPENDENCIES_BY_ID = new Map(FEATURE_IDS.map((featureId) => [featureId, FEATURE_CATALOG[featureId].dependencies] as const));

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

    const mergedFeatures: Record<string, unknown> = {};
    const mergedCapabilities: Record<string, unknown> = {};
    for (const resolver of resolvers) {
        const partial = resolver(env);
        if (partial.features && typeof partial.features === 'object') {
            Object.assign(mergedFeatures, partial.features as Record<string, unknown>);
        }
        if (partial.capabilities && typeof partial.capabilities === 'object') {
            const patch = partial.capabilities as Record<string, unknown>;
            Object.assign(mergedCapabilities, mergeDeep(mergedCapabilities, patch));
        }
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

    // 2) Enforce dependencies between represented server features.
    for (const featureId of FEATURE_IDS) {
        const enabled = readServerEnabledBit(payload, featureId);
        if (enabled !== true) continue;

        const dependencies = DEPENDENCIES_BY_ID.get(featureId) ?? [];
        for (const depId of dependencies) {
            const depEnabled = readServerEnabledBit(payload, depId);
            if (depEnabled !== false) continue;

            tryWriteServerEnabledBitInPlace(payload, featureId, false);
            break;
        }
    }

    return payload;
}
