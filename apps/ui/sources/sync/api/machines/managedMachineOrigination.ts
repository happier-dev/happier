import { readManagedMachineActionOutputV1 } from '@/sync/api/machines/managedMachineResponse';
import { ManagedMachineActionInputSchemasV1, resolveManagedAcquireReviewV1,
    type ManagedMachineActionIdV1, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { AsyncTimeoutError, withTimeout } from '@/utils/timing/time';
import { createManagedMachineActionClient, ManagedMachineActionError } from './managedMachineActions';
import { executeOriginalAccountActionTransport, executeOriginalAccountMachineAction, readOriginalAccountActionAuthentication,
    readOriginalAccountActionMachine } from '@/sync/api/externalActionAccountTransport';

const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });

type ManagedMachineNativeActionParams = Readonly<{
    account: LazyActionAccountContext;
    actionId: ManagedMachineActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
}>;

/** Ordinary captured Account ingress. The server, not this client, admits and signs the native role. */
export async function executeManagedMachineNativeAction(params: ManagedMachineNativeActionParams): Promise<ActionExecuteResult> {
    return withManagedMachineNativeReadLifetime(params.actionId, params.signal,
        signal => executeManagedMachineNativeActionWithinLifetime({ ...params, signal }));
}

// The front door enters before Account capture/settings; nested native ingress
// reuses that exact invocation signal instead of starting another timer.
const managedReadLifetimes = new WeakSet<AbortSignal>();

export async function withManagedMachineNativeReadLifetime(
    actionId: ManagedMachineActionIdV1,
    signal: AbortSignal | undefined,
    execute: (signal: AbortSignal | undefined) => Promise<ActionExecuteResult>,
): Promise<ActionExecuteResult> {
    signal?.throwIfAborted();
    if (getActionSpec(actionId).sideEffectClass !== 'read' || signal && managedReadLifetimes.has(signal)) return execute(signal);
    const deadline = new AbortController();
    const lifetime = mergeAbortSignals([signal, deadline.signal]);
    managedReadLifetimes.add(lifetime.signal);
    try {
        // One incumbent read budget covers custody preparation, authorization,
        // dispatch and response decoding; HTTP phases must not restart it.
        return await withTimeout(() => execute(lifetime.signal), DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS, actionId);
    } catch (error) {
        if (error instanceof AsyncTimeoutError) {
            deadline.abort(error);
            return failure('target_unavailable');
        }
        throw error;
    } finally {
        managedReadLifetimes.delete(lifetime.signal);
        lifetime.dispose();
    }
}

async function executeManagedMachineNativeActionWithinLifetime(params: ManagedMachineNativeActionParams): Promise<ActionExecuteResult> {
    const { account, actionId, context } = params;
    account.assertCurrent();
    // The ordinary ingress has no producer for the outer UI approval Artifact's replay custody.
    if (context.bypassApprovals || (context.surface !== 'ui' && context.surface !== 'voice')
        || context.authority !== resolveInvocationAuthority({ credential: 'account', surface: context.surface })) return failure('admission_unavailable');
    if (!account.serverIdentityId || !context.actionRequestId) return failure('admission_unavailable');
    const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
    if (!authentication) return failure('admission_unavailable');
    const parsedInput = ManagedMachineActionInputSchemasV1[actionId].safeParse(params.input);
    if (!parsedInput.success) return failure('invalid_parameters');
    const input = parsedInput.data;
    const review = actionId === 'machines.managed.acquire'
        ? resolveManagedAcquireReviewV1(ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse(input)) : null;
    const homeId = review?.homeId ?? ('homeId' in input ? input.homeId : undefined);
    if (homeId !== account.serverIdentityId) return failure('server_target_mismatch');
    const validateExecution = (execution: ActionExecuteResult): ActionExecuteResult => {
        if (!execution.ok) return execution;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        if (approval.success && approval.data.actionId === actionId) return { ok: true, result: approval.data };
        const output = readManagedMachineActionOutputV1(actionId, execution.result);
        return output.success ? { ok: true, result: output.data } : failure('managed_response_invalid');
    };
    if (actionId === 'machines.environment.apply') {
        const selected = ManagedMachineActionInputSchemasV1['machines.environment.apply'].parse(input);
        return validateExecution(await executeOriginalAccountMachineAction({ account, actionId, input: selected,
            machineId: selected.machineId, requestId: context.actionRequestId, authority: context.authority,
            ...(params.signal ? { signal: params.signal } : {}) }));
    }
    let controller = review?.controller ?? ('controller' in input ? input.controller : undefined);
    const managedId = 'managedId' in input ? input.managedId
        : 'managedMachineId' in input ? input.managedMachineId : undefined;
    let foreignManagedCustody = false;
    if (managedId) {
        let row: ManagedMachineActionOutputV1<'machines.managed.get'>;
        try {
            row = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get', {
                homeId, managedId,
            }, { signal: params.signal });
        } catch (error) {
            if (error instanceof ManagedMachineActionError) return failure(error.code);
            throw error;
        }
        account.assertCurrent();
        if (row.id !== managedId || row.homeId !== homeId) return failure('managed_response_invalid');
        foreignManagedCustody = row.custodianAccountId !== account.accountId;
        // Move is admitted at its selected receiver; other retained operations
        // still execute through the resource's current controller.
        if (actionId !== 'machines.managed.controller.update') controller = row.controller;
    }
    if (!controller) return failure('admission_unavailable');
    const { accountMode, encryption } = await account.resolveAccountEncryption();
    params.signal?.throwIfAborted();
    const target = { kind: 'machine' as const, machineId: controller.machineId };
    const binding: ExternalActionEncryptionBindingV2 = { serverIdentityId: account.serverIdentityId, accountId: account.accountId,
        authentication, actionId, requestId: context.actionRequestId, target };
    let material: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }> | undefined;
    let machineCustody: Parameters<typeof executeOriginalAccountActionTransport>[0]['machineCustody'];
    if (accountMode === 'e2ee' || actionId === 'machines.managed.acquire' || foreignManagedCustody) {
        if (accountMode === 'e2ee' && !encryption) return failure('content_unavailable');
        const row = await readOriginalAccountActionMachine(account, target.machineId, params.signal);
        const access = row?.access;
        const foreignController = access !== undefined && access.custodian.accountId !== account.accountId;
        if (foreignController && row && access) {
            if (!row.installationId || !row.installationPublicKey) return failure('content_unavailable');
            machineCustody = { accountMode, installationId: row.installationId,
                installationPublicKey: row.installationPublicKey, custodian: access.custodian };
        }
        // Own acquisition still proves controller custody; foreign custody has its own exact private carrier.
        if (actionId === 'machines.managed.acquire' && !foreignController
            && row?.access?.custodian.accountId !== account.accountId) return failure('admission_unavailable');
        if (!row || row.kind !== 'persistent' || row.installationId !== controller.installationId
            || row.revokedAt !== null || row.replacedByMachineId !== null
            || (row.access && (row.access.accessState !== 'ready'
                || (!foreignController && row.access.resourceMode !== accountMode)))) return failure('content_unavailable');
        if (encryption) material = { type: 'dataKey', machineKey: encryption.getContentPrivateKey() };
    }
    // Narrow the authenticated Account carrier before the installed daemon's
    // canonical Action policy creates the Ask. Human replay stays with that owner.
    params.signal?.throwIfAborted();
    const execution = await executeOriginalAccountActionTransport({ account, binding, input, authority: context.authority,
        ...(material ? { material } : {}),
        ...(machineCustody ? { machineCustody } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        invalidResponseCode: 'managed_response_invalid', requestFailureCode: 'managed_request_failed' });
    return validateExecution(execution);
}
