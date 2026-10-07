import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AgentUiSettingReferenceV1 } from '@happier-dev/protocol/plugins/contributions/agentUiGrammar';
import type { PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/public-types';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    resolvePluginProjectionEditableSettingsGroup,
    type PluginProjectionEditableSettingField,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

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

export type AgentScopedPluginSettingPresentation = Readonly<{
    title: string;
    options: readonly Readonly<{
        value: unknown;
        title: string;
        description?: string;
    }>[];
}>;

/**
 * Reads one exact Agent-owned setting through the same qualified declaration
 * and localization owners used by the Agent Settings screen. This is a
 * read-only catalog projection: it neither reads nor writes the setting value.
 */
export function resolveAgentScopedPluginSettingPresentation(params: Readonly<{
    agentId: string | null | undefined;
    setting: AgentUiSettingReferenceV1;
    projectionInputs: DaemonMergedProjectionInputs | null | undefined;
    localize: (pluginId: string, value: PluginLocalizedStringV2) => string;
}>): AgentScopedPluginSettingPresentation | null {
    const declarations = resolveAgentScopedPluginSettingsDeclarations(params);
    const declaration = params.setting.scope === 'account'
        ? declarations.account
        : params.setting.scope === 'daemon'
            ? declarations.daemon
            : null;
    if (!declaration) return null;

    const group = params.projectionInputs?.pluginProjectionById[declaration.pluginId]
        ?.editableSettingsGroups.find((candidate) => (
            candidate.scope.kind === params.setting.scope
            && candidate.target.kind === 'agent'
            && candidate.fields.some((field) => field.key === params.setting.localId)
        ));
    if (!group) return null;
    const field = resolvePluginProjectionEditableSettingsGroup(group, params.localize)
        .fields.find((candidate) => candidate.key === params.setting.localId);
    const options = field?.presentation?.options;
    if (!field || !options) return null;
    return Object.freeze({
        title: field.title,
        options: Object.freeze(options.map((option) => Object.freeze({
            value: option.value,
            title: option.title,
            ...(option.description === undefined ? {} : { description: option.description }),
        }))),
    });
}

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
    const occurrenceId = entry.occurrenceId ?? 'unavailable';

    const buildDeclaration = (
        scope: 'account' | 'daemon',
    ): AgentScopedPluginSettingsDeclaration | null => {
        const fieldsByKey = new Map<string, PluginProjectionEditableSettingField>();
        for (const group of agentGroups) {
            if (group.scope.kind !== scope) continue;
            for (const field of group.fields) {
                if (field.secretCustody !== null || fieldsByKey.has(field.key)) continue;
                fieldsByKey.set(field.key, field);
            }
        }
        const fields = [...fieldsByKey.values()];
        if (fields.length === 0) return null;
        return Object.freeze({
            pluginId: identity.pluginId,
            scope: Object.freeze({ kind: scope }),
            fields: Object.freeze(fields),
            sourceLifetimeIdentity: `agent-settings:${identity.pluginId}/${identity.localId}:${scope}:${occurrenceId}`,
        });
    };

    return Object.freeze({
        account: buildDeclaration('account'),
        daemon: buildDeclaration('daemon'),
    });
}
