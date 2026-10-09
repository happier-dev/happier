import * as React from 'react';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalContinuation } from './actionApprovalContinuation';
import { useActionApprovalContinuation } from './useActionApprovalContinuation';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const onExecuted = () => {};
const retired = (): ActionExecuteResult => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });

/** Reconnect a mounted author's original public Action to its typed approval result. */
export function useMountedActionExecution(scopeOrHome: ServerAccountScope | string | null | undefined,
    options?: Readonly<{ onApprovalPending?: (registration: ActionApprovalContinuation) => void }>) {
    const { binding } = useServerCredentialAccountScopeBinding(typeof scopeOrHome === 'string' ? scopeOrHome : scopeOrHome?.serverId ?? null);
    const scope = typeof scopeOrHome === 'string' ? binding?.scope : scopeOrHome;
    const lifetime = React.useMemo(() => ({ controller: new AbortController() }), [binding]);
    React.useEffect(() => {
        // Development effect replay restores interest only while the original binding is current.
        if (lifetime.controller.signal.aborted) lifetime.controller = new AbortController();
        const controller = lifetime.controller;
        const retirement = binding?.onRetire(() => controller.abort());
        return () => { retirement?.dispose(); controller.abort(); };
    }, [binding, lifetime]);
    const isCurrent = React.useCallback(() => Boolean(binding?.isCurrent()
        && areServerAccountScopesEqual(binding.scope, scope) && !lifetime.controller.signal.aborted), [binding, lifetime, scope]);
    const scopeKey = binding ? `${serverAccountScopeKeySuffix(binding.scope)}:${binding.revision}` : JSON.stringify(['unbound', scopeOrHome]);
    const approval = useActionApprovalContinuation({ scopeKey, serverId: scope?.serverId ?? '', onExecuted });
    const frontDoor = React.useMemo(() => createFrontDoorActionExecute(), []);
    const execute = React.useCallback(async (actionId: ActionId, input: unknown): Promise<ActionExecuteResult> => {
        if (!binding || !scope || !isCurrent()) return retired();
        // The admitted input includes the draft's original CAS. Never recapture it after approval.
        // Await the initial operation directly: later retirement cannot retract a durable ACK.
        const result = await frontDoor(actionId, input, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: scope.serverId, expectedAccountId: scope.accountId,
        });
        if (!result.ok) return result;
        const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (!pending.success) return result;
        if (!isCurrent()) return retired();
        return awaitActionApprovalResult<unknown, ActionExecuteResult>({
            signal: lifetime.controller.signal,
            execute: async callbacks => {
                const registration = createActionApprovalContinuation({
                    artifactId: pending.data.artifactId, actionId, scope: binding.scope, expectedInput: input,
                    signal: lifetime.controller.signal,
                    onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
                });
                approval.requestApproval(registration);
                options?.onApprovalPending?.(registration);
                return { approvalPending: true };
            },
            succeeded: value => ({ ok: true, result: value }),
            failed: (code, failure) => failure ?? { ok: false, errorCode: code, error: code },
            aborted: retired,
        });
    }, [approval.requestApproval, binding, frontDoor, isCurrent, lifetime, options?.onApprovalPending, scope]);
    return { execute, ready: isCurrent(), isCurrent, approval };
}
