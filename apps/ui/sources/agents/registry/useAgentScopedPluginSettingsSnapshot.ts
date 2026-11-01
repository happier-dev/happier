import * as React from 'react';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    resolveAgentScopedPluginSettingsDeclarations,
    type AgentScopedPluginSettingsDeclarations,
} from '@/agents/registry/agentScopedPluginSettingsDeclarations';
import type { AgentPluginSettingsReadiness, AgentPluginSettingsSnapshot } from '@/agents/registry/registryUiBehavior';
import {
    projectScopedPluginSettingsFields,
    readScopedPluginSettingsDeclaredFieldValue,
    useScopedPluginSettingsProjection,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsProjection';
import { resolveScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import {
    resolveScopedPluginSettingsServerIdentity,
    scopedPluginSettingsAdapter,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useSettingsSelector } from '@/sync/store/hooks';

const NO_SETTINGS_KEYS: readonly string[] = Object.freeze([]);

/**
 * One Agent's declared Account and daemon plugin settings as the snapshot its UI behavior reads
 * (for example the runtime kind it is configured to start on). The new-session screen and the
 * Agent page both consume this; neither reads a plugin settings record directly.
 */
export function useAgentScopedPluginSettingsSnapshot(params: Readonly<{
    agentId: string | null | undefined;
    projectionInputs: DaemonMergedProjectionInputs | null | undefined;
    serverId: string | null;
    machineId: string | null | undefined;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    /** The projection the declarations come from is current. */
    enabled: boolean;
}>): Readonly<{
    snapshot: AgentPluginSettingsSnapshot | null;
    ready: boolean;
    readiness: AgentPluginSettingsReadiness | null;
}> {
    /**
     * The selected installed Agent's declarations are the only owners of the
     * settings consumed by its behavior. Account and daemon groups are both
     * legitimate and are projected independently through the canonical hook;
     * this model only selects exact Agent-targeted groups and never reads a
     * record directly.
     */
    const selectedAgentScopedSettingsDeclarations = React.useMemo<AgentScopedPluginSettingsDeclarations>(() => (
        resolveAgentScopedPluginSettingsDeclarations({
            agentId: params.agentId,
            projectionInputs: params.projectionInputs,
        })
    ), [params.projectionInputs, params.agentId]);
    const selectedAgentSettingsTargets = React.useMemo(() => {
        const serverIdentityId = resolveScopedPluginSettingsServerIdentity(params.serverId);
        const resolveTarget = (declaration: typeof selectedAgentScopedSettingsDeclarations.account) => (
            declaration
                ? resolveScopedPluginSettingsTarget({
                    scope: declaration.scope,
                    serverIdentityId,
                    machineId: params.machineId,
                    serverId: params.serverId,
                })
                : null
        );
        return Object.freeze({
            account: resolveTarget(selectedAgentScopedSettingsDeclarations.account),
            daemon: resolveTarget(selectedAgentScopedSettingsDeclarations.daemon),
        });
    }, [selectedAgentScopedSettingsDeclarations, params.machineId, params.serverId]);
    const selectedAgentSettingsFields = React.useMemo(() => Object.freeze({
        account: selectedAgentScopedSettingsDeclarations.account
            ? projectScopedPluginSettingsFields(selectedAgentScopedSettingsDeclarations.account.fields)
            : [],
        daemon: selectedAgentScopedSettingsDeclarations.daemon
            ? projectScopedPluginSettingsFields(selectedAgentScopedSettingsDeclarations.daemon.fields)
            : [],
    }), [selectedAgentScopedSettingsDeclarations]);
    const selectedAgentAccountSettings = useScopedPluginSettingsProjection({
        pluginId: selectedAgentScopedSettingsDeclarations.account?.pluginId ?? '',
        scope: { kind: 'account' },
        target: selectedAgentSettingsTargets.account,
        accountLifetime: params.accountLifetime,
        fields: selectedAgentSettingsFields.account,
        sourceLifetimeIdentity: selectedAgentScopedSettingsDeclarations.account?.sourceLifetimeIdentity,
        perActiveServerIdentityId: resolveScopedPluginSettingsServerIdentity(params.serverId),
        enabled: params.enabled && selectedAgentSettingsTargets.account !== null,
        adapter: scopedPluginSettingsAdapter,
    });
    const selectedAgentDaemonSettings = useScopedPluginSettingsProjection({
        pluginId: selectedAgentScopedSettingsDeclarations.daemon?.pluginId ?? '',
        scope: { kind: 'daemon' },
        target: selectedAgentSettingsTargets.daemon,
        accountLifetime: params.accountLifetime,
        fields: selectedAgentSettingsFields.daemon,
        sourceLifetimeIdentity: selectedAgentScopedSettingsDeclarations.daemon?.sourceLifetimeIdentity,
        perActiveServerIdentityId: resolveScopedPluginSettingsServerIdentity(params.serverId),
        enabled: params.enabled && selectedAgentSettingsTargets.daemon !== null,
        adapter: scopedPluginSettingsAdapter,
    });
    const selectedAgentSettingsSources = React.useMemo(() => [
        {
            declaration: selectedAgentScopedSettingsDeclarations.daemon,
            projection: selectedAgentDaemonSettings,
        },
        {
            declaration: selectedAgentScopedSettingsDeclarations.account,
            projection: selectedAgentAccountSettings,
        },
    ] as const, [
        selectedAgentAccountSettings,
        selectedAgentDaemonSettings,
        selectedAgentScopedSettingsDeclarations.account,
        selectedAgentScopedSettingsDeclarations.daemon,
    ]);
    const selectedAgentHasScopedSettings = React.useMemo(
        () => selectedAgentSettingsSources.some((source) => source.declaration !== null),
        [selectedAgentSettingsSources],
    );
    const selectedAgentSettingsReady = React.useMemo(
        () => !selectedAgentHasScopedSettings
            || selectedAgentSettingsSources.every((source) => source.declaration === null || source.projection.state.ready),
        [selectedAgentHasScopedSettings, selectedAgentSettingsSources],
    );
    const selectedAgentAccountFieldValues = useSettingsSelector(React.useCallback((accountSettings) => {
        const values: Record<string, unknown> = {};
        const declaration = selectedAgentScopedSettingsDeclarations.account;
        if (!declaration) return values;
        const serverIdentityId = resolveScopedPluginSettingsServerIdentity(params.serverId);
        for (const field of declaration.fields) {
            const value = readScopedPluginSettingsDeclaredFieldValue({
                values: selectedAgentAccountSettings.state.values,
                field,
                serverIdentityId,
                releasedFlatSettings: accountSettings,
            });
            if (value !== undefined) values[field.key] = value;
        }
        return values;
    }, [selectedAgentAccountSettings.state.values, selectedAgentScopedSettingsDeclarations.account, params.serverId]),
    // An Agent without Account declarations reads no Account setting, so it demands none.
    selectedAgentScopedSettingsDeclarations.account ? undefined : NO_SETTINGS_KEYS);
    const selectedAgentPluginSettings: AgentPluginSettingsSnapshot | null = React.useMemo(() => {
        if (!selectedAgentHasScopedSettings || !selectedAgentSettingsReady) return null;
        const serverIdentityId = resolveScopedPluginSettingsServerIdentity(params.serverId);
        const values: Record<'account' | 'daemon', Record<string, unknown>> = {
            account: selectedAgentAccountFieldValues,
            daemon: {},
        };
        // Preserve both scope records independently. A declaration may reuse a
        // local field id in Account and daemon scopes; deduping here would make
        // the daemon-first iteration order an accidental precedence rule.
        for (const source of selectedAgentSettingsSources) {
            if (!source.declaration) continue;
            const scope = source.declaration.scope.kind;
            if (scope === 'account') continue;
            for (const field of source.declaration.fields) {
                const value = readScopedPluginSettingsDeclaredFieldValue({
                    values: source.projection.state.values,
                    field,
                    serverIdentityId,
                });
                if (value !== undefined) values[scope][field.key] = value;
            }
        }
        return Object.freeze({
            account: Object.freeze(values.account),
            daemon: Object.freeze(values.daemon),
        });
    }, [selectedAgentAccountFieldValues, selectedAgentHasScopedSettings, selectedAgentSettingsReady, selectedAgentSettingsSources, params.serverId]);
    const readiness: AgentPluginSettingsReadiness | null = React.useMemo(
        () => selectedAgentHasScopedSettings
            ? {
                ready: selectedAgentSettingsReady,
                settled: selectedAgentSettingsSources.every((source) => source.declaration === null || source.projection.state.settled),
                loading: selectedAgentSettingsSources.some((source) => source.declaration !== null && source.projection.state.loading),
                error: selectedAgentSettingsSources.find((source) => source.declaration !== null && source.projection.state.error)?.projection.state.error ?? null,
            }
            : null,
        [selectedAgentHasScopedSettings, selectedAgentSettingsReady, selectedAgentSettingsSources],
    );
    return { snapshot: selectedAgentPluginSettings, ready: selectedAgentSettingsReady, readiness };
}
