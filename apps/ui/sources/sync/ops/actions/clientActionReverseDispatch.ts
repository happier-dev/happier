import {
    UiActionDispatchRequestV1Schema,
    parseClientActionDispatchResult,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { projectKnownAccountAuthorityRetirementReceipt } from '@happier-dev/protocol/actions/accountAuthorityRetirement';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createDefaultActionExecutor } from './defaultActionExecutor';

/** Only the server-authenticated exact Machine may enter this admitted continuation. */
export function createUiClientActionReverseHandler(binding: Readonly<{
    serverId: string;
    accountId: string;
    /** The dispatching Machine that admitted, and awaits, this continuation. */
    machineId?: string;
    isCurrent(): boolean;
    canExecute?(): boolean;
}>) {
    const failure = (errorCode: string) => ({ v: 1 as const, execution: { ok: false as const, errorCode, error: errorCode } });
    return async (raw: unknown, context?: Readonly<{ signal: AbortSignal }>) => {
        const request = UiActionDispatchRequestV1Schema.safeParse(raw);
        if (!request.success) return failure('invalid_action_input');
        if (!binding.isCurrent() || binding.canExecute?.() === false || !context || context.signal.aborted) return failure('target_unavailable');
        const { actionId, input, context: admitted } = request.data;
        const spec = getActionSpec(actionId);
        const readOnly = spec.sideEffectClass === 'read' || spec.sideEffectClass === 'none';
        const parentRequestId = admitted.actionRequestId;
        const executor = createDefaultActionExecutor({ admittedClientActionId: actionId,
            ...(binding.machineId && parentRequestId
                ? { admittedClientActionParent: { machineId: binding.machineId, requestId: parentRequestId } } : {}) });
        try {
            const execution = await executor.execute(actionId, input, {
                ...admitted,
                serverId: binding.serverId,
                expectedAccountId: binding.accountId,
                signal: context.signal,
            });
            // Retirement cannot disclose the old Account's data. Only a declared,
            // validated self-retirement keeps its already-known status-only receipt.
            let safeExecution = execution;
            if (!binding.isCurrent()) {
                const receipt = projectKnownAccountAuthorityRetirementReceipt(spec, execution);
                if (!receipt) return readOnly ? failure('action_account_scope_changed')
                    : { v: 1 as const, execution: { ...failure('outcome_uncertain').execution,
                        details: { reason: 'client_account_scope_changed' } } };
                safeExecution = receipt;
            }
            const result = parseClientActionDispatchResult(actionId, { v: 1, execution: safeExecution });
            return result ? { v: 1 as const, execution: result } : failure('invalid_action_output');
        } catch (error) {
            // Preserve the known receipt classification, but don't erase the
            // receiver's safe cause. Messages, payloads and stack paths stay
            // local; the shared sanitizer admits only code/class/status facts.
            const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
            return { v: 1 as const, execution: {
                ...failure(readOnly ? 'action_failed' : 'outcome_uncertain').execution,
                details: { reason: 'client_execution_exception', errorClass, errorCode, httpStatus },
            } };
        }
    };
}
