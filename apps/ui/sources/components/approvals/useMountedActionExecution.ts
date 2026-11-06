import * as React from 'react';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { resumeActionExecutionResult, type ActionApprovalContinuation } from './actionApprovalContinuation';
import { useActionApprovalContinuation } from './useActionApprovalContinuation';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute, requireActionSuccess, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

const onExecuted = () => {};
const retired = (): ActionExecuteResult => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
type MountedExecutorOptions = Omit<NonNullable<Parameters<typeof createFrontDoorActionExecute>[1]>, 'onBlockingApprovalPending'>;
type MountedOperation = UiActionOperation & Readonly<{ retainInvocation?: true; executorOptions?: MountedExecutorOptions }>;

/** Reconnect a mounted author's original public Action to its typed approval result. */
export function useMountedActionExecution(scopeOrHome: ServerAccountScope | string | null | undefined,
    options?: Readonly<{ onApprovalPending?: (registration: ActionApprovalContinuation) => void; runner?: SystemTaskRunner;
        /** Retain this mounted invocation's private operands/target across approval. */
        retainInvocation?: true;
        /** Existing local delivery ports; admission and approval presentation stay with this owner. */
        executorOptions?: MountedExecutorOptions;
    }>) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(typeof scopeOrHome === 'string' ? scopeOrHome : scopeOrHome?.serverId ?? null);
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
    // Dismissed surfaces can retire their interest before the modal finishes unmounting.
    const cancel = React.useCallback(() => lifetime.controller.abort(), [lifetime]);
    // Read at invocation because development effect replay can replace the controller.
    const getSignal = React.useCallback(() => lifetime.controller.signal, [lifetime]);
    const scopeKey = binding ? `${serverAccountScopeKeySuffix(binding.scope)}:${binding.revision}` : JSON.stringify(['unbound', scopeOrHome]);
    const approval = useActionApprovalContinuation({ scopeKey, serverId: scope?.serverId ?? '', onExecuted });
    const presentBlockingApproval = React.useCallback((capturedBinding: ServerCredentialAccountScopeBinding,
        current: () => boolean, fallbackSignal: AbortSignal,
        pending: Readonly<{ artifactId: string; signal?: AbortSignal }>) => {
        if (!current()) return;
        // The executor retains its live input/result; this registration presents that same Artifact.
        const registration: ActionApprovalContinuation = {
            artifactId: pending.artifactId, scope: capturedBinding.scope, refreshAfterExecution: false,
            signal: pending.signal ?? fallbackSignal, onExecuted: async () => 'ignored',
        };
        approval.requestApproval(registration);
        options?.onApprovalPending?.(registration);
    }, [approval.requestApproval, options?.onApprovalPending]);
    // Preserve the existing default port's lazy executor reuse for ordinary single-Home controls.
    const frontDoor = React.useMemo(() => createFrontDoorActionExecute(undefined, {
        ...options?.executorOptions,
        homeRuntimeRunner: options?.runner ?? options?.executorOptions?.homeRuntimeRunner,
        onBlockingApprovalPending: pending => {
            if (binding) presentBlockingApproval(binding, isCurrent, lifetime.controller.signal, pending);
        },
    }), [binding, isCurrent, lifetime, options?.executorOptions, options?.runner, presentBlockingApproval]);
    // Multi-Home collections bind this hook to null and provide the source's existing credential
    // lifetime. The same invocation engine owns admission, approval custody and retirement.
    const executeCaptured = React.useCallback(async (capturedBinding: ServerCredentialAccountScopeBinding,
        actionId: ActionId, input: unknown, operation?: MountedOperation): Promise<ActionExecuteResult> => {
        const capturedScope = capturedBinding.scope;
        const retirement = new AbortController();
        const subscription = capturedBinding.onRetire(() => retirement.abort());
        const cancellation = mergeAbortSignals([lifetime.controller.signal, retirement.signal, operation?.signal]);
        const invocationCurrent = () => capturedBinding.isCurrent() && !cancellation.signal.aborted;
        if (!invocationCurrent()) { subscription.dispose(); cancellation.dispose(); return retired(); }
        const frontDoorOptions = {
            ...options?.executorOptions,
            ...operation?.executorOptions,
            homeRuntimeRunner: operation?.executorOptions?.homeRuntimeRunner ?? options?.runner ?? options?.executorOptions?.homeRuntimeRunner,
            onBlockingApprovalPending: ({ artifactId, signal }: Readonly<{ artifactId: string; signal?: AbortSignal }>) => {
                presentBlockingApproval(capturedBinding, invocationCurrent, cancellation.signal, { artifactId, signal });
            },
        };
        try {
        // The admitted input includes the draft's original CAS. Never recapture it after approval.
        // Await the initial operation directly: later retirement cannot retract a durable ACK.
        // Per-invocation delivery ports cannot be reconstructed from a serialized approval input.
        const retainInvocation = Boolean(operation?.executorOptions) || (operation?.retainInvocation ?? options?.retainInvocation);
        const invoke = !retainInvocation && capturedBinding === binding && areServerAccountScopesEqual(capturedScope, scope)
            ? frontDoor : createFrontDoorActionExecute(undefined, { ...frontDoorOptions,
                ...(retainInvocation ? {
                    hostActionApprovalLifetime: { actionId, signal: cancellation.signal, surface: 'ui' as const },
                } : {}),
            });
        const result = await invoke(actionId, input, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: capturedScope.serverId, expectedAccountId: capturedScope.accountId,
            signal: cancellation.signal,
            ...(operation?.defaultSessionId ? { defaultSessionId: operation.defaultSessionId } : {}),
            ...(operation?.actionRequestId ? { actionRequestId: operation.actionRequestId } : {}),
            ...(operation?.onTransportIssued ? { onTransportIssued: operation.onTransportIssued } : {}),
            ...(operation?.isPluginSettingsIntentCurrent ? { isPluginSettingsIntentCurrent: operation.isPluginSettingsIntentCurrent } : {}),
            ...(operation?.presentUserConfirmation ? { presentUserConfirmation: operation.presentUserConfirmation } : {}),
            ...(operation?.executionRunTargetMachineId ? { executionRunTargetMachineId: operation.executionRunTargetMachineId } : {}),
            ...(operation?.executionRunLaunchOrigin ? { executionRunLaunchOrigin: operation.executionRunLaunchOrigin } : {}),
            ...(operation?.externalActionTarget ? { externalActionTarget: operation.externalActionTarget } : {}),
            ...(operation?.openRoute ? { openRoute: operation.openRoute } : {}),
            ...(operation?.reviewPublicProfilePreparedAction ? { reviewPublicProfilePreparedAction: operation.reviewPublicProfilePreparedAction } : {}),
        });
        if (!result.ok) return result;
        const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (!pending.success) return result;
        if (!invocationCurrent()) return retired();
        return await resumeActionExecutionResult({ result, actionId, actionInput: input, scope: capturedScope,
            signal: cancellation.signal, ...(operation?.actionRequestId ? { requestId: operation.actionRequestId } : {}),
            onApprovalPending: registration => {
                approval.requestApproval(registration);
                options?.onApprovalPending?.(registration);
            },
        });
        } catch (error) {
            if (!invocationCurrent()) return retired();
            throw error;
        } finally { subscription.dispose(); cancellation.dispose(); }
    }, [approval.requestApproval, binding, frontDoor, lifetime, options?.executorOptions, options?.onApprovalPending,
        options?.retainInvocation, options?.runner, presentBlockingApproval, scope]);
    const execute = React.useCallback(async (actionId: ActionId, input: unknown, operation?: MountedOperation): Promise<ActionExecuteResult> => {
        if (!binding || !scope || !isCurrent()) return retired();
        return executeCaptured(binding, actionId, input, operation);
    }, [binding, executeCaptured, isCurrent, scope]);
    /** Value-parsing clients unwrap only the terminal receipt delivered by this same mounted owner. */
    const executeValue = React.useCallback(async (actionId: ActionId, input: unknown, operation?: UiActionOperation): Promise<unknown> => {
        const result = await execute(actionId, input, operation);
        requireActionSuccess(result);
        return result.result;
    }, [execute]);
    return { execute, executeCaptured, executeValue, ready: isCurrent(), isCurrent, cancel, getSignal, approval, binding, resolution };
}
