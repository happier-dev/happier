import {
    BackendTargetKeyV2InputSchema,
    buildSettingArtifacts,
    defineSettingDefinitions,
} from '@happier-dev/protocol';
import { z } from 'zod';

import {
    buildAgentUniverseBackendTargetKey,
    listAgentUniverseIds,
} from '@/agents/catalog/agentUniverse';

const DEFAULT_BACKEND_ENABLED_BY_TARGET_KEY: Record<string, boolean> = Object.fromEntries(
    listAgentUniverseIds().map((id) => [buildAgentUniverseBackendTargetKey(id), true]),
);

const BACKEND_CLI_SOURCE_PREFERENCE_VALUES = ['system-first', 'managed-first'] as const;

function buildBackendEnabledAnalyticsProperties(
    value: unknown,
): Record<string, boolean> {
    const record = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};

    return Object.fromEntries(
        listAgentUniverseIds().map((agentId) => {
            const targetKey = buildAgentUniverseBackendTargetKey(agentId);
            return [targetKey, record[targetKey] !== false];
        }),
    );
}

function buildBackendCliSourcePreferenceAnalyticsProperties(
    value: unknown,
): Record<string, string> {
    const record = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};

    return Object.fromEntries(
        listAgentUniverseIds().map((agentId) => {
            const targetKey = buildAgentUniverseBackendTargetKey(agentId);
            const raw = record[targetKey];
            const normalized = raw === 'system-first' || raw === 'managed-first'
                ? raw
                : 'default';
            return [targetKey, normalized];
        }),
    );
}

export const BackendCliSourcePreferenceSchema = z.enum(BACKEND_CLI_SOURCE_PREFERENCE_VALUES);
export const BackendCliSourcePreferenceByTargetKeySchema = z.preprocess((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
            ([, value]) => value === 'system-first' || value === 'managed-first',
        ),
    );
}, z.record(BackendTargetKeyV2InputSchema, BackendCliSourcePreferenceSchema)).default({});

export const ACCOUNT_BACKEND_SETTING_DEFINITIONS = defineSettingDefinitions({
    backendEnabledByTargetKey: {
        schema: z.record(BackendTargetKeyV2InputSchema, z.boolean()).default(DEFAULT_BACKEND_ENABLED_BY_TARGET_KEY),
        default: DEFAULT_BACKEND_ENABLED_BY_TARGET_KEY,
        description: 'Per-backend enable/disable toggles',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'boolean',
            privacy: 'safe',
            identityScope: 'person',
            serializeCurrentProperties: buildBackendEnabledAnalyticsProperties,
        },
    },
    backendCliSourcePreferenceByTargetKey: {
        schema: BackendCliSourcePreferenceByTargetKeySchema,
        default: {},
        description: 'Per-backend CLI source preference (system-first or managed-first)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'person',
            serializeCurrentProperties: buildBackendCliSourcePreferenceAnalyticsProperties,
        },
    },
});

export const ACCOUNT_BACKEND_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_BACKEND_SETTING_DEFINITIONS);
