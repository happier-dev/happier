import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ConnectedServicePoolSelectionGetResponseV1Schema, type ConnectedServicePoolSelectionGetRequestV1,
    type ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

export type UsageWidgetSelectionReadResult = Readonly<{
    ok: true;
    result: ConnectedServicePoolSelectionGetResponseV1;
}> | ActionExecuteFailure;

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** Read-only mounted adapter. U3 owns qualified validation, selection and its decision trace. */
export async function readUsageWidgetSelection(input: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    request: ConnectedServicePoolSelectionGetRequestV1;
    signal?: AbortSignal;
}>): Promise<UsageWidgetSelectionReadResult> {
    if (!input.lifetime.isCurrent()) return failure('action_account_scope_changed');
    if (input.signal?.aborted) return failure('cancelled');
    const retirementController = new AbortController();
    const retirement = input.lifetime.onRetire(() => retirementController.abort());
    const cancellation = mergeAbortSignals([retirementController.signal, input.signal]);
    try {
        if (!input.lifetime.isCurrent()) return failure('action_account_scope_changed');
        cancellation.signal.throwIfAborted();
        const result = await createFrontDoorActionExecute()('connectedServices.pools.selection.get', input.request, {
            surface: 'ui', serverId: input.lifetime.scope.serverId,
            expectedAccountId: input.lifetime.scope.accountId, signal: cancellation.signal,
        });
        if (!input.lifetime.isCurrent()) return failure('action_account_scope_changed');
        if (cancellation.signal.aborted) return failure('cancelled');
        if (!result.ok) return result;
        const response = ConnectedServicePoolSelectionGetResponseV1Schema.safeParse(result.result);
        return response.success ? { ok: true, result: response.data } : failure('connected_account_daemon_response_invalid');
    } catch {
        if (!input.lifetime.isCurrent()) return failure('action_account_scope_changed');
        return failure(cancellation.signal.aborted ? 'cancelled' : 'connected_service_request_failed');
    } finally {
        cancellation.dispose();
        retirement.dispose();
    }
}
