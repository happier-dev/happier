import * as React from 'react';
import { ActionOperationCancelV1ResponseSchema, type ActionOperationCancelV1Response } from '@happier-dev/protocol/actions/operations/v1';
import { awaitActionApprovalResult, createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

import { requestActionOperationStop, type ActionOperationStopTarget, type ActionOperationStopResponse, type ActionOperationStopContext } from './requestActionOperationStop';

type StopResult = Readonly<{ ok: true; result: ActionOperationCancelV1Response }> | Readonly<{ ok: false; errorCode: string }>;
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
    const [failureCode, setFailureCode] = React.useState<string | null>(null);
    const requestRef = React.useRef<AbortController | null>(null);
    const retryUnconfirmedStop = (operation?.snapshot.state === 'accepted' || operation?.snapshot.state === 'running')
        && operation.snapshot.observation?.kind === 'stop_unconfirmed';
    const stopRequested = feedback === 'requested' && !retryUnconfirmedStop;
    const scopeKey = JSON.stringify([operation?.serverId, operation?.snapshot.operationId]);
    const approval = useActionApprovalContinuation({ scopeKey, serverId: operation?.serverId ?? '', onExecuted: NO_APPROVAL_REFRESH });

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            requestRef.current?.abort();
        };
    }, []);
    React.useEffect(() => {
        setFeedback(null);
        setFailureCode(null);
        return () => { requestRef.current?.abort(); };
    }, [scopeKey]);

    const requestStop = React.useCallback(() => {
        if (!operation?.serverId || requestRef.current || stopRequested) return;
        const controller = new AbortController();
        requestRef.current = controller;
        setPending(true);
        setFeedback(null);
        setFailureCode(null);
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
                    failed: errorCode => ({ ok: false, errorCode }),
                    aborted: () => ({ ok: false, errorCode: 'cancelled' }),
                });
                if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
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
                    setFailureCode(controller.signal.aborted ? null : error instanceof Error && 'code' in error
                        && typeof error.code === 'string' ? error.code : 'operation_stop_failed');
                }
            })
            .finally(() => {
                if (requestRef.current === controller) {
                    requestRef.current = null;
                    if (mountedRef.current) setPending(false);
                }
            });
    }, [operation, request, approval.requestApproval, stopRequested]);

    return { pending, feedback, failureCode, stopRequested, retryUnconfirmedStop, requestStop, pendingApproval: approval.approvalId ? { artifactId: approval.approvalId, serverId: operation?.serverId } : null } as const;
}
