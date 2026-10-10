import { createTargetedActionRpcRequestV1, type ActionExecutorContext, type ActionId } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

export type AccountActionTransport = (input: Readonly<{
    serverId: string;
    accountId: string;
    machineId: string;
    method: string;
    payload: unknown;
    signal?: AbortSignal;
    /** Connection setup stays bounded; the caller owns admission cancellation. */
    operationTimeoutMs?: null;
}>) => Promise<unknown>;

export type UiAccountActionExecute = (args: Readonly<{
    actionId: ActionId;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
}>) => Promise<unknown>;

/** Shared Account-to-daemon relay; reachability does not create a resource target. */
export function createUiAccountActionTransport(params: Readonly<{
    account: Readonly<{ serverId: string; accountId: string; assertCurrent: () => void }>;
    resolveFallbackMachineId: () => string | null;
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
            : params.resolveFallbackMachineId();
        if (!machineId) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        const method = getActionSpec(args.actionId).bindings?.rpcMethod;
        if (!method) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${args.actionId}` };
        const signal = args.signal ?? args.context.signal;
        const result = await params.transport({
            serverId: params.account.serverId,
            accountId: params.account.accountId,
            machineId,
            method,
            payload: target
                ? createTargetedActionRpcRequestV1(args.input, target, { defaultSessionId: args.context.defaultSessionId })
                : args.input,
            ...(signal ? { signal } : {}),
            // Admission may finish after connection/key hydration consumed the
            // ordinary RPC budget. Keep its authoritative result rather than
            // abandoning a late refusal to missing-Run reconciliation.
            ...(args.actionId === 'workflow.run.start' ? { operationTimeoutMs: null } : {}),
        });
        try {
            params.account.assertCurrent();
        } catch {
            return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
        }
        return result;
    };
}
