import { type ActionExecutorContext, type ActionId } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionRequesterInvocationV1Schema, type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { randomUUID } from '@/platform/randomUUID';

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

/** Project process-local Plugin descriptors onto the incumbent private caller contract. */
export function projectUiAccountRequesterCaller(caller: ActionExecutorContext['actionCaller']): unknown {
    if (caller?.kind !== 'plugin') return caller;
    // Live descriptors also contain display/version/initiator facts. The closed
    // requester carrier owns its identity fields; retain those without teaching
    // each sender another copy of that schema. Admission still validates below.
    const fields = ExternalActionRequesterInvocationV1Schema.shape.caller._zod.def.options
        .flatMap(option => Object.keys(option.shape));
    return Object.fromEntries(Object.entries(caller).filter(([key]) => fields.includes(key)));
}

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
        const workspaceWrites = args.context.workspaceWrites === 'deny' || args.context.agentStartWorkspaceWrites === 'deny'
            ? 'deny' : args.context.workspaceWrites ?? args.context.agentStartWorkspaceWrites;
        const provenance = !args.context.externalActionCredential
            ? ExternalActionRequesterInvocationV1Schema.safeParse({ caller: projectUiAccountRequesterCaller(args.context.actionCaller),
                surface: args.context.surface, authority: args.context.authority,
                ...(args.context.callerPermissionMode !== undefined ? { callerPermissionMode: typeof args.context.callerPermissionMode === 'string'
                    ? parseAgentPermissionIntentV1Alias(args.context.callerPermissionMode) ?? args.context.callerPermissionMode : args.context.callerPermissionMode } : {}),
                ...(args.context.callerInputConstraints !== undefined ? { callerInputConstraints: args.context.callerInputConstraints } : {}),
                ...(workspaceWrites !== undefined ? { workspaceWrites } : {}),
                ...(args.context.defaultSessionId !== undefined ? { defaultSessionId: args.context.defaultSessionId } : {}),
            }) : null;
        if (!provenance?.success) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        if (target && target.kind !== 'machine') return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
        if (args.actionId === 'session.agent.transition' && (target?.kind !== 'machine' || !target.machineId.trim())) {
            return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        }
        const method = getActionSpec(args.actionId).bindings?.rpcMethod;
        const signal = args.signal ?? args.context.signal;
        const result = await params.transport({
            serverId: params.account.serverId,
            accountId: params.account.accountId,
            machineId,
            target: target?.kind === 'machine' ? { ...target, machineId } : { kind: 'machine', machineId },
            method: method ?? '',
            payload: args.input,
            actionId: args.actionId, requestId: args.context.actionRequestId ?? randomUUID(), invocation: provenance.data,
            ...(args.context.onTransportIssued ? { onTransportIssued: args.context.onTransportIssued } : {}),
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
