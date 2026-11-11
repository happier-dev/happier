import type { ResolvedPluginEnablement, UnavailableAgentPlugin } from '../types';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isDeepStrictEqual } from 'node:util';

/** Admission and catalog projections change when any owning scope fact changes. */
export function arePluginEnablementsEqual(
    before: ResolvedPluginEnablement | undefined,
    after: ResolvedPluginEnablement | undefined,
): boolean {
    return isDeepStrictEqual(before, after);
}

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

/** Session entry points carry the admission owner's cause to Action settlement. */
export function createPluginEnablementUnavailableError(
    fact: Pick<ResolvedPluginEnablement, 'unavailableCode' | 'unavailableCause'> & Readonly<{ code?: UnavailableAgentPlugin['code'] }>,
    message?: string,
): Error & Readonly<{ code: UnavailableAgentPlugin['code']; failureCause?: ActionFailureCauseV1 }> {
    const code = fact.unavailableCode ?? fact.code ?? 'plugin_disabled';
    return Object.assign(new Error(message ?? code), {
        code,
        ...(fact.unavailableCause ? { failureCause: fact.unavailableCause } : {}),
    });
}
