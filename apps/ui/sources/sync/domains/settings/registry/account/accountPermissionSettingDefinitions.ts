import { buildAgentUniverseBackendTargetKey, listAgentUniverseIds } from '@/agents/catalog/agentUniverse';
import { PERMISSION_MODES } from '@/constants/PermissionModes';
import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function buildPermissionModeAnalyticsProperties(value: unknown): Record<string, string> {
    const record = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};
    return Object.fromEntries(listAgentUniverseIds().map((agentId) => {
        const targetKey = buildAgentUniverseBackendTargetKey(agentId);
        const raw = record[targetKey];
        const normalized = typeof raw === 'string' && (PERMISSION_MODES as readonly string[]).includes(raw)
            ? raw
            : 'default';
        return [targetKey, normalized];
    }));
}

export const ACCOUNT_PERMISSION_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    sessionDefaultPermissionModeByTargetKey: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: buildPermissionModeAnalyticsProperties,
    },
});
