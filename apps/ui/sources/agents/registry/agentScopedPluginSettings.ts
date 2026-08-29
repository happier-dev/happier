import {
    loadDaemonMergedProjectionInputs,
} from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { AgentPluginSettingsSnapshot } from '@/agents/registry/agentUiSettingLookup';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import {
    projectScopedPluginSettingsFields,
    readScopedPluginSettingsDeclaredFieldValue,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsProjection';
import {
    resolveScopedPluginSettingsServerIdentity,
    scopedPluginSettingsAdapter,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import { resolveAgentScopedPluginSettingsDeclarations } from './agentScopedPluginSettingsDeclarations';

/**
 * Reads inactive-session behavior Settings through the same scoped record
 * owner used by New Session. It has no legacy/global fallback and creates no
 * cache; projection, Account lifetime, and daemon target owners retain their
 * existing currentness responsibilities.
 */
export async function readAgentScopedPluginSettingsSnapshot(params: Readonly<{
    agentId: string | null | undefined;
    machineId: string | null | undefined;
    serverId: string | null | undefined;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
}>): Promise<AgentPluginSettingsSnapshot | null> {
    const machineId = String(params.machineId ?? '').trim();
    const serverId = String(params.serverId ?? '').trim();
    if (!machineId || !serverId) return null;

    const projectionInputs = await loadDaemonMergedProjectionInputs({
        machineId,
        serverId,
        ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
    });
    if (!projectionInputs) return null;
    const declarations = resolveAgentScopedPluginSettingsDeclarations({
        agentId: params.agentId,
        projectionInputs,
    });
    const serverIdentityId = resolveScopedPluginSettingsServerIdentity(serverId);
    if (!serverIdentityId) return null;

    const result: Partial<Record<'account' | 'daemon', Readonly<Record<string, unknown>>>> = {};
    for (const scope of ['account', 'daemon'] as const) {
        const declaration = declarations[scope];
        if (!declaration) continue;
        const target = resolveScopedPluginSettingsTarget({
            scope: declaration.scope,
            serverIdentityId,
            machineId,
            serverId,
        });
        if (!target) continue;
        const read = await scopedPluginSettingsAdapter.read({
            pluginId: declaration.pluginId,
            scope: declaration.scope,
            target,
            fields: projectScopedPluginSettingsFields(declaration.fields),
        });
        if (read.status !== 'ready') continue;
        result[scope] = Object.freeze(Object.fromEntries(declaration.fields.map((field) => [
            field.key,
            readScopedPluginSettingsDeclaredFieldValue({
                values: read.snapshot.values,
                field,
                serverIdentityId,
            }),
        ])));
    }

    return result.account || result.daemon ? Object.freeze(result) : null;
}
