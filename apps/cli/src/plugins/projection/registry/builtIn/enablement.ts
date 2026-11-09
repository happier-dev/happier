import type { ResolvedPluginEnablement } from '../types';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Desired scope facts meet once, when bundled declarations are admitted. */
export function resolveBundledPluginEnablement(params: Readonly<{
    pluginIds: readonly string[];
    accountEnabledById?: Pick<ReadonlyMap<string, boolean>, 'get'>;
    accountFailure?: Readonly<{ failureCause: ActionFailureCauseV1; requestId?: string }>;
    machineEnabledById?: Readonly<Record<string, boolean>>;
}>): Readonly<Record<string, ResolvedPluginEnablement>> {
    return Object.freeze(Object.fromEntries(params.pluginIds.map(pluginId => {
        const accountEnabled = params.accountFailure ? undefined : params.accountEnabledById?.get(pluginId) ?? true;
        const machineEnabled = params.machineEnabledById?.[pluginId] ?? true;
        return [pluginId, Object.freeze({ accountEnabled, machineEnabled, enabled: accountEnabled === true && machineEnabled,
            ...(params.accountFailure && machineEnabled ? {
                unavailableCode: 'plugin_account_census_failed' as const,
                unavailableCause: params.accountFailure.failureCause,
                ...(params.accountFailure.requestId ? { unavailableRequestId: params.accountFailure.requestId } : {}),
            } : {}),
        })];
    })));
}
