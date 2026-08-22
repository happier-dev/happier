import type { BackendTargetRefV2Input } from '@happier-dev/protocol';
import type { PermissionMode } from './permissionTypes';
import type { AgentId } from '@/agents/catalog/catalog';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { normalizePermissionModeForAgentType } from './permissionModeOptions';

export type AccountPermissionDefaults = Readonly<{
    byTargetKey: Record<string, PermissionMode>;
}>;

function normalizeForAgentType(mode: PermissionMode, agentType: string): PermissionMode {
    return normalizePermissionModeForAgentType(mode, agentType);
}

export function readAccountPermissionDefaults(
    raw: unknown,
    enabledAgentIds: readonly AgentId[],
): AccountPermissionDefaults {
    const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const byTargetKey: Record<string, PermissionMode> = {};

    for (const [targetKey, value] of Object.entries(input)) {
        if (typeof value !== 'string') continue;
        const normalized = parsePermissionIntentAlias(value);
        if (!normalized) continue;
        byTargetKey[targetKey] = normalized as PermissionMode;
    }

    void enabledAgentIds;
    return { byTargetKey };
}

export function resolveNewSessionDefaultPermissionMode(params: Readonly<{
    agentType: string;
    backendTarget?: BackendTargetRefV2Input | null;
    accountDefaults: AccountPermissionDefaults;
    profileDefaultsByTargetKey?: Record<string, PermissionMode | undefined> | null;
    legacyProfileDefaultPermissionMode?: PermissionMode | null | undefined;
}>): PermissionMode {
    const { agentType, backendTarget, accountDefaults, profileDefaultsByTargetKey, legacyProfileDefaultPermissionMode } = params;
    const effectiveTarget = backendTarget ?? { kind: 'backend', backendId: agentType };
    const targetKey = resolveBackendTargetKeyV2(effectiveTarget);

    const directProfileMode = profileDefaultsByTargetKey?.[targetKey];
    if (directProfileMode) {
        return normalizeForAgentType(directProfileMode, agentType);
    }

    const directAccountMode = accountDefaults.byTargetKey[targetKey];
    if (directAccountMode) {
        return normalizeForAgentType(directAccountMode, agentType);
    }

    if (legacyProfileDefaultPermissionMode) {
        return normalizeForAgentType(legacyProfileDefaultPermissionMode, agentType);
    }

    return normalizeForAgentType('default', agentType);
}
