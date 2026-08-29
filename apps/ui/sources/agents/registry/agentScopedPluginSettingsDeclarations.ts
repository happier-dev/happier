import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

export type AgentScopedPluginSettingsDeclaration = Readonly<{
    pluginId: string;
    scope: Readonly<{ kind: 'account' | 'daemon' }>;
    fields: readonly PluginProjectionEditableSettingField[];
    sourceLifetimeIdentity: string;
}>;

export type AgentScopedPluginSettingsDeclarations = Readonly<{
    account: AgentScopedPluginSettingsDeclaration | null;
    daemon: AgentScopedPluginSettingsDeclaration | null;
}>;

const EMPTY_DECLARATIONS: AgentScopedPluginSettingsDeclarations = Object.freeze({
    account: null,
    daemon: null,
});

/** Select the exact Settings declarations owned by one qualified Agent entry. */
export function resolveAgentScopedPluginSettingsDeclarations(params: Readonly<{
    agentId: string | null | undefined;
    projectionInputs: DaemonMergedProjectionInputs | null | undefined;
}>): AgentScopedPluginSettingsDeclarations {
    const runtimeAgentId = String(params.agentId ?? '').trim();
    const projectionInputs = params.projectionInputs;
    if (!runtimeAgentId || !projectionInputs) return EMPTY_DECLARATIONS;

    const projectedAgent = projectionInputs.pluginProjectionV2?.agentsById[runtimeAgentId];
    const identity = projectedAgent?.identity ?? parseQualifiedPluginContributionKey(runtimeAgentId);
    if (!identity) return EMPTY_DECLARATIONS;
    const entry = projectionInputs.pluginProjectionById?.[identity.pluginId];
    if (!entry) return EMPTY_DECLARATIONS;

    const agentGroups = entry.editableSettingsGroups.filter((group) => (
        group.target.kind === 'agent'
        && group.target.agent.pluginId === identity.pluginId
        && group.target.agent.localId === identity.localId
    ));
    const generation = entry.immutableGenerationId
        ?? projectionInputs.pluginProjectionV2?.generation
        ?? 'unknown';

    const buildDeclaration = (
        scope: 'account' | 'daemon',
    ): AgentScopedPluginSettingsDeclaration | null => {
        const fieldsByKey = new Map<string, PluginProjectionEditableSettingField>();
        for (const group of agentGroups) {
            if (group.scope.kind !== scope) continue;
            for (const field of group.fields) {
                if (field.secretCustody !== 'none' || fieldsByKey.has(field.key)) continue;
                fieldsByKey.set(field.key, field);
            }
        }
        const fields = [...fieldsByKey.values()];
        if (fields.length === 0) return null;
        return Object.freeze({
            pluginId: identity.pluginId,
            scope: Object.freeze({ kind: scope }),
            fields: Object.freeze(fields),
            sourceLifetimeIdentity: `agent-settings:${identity.pluginId}/${identity.localId}:${scope}:${generation}`,
        });
    };

    return Object.freeze({
        account: buildDeclaration('account'),
        daemon: buildDeclaration('daemon'),
    });
}
