import { buildAgentUniverseBackendTargetKey, listExecutableAgentUniverseIds } from '@/agents/catalog/agentUniverse';
import { PERMISSION_MODES } from '@/constants/PermissionModes';

function buildPermissionModeAnalyticsProperties(value: unknown): Record<string, string> {
    const record = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};
    return Object.fromEntries(listExecutableAgentUniverseIds().map((agentId) => {
        const targetKey = buildAgentUniverseBackendTargetKey(agentId);
        const raw = record[targetKey];
        const normalized = typeof raw === 'string' && (PERMISSION_MODES as readonly string[]).includes(raw)
            ? raw
            : 'default';
        return [targetKey, normalized];
    }));
}

export const ACCOUNT_PERMISSION_SETTING_ANALYTICS = {
    sessionDefaultPermissionModeByTargetKey: buildPermissionModeAnalyticsProperties,
};
