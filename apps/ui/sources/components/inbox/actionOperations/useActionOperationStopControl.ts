import * as React from 'react';
import { ActionOperationCancelV1ResponseSchema, type ActionOperationCancelV1Response } from '@happier-dev/protocol/actions/operations/v1';
import { createActionExecuteFailureError, parseActionExecuteFailure, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { awaitActionApprovalResult, createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { presentActionExecutionFailure, resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { t } from '@/text';

import { requestActionOperationStop, type ActionOperationStopTarget, type ActionOperationStopResponse, type ActionOperationStopContext } from './requestActionOperationStop';

type StopResult = Readonly<{ ok: true; result: ActionOperationCancelV1Response }> | ActionExecuteFailure;
const NO_APPROVAL_REFRESH = () => {};

export function useActionOperationStopControl(
    operation: ActionOperationStopTarget | null | undefined,
    request?: (operation: ActionOperationStopTarget, context: ActionOperationStopContext) => Promise<ActionOperationStopResponse | void> | void,
) {
    const mountedRef = React.useRef(true);
    const [pending, setPending] = React.useState(false);
    const [feedback, setFeedback] = React.useState<
        'requested' | 'unsupported' | 'already_settled' | 'not_found' | 'failed' | null
    >(null);
    const [failure, setFailure] = React.useState<ActionExecuteFailure | null>(null);
    const requestRef = React.useRef<AbortController | null>(null);
    const live = operation?.snapshot.state === 'accepted' || operation?.snapshot.state === 'running';
    const retryUnconfirmedStop = live
        && operation?.snapshot.observation?.kind === 'stop_unconfirmed';
    const stopRequested = live && feedback === 'requested' && !retryUnconfirmedStop;
    const scopeKey = JSON.stringify([operation?.serverId, operation?.snapshot.operationId]);
    const approval = useActionApprovalContinuation({ scopeKey, serverId: operation?.serverId ?? '',
        onExecuted: NO_APPROVAL_REFRESH });
    const awaitingApproval = approval.approvalId !== null && (approval.approvalStatus === undefined || approval.approvalStatus === 'open');

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            requestRef.current?.abort();
        };
    }, []);
    React.useEffect(() => {
        setFeedback(null);
        setFailure(null);
        return () => { requestRef.current?.abort(); };
    }, [scopeKey]);

    const requestStop = React.useCallback(() => {
        if (!operation?.serverId || requestRef.current || stopRequested) return;
        const controller = new AbortController();
        requestRef.current = controller;
        setPending(true);
        setFeedback(null);
        setFailure(null);
        void (async () => {
            const account = await captureLazyActionAccountContext(operation.serverId!, controller.signal);
            const retirement = account.accountLifetime.onRetire(() => controller.abort());
            try {
                const result = await awaitActionApprovalResult<ActionOperationCancelV1Response, StopResult>({
                    signal: controller.signal,
                    execute: async callbacks => {
                        account.assertCurrent();
                        if (account.accountId !== operation.snapshot.scope.accountId) {
                            throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
                        }
                        const response = await (request ?? requestActionOperationStop)(operation, {
                            expectedAccountId: account.accountId, signal: controller.signal,
                        });
                        if (response?.kind === 'approval_request_created') {
                            account.assertCurrent();
                            approval.requestApproval(createActionApprovalContinuation<ActionOperationCancelV1Response, 'action.operations.cancel'>({
                                artifactId: response.artifactId, actionId: 'action.operations.cancel',
                                scope: account.accountLifetime.scope,
                                expectedInput: { serverId: operation.serverId, machineId: operation.snapshot.scope.machineId, operationId: operation.snapshot.operationId },
                                signal: controller.signal,
                                onSucceeded: callbacks.onApprovalSucceeded,
                                onFailed: callbacks.onApprovalFailed,
                            }));
                            return { approvalPending: true };
                        }
                        return { ok: true, result: ActionOperationCancelV1ResponseSchema.parse(response) };
                    },
                    succeeded: value => ({ ok: true, result: ActionOperationCancelV1ResponseSchema.parse(value) }),
                    failed: (errorCode, failure) => {
                        // A typed refusal still owns the Stop control's specific feedback,
                        // but never means approval success or that the operation stopped.
                        const output = ActionOperationCancelV1ResponseSchema.safeParse(failure?.details);
                        return output.success && output.data.kind === errorCode
                            ? { ok: true, result: output.data }
                            : failure ?? { ok: false, errorCode, error: errorCode };
                    },
                    aborted: () => ({ ok: false, errorCode: 'cancelled', error: 'cancelled' }),
                });
                if (!result.ok) throw createActionExecuteFailureError(result);
                return result.result;
            } finally {
                retirement.dispose();
                account.dispose();
            }
        })()
            .then((result) => {
                if (mountedRef.current && !controller.signal.aborted) setFeedback(result.kind);
            })
            .catch((error: unknown) => {
                if (mountedRef.current) {
                    setFeedback(controller.signal.aborted ? null : 'failed');
                    if (controller.signal.aborted) { setFailure(null); return; }
                    const failure = parseActionExecuteFailure(error) ?? {
                        ok: false as const, ...normalizeActionExecutorThrownError(error, 'action.operations.cancel'),
                    };
                    setFailure(failure);
                    const presentation = presentActionExecutionFailure(failure, t('inbox.actionOperations.cancel.failed'));
                    alertActionFailure({ reason: presentation.reason, code: failure.errorCode, requestId: failure.requestId,
                        context: Object.fromEntries(presentation.technicalDetails.map(detail => [detail.key, detail.value])) });
                }
            })
            .finally(() => {
                if (requestRef.current === controller) {
                    requestRef.current = null;
                    if (mountedRef.current) setPending(false);
                }
            });
    }, [operation, request, approval.requestApproval, stopRequested]);

    // A late cancel acknowledgement cannot override the operation owner's settled
    // outcome. Keep request custody until it returns, but stop presenting it as work.
    return { pending: live && pending && !awaitingApproval, feedback, failure,
        failureCode: failure?.errorCode ?? null,
        failureReason: live && failure ? resolveActionExecutionErrorMessage(failure, t('inbox.actionOperations.cancel.failed')) : null,
        stopRequested, retryUnconfirmedStop, requestStop,
        pendingApproval: approval.approvalId ? { artifactId: approval.approvalId, serverId: operation?.serverId } : null } as const;
}
