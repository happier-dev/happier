import { buildAgentUniverseBackendTargetKey, listExecutableAgentUniverseIds } from '@/agents/catalog/agentUniverse';

function buildBackendEnabledAnalyticsProperties(value: unknown): Record<string, boolean> {
    const record = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};
    return Object.fromEntries(listExecutableAgentUniverseIds().map((agentId) => {
        const targetKey = buildAgentUniverseBackendTargetKey(agentId);
        return [targetKey, record[targetKey] !== false];
    }));
}

function buildBackendCliSourcePreferenceAnalyticsProperties(value: unknown): Record<string, string> {
    const record = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};
    return Object.fromEntries(listExecutableAgentUniverseIds().map((agentId) => {
        const targetKey = buildAgentUniverseBackendTargetKey(agentId);
        const raw = record[targetKey];
        const normalized = raw === 'system-first' || raw === 'managed-first'
            ? raw
            : 'default';
        return [targetKey, normalized];
    }));
}

export const ACCOUNT_BACKEND_SETTING_ANALYTICS = {
    backendEnabledByTargetKey: buildBackendEnabledAnalyticsProperties,
    backendCliSourcePreferenceByTargetKey: buildBackendCliSourcePreferenceAnalyticsProperties,
};
