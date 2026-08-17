import { buildAgentUniverseBackendTargetKey, listAgentUniverseIds } from '@/agents/catalog/agentUniverse';
import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function buildBackendEnabledAnalyticsProperties(value: unknown): Record<string, boolean> {
    const record = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};
    return Object.fromEntries(listAgentUniverseIds().map((agentId) => {
        const targetKey = buildAgentUniverseBackendTargetKey(agentId);
        return [targetKey, record[targetKey] !== false];
    }));
}

function buildBackendCliSourcePreferenceAnalyticsProperties(value: unknown): Record<string, string> {
    const record = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};
    return Object.fromEntries(listAgentUniverseIds().map((agentId) => {
        const targetKey = buildAgentUniverseBackendTargetKey(agentId);
        const raw = record[targetKey];
        const normalized = raw === 'system-first' || raw === 'managed-first'
            ? raw
            : 'default';
        return [targetKey, normalized];
    }));
}

export const ACCOUNT_BACKEND_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    backendEnabledByTargetKey: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'boolean',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: buildBackendEnabledAnalyticsProperties,
    },
    backendCliSourcePreferenceByTargetKey: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: buildBackendCliSourcePreferenceAnalyticsProperties,
    },
});
