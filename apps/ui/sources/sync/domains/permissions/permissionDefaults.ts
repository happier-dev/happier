import type { PermissionMode } from './permissionTypes';
import { normalizePermissionModeForGroup } from './permissionTypes';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

export type AccountPermissionDefaults = Readonly<Partial<Record<AgentId, PermissionMode>>>;

function normalizeForAgentType(mode: PermissionMode, agentType: AgentId): PermissionMode {
    const group = getAgentCore(agentType).permissions.modeGroup;
    const normalized = (parsePermissionIntentAlias(mode) ?? 'default') as PermissionMode;
    return normalizePermissionModeForGroup(normalized, group);
}

export function readAccountPermissionDefaults(
    raw: unknown,
    enabledAgentIds: readonly AgentId[],
): AccountPermissionDefaults {
    const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const out: Partial<Record<AgentId, PermissionMode>> = {};
    for (const agentId of enabledAgentIds) {
        const v = input[agentId];
        out[agentId] = typeof v === 'string' ? normalizeForAgentType(v as PermissionMode, agentId) : 'default';
    }
    return out;
}

export function resolveNewSessionDefaultPermissionMode(params: Readonly<{
    agentType: AgentId;
    accountDefaults: AccountPermissionDefaults;
    profileDefaults?: Partial<Record<AgentId, PermissionMode | undefined>> | null;
    legacyProfileDefaultPermissionMode?: PermissionMode | null | undefined;
}>): PermissionMode {
    const { agentType, accountDefaults, profileDefaults, legacyProfileDefaultPermissionMode } = params;

    const directProfileMode = profileDefaults?.[agentType];
    if (directProfileMode) {
        return normalizeForAgentType(directProfileMode, agentType);
    }

    if (legacyProfileDefaultPermissionMode) {
        return normalizeForAgentType(legacyProfileDefaultPermissionMode, agentType);
    }

    const raw = accountDefaults[agentType] ?? 'default';
    return normalizeForAgentType(raw, agentType);
}
