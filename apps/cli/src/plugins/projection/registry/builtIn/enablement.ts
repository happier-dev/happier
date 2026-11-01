import type { ResolvedPluginEnablement } from '../types';

/** Desired scope facts meet once, when bundled declarations are admitted. */
export function resolveBundledPluginEnablement(params: Readonly<{
    pluginIds: readonly string[];
    accountEnabledById?: Pick<ReadonlyMap<string, boolean>, 'get'>;
    accountUnavailable?: true;
    machineEnabledById?: Readonly<Record<string, boolean>>;
}>): Readonly<Record<string, ResolvedPluginEnablement>> {
    return Object.freeze(Object.fromEntries(params.pluginIds.map(pluginId => {
        const accountEnabled = params.accountUnavailable ? undefined : params.accountEnabledById?.get(pluginId) ?? true;
        const machineEnabled = params.machineEnabledById?.[pluginId] ?? true;
        return [pluginId, Object.freeze({ accountEnabled, machineEnabled, enabled: accountEnabled === true && machineEnabled,
            ...(params.accountUnavailable && machineEnabled ? { unavailableCode: 'plugin_account_execution_unavailable' as const } : {}),
        })];
    })));
}
