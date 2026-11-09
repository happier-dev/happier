import type { PluginAccountSettingsRecordAdapter } from './invocation/services/settings';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { SettingsService } from '@happier-dev/plugin-sdk/settings';
import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ResolvedSettingsContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { readPluginSettingsValuesWithDefaults } from './invocation/services/settings';

/** Read custody for an explicitly admitted Account; no host-global settings fallback. */
export type AgentPluginAccountSettingsSource = Readonly<{
    recordAdapter: PluginAccountSettingsRecordAdapter;
    readReleasedAccountSettings(): Readonly<Record<string, unknown>> | null;
}>;

/** Own Agent declarations and a custody-bound Settings service are the sole read authority. */
export async function resolveAgentPluginSettingsFromService(params: Readonly<{
    pluginId: string;
    localAgentId: string;
    declarations: readonly Pick<ResolvedSettingsContribution, 'pluginId' | 'definition'>[];
    resolveSettingsService(): Pick<SettingsService, 'forScope'> | null;
    includeDefaults?: boolean;
    releasedAccountSettings?: NonNullable<Parameters<typeof readPluginSettingsValuesWithDefaults>[1]>['releasedAccountSettings'];
    signal?: AbortSignal;
}>): Promise<AgentCliSessionCommandPluginSettingsV1 | null> {
    params.signal?.throwIfAborted();
    // An Agent may consume only its own declarations. Account and daemon
    // remain distinct records; no key merge or precedence rule exists.
    const scopes = new Set<'account' | 'daemon'>();
    for (const entry of params.declarations) {
        if (entry.pluginId !== params.pluginId || entry.definition.target.kind !== 'agent') continue;
        const target = entry.definition.target.agent;
        const matches = typeof target === 'string'
            ? target === params.localAgentId
            : target.pluginId === params.pluginId && target.localId === params.localAgentId;
        if (matches) scopes.add(entry.definition.scope);
    }
    if (scopes.size === 0) return null;
    const service = params.resolveSettingsService();
    if (!service) return null;
    const snapshot: { -readonly [Scope in keyof AgentCliSessionCommandPluginSettingsV1]: AgentCliSessionCommandPluginSettingsV1[Scope] } = {};
    for (const scope of scopes) {
        try {
            const scoped = service.forScope({ kind: scope });
            snapshot[scope] = params.includeDefaults !== false
                ? await readPluginSettingsValuesWithDefaults(scoped, { signal: params.signal,
                    ...(scope === 'account' && params.releasedAccountSettings ? { releasedAccountSettings: params.releasedAccountSettings } : {}),
                })
                : (await scoped.snapshot({ signal: params.signal })).values;
        } catch (error) {
            if (params.includeDefaults === false && (!(error instanceof PluginError) || error.code !== 'plugin_settings_scope_unavailable')) throw error;
            // One unavailable scope cannot be substituted with or merged
            // into the other. The exact available record remains useful.
        }
        params.signal?.throwIfAborted();
    }
    return snapshot.account || snapshot.daemon ? Object.freeze(snapshot) : null;
}

/** Resolve the explicit Account source used by every home materialization owner. */
export async function resolveAgentAccountSettingsApplicationContext(params: Readonly<{
    registry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes' | 'createPluginSettingsService'>;
    identity: Readonly<{ pluginId: string; localId: string }>;
    source?: AgentPluginAccountSettingsSource;
    allowNativeAccountState: boolean;
    signal?: AbortSignal;
}>): Promise<Readonly<{ pluginSettings: AgentCliSessionCommandPluginSettingsV1 | null }> | undefined> {
    const source = params.source;
    if (!source) return params.allowNativeAccountState ? undefined : { pluginSettings: null };
    const { ACCOUNT_SETTING_ARTIFACTS } = await import('@happier-dev/protocol/account/settings/accountSettings');
    const pluginSettings = await resolveAgentPluginSettingsFromService({
        pluginId: params.identity.pluginId, localAgentId: params.identity.localId,
        declarations: params.registry.contributes.settings ?? [],
        signal: params.signal,
        releasedAccountSettings: { settings: source.readReleasedAccountSettings(), hostDefaults: ACCOUNT_SETTING_ARTIFACTS.defaults },
        resolveSettingsService: () => ({ forScope: scope => {
            const service = params.registry.createPluginSettingsService?.({
                pluginId: params.identity.pluginId, scope, accountSettingsRecordAdapter: source.recordAdapter,
                signal: params.signal,
            });
            if (!service) throw new Error('Requester Agent Account settings are unavailable');
            return service;
        } }),
    });
    return { pluginSettings };
}
