import type { BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { PermissionMode } from './permissionTypes';
import type { AgentId } from '@/agents/catalog/catalog';
import { parsePermissionIntentAlias, type AgentSessionModeDescriptor } from '@happier-dev/agents';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { normalizePermissionModeForAgentType } from './permissionModeOptions';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { resolveManagedSessionDefaults, type ManagedSessionDefaultsContext } from '@happier-dev/protocol/teams/managedDefaults';
import type { OrganizationPolicyLock } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';

export type AccountPermissionDefaults = Readonly<{
    byTargetKey: Record<string, PermissionMode>;
}>;

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

type NewSessionPermissionModeInput = Readonly<{
    agentType: string;
    sessionModeDescriptor?: AgentSessionModeDescriptor | null;
    backendTarget?: BackendTargetRefV2Input | null;
    accountDefaults: AccountPermissionDefaults;
    profileDefaultsByTargetKey?: Record<string, PermissionMode | undefined> | null;
    legacyProfileDefaultPermissionMode?: PermissionMode | null | undefined;
    explicitPermissionMode?: PermissionMode;
    managedDefaults?: ManagedSessionDefaultsContext;
}>;

export function resolveNewSessionDefaultPermissionModeDecision(params: NewSessionPermissionModeInput): Readonly<{
    permissionMode: PermissionMode;
    lock: OrganizationPolicyLock | null;
}> {
    const { agentType, backendTarget, accountDefaults, profileDefaultsByTargetKey, legacyProfileDefaultPermissionMode } = params;
    const effectiveTarget = backendTarget ?? { kind: 'backend', backendId: agentType };
    const targetKey = resolveBackendTargetKeyV2(effectiveTarget);

    const explicitMode = params.explicitPermissionMode
        ?? profileDefaultsByTargetKey?.[targetKey]
        ?? accountDefaults.byTargetKey[targetKey]
        ?? legacyProfileDefaultPermissionMode;
    const explicitIntent = explicitMode ? parseAgentPermissionIntentV1Alias(explicitMode) : null;
    const decision = resolveManagedSessionDefaults({
        ...params.managedDefaults,
        agentTargetKey: targetKey,
        ...(explicitIntent ? { explicitChoices: { permissionModeByAgentTargetKey: { [targetKey]: explicitIntent } } } : {}),
    }).permissionMode;
    return {
        permissionMode: normalizePermissionModeForAgentType(decision.value ?? 'default', agentType, params.sessionModeDescriptor),
        lock: decision.lock,
    };
}

export function resolveNewSessionDefaultPermissionMode(params: NewSessionPermissionModeInput): PermissionMode {
    return resolveNewSessionDefaultPermissionModeDecision(params).permissionMode;
}
