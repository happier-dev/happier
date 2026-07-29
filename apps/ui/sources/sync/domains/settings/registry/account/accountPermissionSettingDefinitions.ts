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
import { PERMISSION_MODES } from '@/constants/PermissionModes';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';

const DEFAULT_SESSION_PERMISSION_MODE_BY_TARGET_KEY: Record<string, PermissionMode> = Object.fromEntries(
    listAgentUniverseIds().map((id) => [buildAgentUniverseBackendTargetKey(id), 'default']),
);

function buildPermissionModeAnalyticsProperties(value: unknown): Record<string, string> {
    const record = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};

    return Object.fromEntries(
        listAgentUniverseIds().map((agentId) => {
            const targetKey = buildAgentUniverseBackendTargetKey(agentId);
            const raw = record[targetKey];
            const normalized = typeof raw === 'string' && (PERMISSION_MODES as readonly string[]).includes(raw)
                ? raw
                : 'default';
            return [targetKey, normalized];
        }),
    );
}

export const ACCOUNT_PERMISSION_SETTING_DEFINITIONS = defineSettingDefinitions({
    sessionDefaultPermissionModeByTargetKey: {
        schema: z.record(BackendTargetKeyV2InputSchema, z.enum(PERMISSION_MODES)).default(DEFAULT_SESSION_PERMISSION_MODE_BY_TARGET_KEY),
        default: DEFAULT_SESSION_PERMISSION_MODE_BY_TARGET_KEY,
        description: 'Default permission mode per agent for new sessions',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'person',
            serializeCurrentProperties: buildPermissionModeAnalyticsProperties,
        },
    },
});

export const ACCOUNT_PERMISSION_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_PERMISSION_SETTING_DEFINITIONS);
