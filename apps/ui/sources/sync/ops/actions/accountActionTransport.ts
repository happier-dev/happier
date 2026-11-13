import { actionTargetUnavailable } from '@happier-dev/protocol/actions/actionExecutionResult';
import { type ActionExecutorContext, type ActionId } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { projectExternalActionRequesterInvocationV1, type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { randomUUID } from '@/platform/randomUUID';
import type { LazyActionAccountContext } from './actionAccountContext';

export type AccountActionTransport = (input: Readonly<{
    serverId: string;
    accountId: string;
    machineId: string;
    target: Extract<NonNullable<ActionExecutorContext['externalActionTarget']>, { kind: 'machine' }>;
    method: string;
    payload: unknown;
    signal?: AbortSignal;
    /** Connection setup stays bounded; the caller owns admission cancellation. */
    operationTimeoutMs?: null;
    actionId: ActionId;
    requestId: string;
    invocation: ExternalActionRequesterInvocationV1;
    onTransportIssued?: () => void;
}>) => Promise<unknown>;

export type UiAccountActionExecute = (args: Readonly<{
    actionId: ActionId;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
}>) => Promise<unknown>;

/** Shared Account-to-daemon relay; reachability does not create a resource target. */
export function createUiAccountActionTransport(params: Readonly<{
    account: Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'assertCurrent' | 'assertResultCurrent'>
        & Partial<Pick<LazyActionAccountContext, 'serverIdentityId'>>;
    resolveFallbackMachineId: (args: Parameters<UiAccountActionExecute>[0]) => string | null | ReturnType<typeof actionTargetUnavailable> | Promise<string | null | ReturnType<typeof actionTargetUnavailable>>;
    transport: AccountActionTransport;
}>): UiAccountActionExecute {
    return async (args) => {
        try {
            params.account.assertCurrent();
        } catch {
            return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
        }
        // Composition resolves equivalent Home ids before this exact boundary.
        if (args.context.serverId !== params.account.serverId
            || args.context.runtimeAccountId !== params.account.accountId) {
            return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
        }
        const target = args.context.externalActionTarget;
        const machineId = target?.kind === 'machine' && target.machineId.trim()
            ? target.machineId.trim()
            : await params.resolveFallbackMachineId(args);
        if (typeof machineId === 'object' && machineId !== null) return machineId;
        if (!machineId) return actionTargetUnavailable('own_reachable_machine_absent');
        const relayTarget = target?.kind === 'machine' ? { ...target, machineId } : { kind: 'machine' as const, machineId };
        const provenance = projectExternalActionRequesterInvocationV1({ ...args, account: params.account, target: relayTarget });
        if (!provenance) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        if (target && target.kind !== 'machine') return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
        if (args.actionId === 'session.agent.transition' && (target?.kind !== 'machine' || !target.machineId.trim())) {
            return actionTargetUnavailable('explicit_machine_target_absent');
        }
        const spec = getActionSpec(args.actionId);
        const method = spec.bindings?.rpcMethod;
        const signal = args.signal ?? args.context.signal;
        const result = await params.transport({
            serverId: params.account.serverId,
            accountId: params.account.accountId,
            machineId,
            target: relayTarget,
            method: method ?? '',
            payload: args.input,
            actionId: args.actionId, requestId: args.context.actionRequestId ?? randomUUID(), invocation: provenance,
            ...(args.context.onTransportIssued ? { onTransportIssued: args.context.onTransportIssued } : {}),
            ...(signal ? { signal } : {}),
            // Admission may finish after connection/key hydration consumed the
            // ordinary RPC budget. Keep its authoritative result rather than
            // abandoning a late refusal to missing-Run reconciliation.
            ...(args.actionId === 'workflow.run.start' ? { operationTimeoutMs: null } : {}),
        });
        try {
            // The Account owner distinguishes read disclosure from an issued
            // effect's receipt; presentation cancellation cannot rewrite it.
            params.account.assertResultCurrent(spec.sideEffectClass, signal);
        } catch {
            return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
        }
        return result;
    };
}
