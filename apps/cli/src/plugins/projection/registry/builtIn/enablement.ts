import type { ResolvedPluginEnablement, UnavailableAgentPlugin } from '../types';
import { createActionExecuteFailureError, isActionExecuteFailure, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionSpawnLaunchErrorV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnLaunchErrorV1';
import { isDeepStrictEqual } from 'node:util';

export const ACCOUNT_PLUGIN_CENSUS_UNAVAILABLE_MESSAGE = 'Account plugin availability could not be checked. Try again in a moment.';

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
    fact: Pick<ResolvedPluginEnablement, 'unavailableCode' | 'unavailableCause' | 'unavailableRequestId'> & Readonly<{ code?: UnavailableAgentPlugin['code'] }>,
    message?: string,
): ReturnType<typeof createActionExecuteFailureError> {
    const code = fact.unavailableCode ?? fact.code ?? 'plugin_disabled';
    return createActionExecuteFailureError({
        ok: false,
        errorCode: code,
        error: message ?? code,
        details: { reason: code },
        ...(fact.unavailableCause ? { failureCause: fact.unavailableCause } : {}),
        ...(fact.unavailableRequestId ? { requestId: fact.unavailableRequestId } : {}),
    });
}

/** Carries the census refusal through the existing Session launch error contract. */
export function projectAccountPluginCensusLaunchError(error: unknown): SessionSpawnLaunchErrorV1 | null {
    if (!isActionExecuteFailure(error) || error.errorCode !== 'plugin_account_census_failed') return null;
    return {
        kind: 'launch_error',
        code: error.errorCode,
        message: ACCOUNT_PLUGIN_CENSUS_UNAVAILABLE_MESSAGE,
        failureCause: {
            phase: 'client_start',
            failureReason: 'unknown',
            retryable: true,
            ...(error.failureCause ? { actionCause: error.failureCause } : {}),
            ...(error.requestId ? { requestId: error.requestId } : {}),
        },
    };
}
