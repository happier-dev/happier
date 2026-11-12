import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { FilesystemCopyInputSchema, FilesystemWriteFileInputSchema, FilesystemWriteFileOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import { captureLazyActionAccountContext, withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import type { FilesystemActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { acknowledgeWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';

type FilesystemActionExecution = Parameters<NonNullable<ActionExecutorDeps['filesystemActionExecute']>>[0];

/** The transport leaf shared by ordinary reads and mounted byte delivery. */
export async function callAdmittedFilesystemActionRpc(params: Readonly<{
    actionId: FilesystemActionId;
    machineId: string;
    serverId?: string | null;
    accountId?: string;
    input: unknown;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
    requestId?: string;
    context?: FilesystemActionExecution['context'];
}>): Promise<unknown> {
    if (params.context) {
        const serverId = params.serverId ?? params.context.serverId;
        if (!serverId) return { ok: false, errorCode: 'action_home_not_found', error: 'action_home_not_found' };
        const account = await captureLazyActionAccountContext(serverId, params.signal ?? params.context.signal ?? undefined);
        try {
            const original = await executeOriginalAccountFilesystemAction(account, {
                actionId: params.actionId, input: params.input, context: { ...params.context,
                    serverId, runtimeAccountId: params.accountId ?? params.context.runtimeAccountId,
                    actionRequestId: params.requestId ?? params.context.actionRequestId,
                    externalActionTarget: { kind: 'machine', machineId: params.machineId },
                    signal: params.signal ?? params.context.signal,
                },
            }, typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined);
            if (original) return original.ok ? original.result : original;
        } finally { account.dispose(); }
    }
    const method = getActionSpec(params.actionId).bindings?.rpcMethod;
    if (!method) throw new Error('Filesystem Action RPC binding is unavailable');
    return await callGuardedMachineRpcWithPolicy({ machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        accountId: params.accountId, requestId: params.requestId, method,
        payload: createTargetedActionRpcRequestV1(params.input, { kind: 'machine', machineId: params.machineId }),
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.actionId !== 'daemon.filesystem.transfer.cancel' ? { operationTimeoutMs: null } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/** Preserve the admitted app invocation through the existing authenticated Account carrier. */
export async function executeOriginalAccountFilesystemAction(
    account: LazyActionAccountContext | undefined,
    { actionId, input, context }: FilesystemActionExecution,
    timeoutMs?: number,
): Promise<ActionExecuteResult | null> {
    if (context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization
        || context.actionCaller && context.actionCaller.kind !== 'host') {
        return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    }
    if (!account || account.credentialAuthorityKind !== 'account') return null;
    account.assertCurrent();
    const target = context.externalActionTarget;
    const requestId = context.actionRequestId;
    if (target?.kind !== 'machine' || !requestId
        || context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, account.serverId)
        || context.runtimeAccountId && context.runtimeAccountId !== account.accountId) {
        return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    }
    const invocation = projectExternalActionRequesterInvocationV1({ actionId, account, target,
        context: { ...context, actionCaller: context.actionCaller ?? { kind: 'host' },
            surface: context.surface ?? 'rpc', authority: context.authority ?? 'account_automation' } });
    if (!invocation) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    const result = await withActionAccountRequestSignal(account, context.signal, signal => executeOriginalAccountMachineAction({
        account, actionId, input, machineId: target.machineId, machineTarget: target,
        requestId, authority: invocation.authority, invocation,
        ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(signal ? { signal } : {}),
    }));
    account.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
    return result;
}

/** Private mounted byte delivery; never serialized into Action input or approval custody. */
export type UiFilesystemActionDelivery = Readonly<{
    actionId: FilesystemActionId;
    signal: AbortSignal;
    execute: NonNullable<ActionExecutorDeps['filesystemActionExecute']>;
}>;

export function resolveUiFilesystemTransferCustodyFailure(actionId: string, input?: unknown) {
    const copy = actionId === 'daemon.filesystem.copy' ? FilesystemCopyInputSchema.safeParse(input) : null;
    const missingEntryReceipt = copy?.success && 'kind' in copy.data && copy.data.kind === 'prepared_transfer' && copy.data.source.kind === 'entry_tree';
    if (actionId !== 'daemon.filesystem.upload' && actionId !== 'daemon.filesystem.download' && !missingEntryReceipt) return null;
    return { ok: false as const, errorCode: 'filesystem_transfer_custody_required',
        error: 'A prepared source reader or download destination is required.' };
}

/** Action admission owns the request; the machine filesystem owns all effects. */
export function createUiFilesystemAction(account?: LazyActionAccountContext, delivery?: UiFilesystemActionDelivery): NonNullable<ActionExecutorDeps['filesystemActionExecute']> {
    return async ({ actionId, input, context }) => {
        context.signal?.throwIfAborted();
        account?.assertCurrent();
        const target = context.externalActionTarget;
        if (target?.kind !== 'machine' || !target.machineId.trim()) return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
        const acknowledgeWrite = (result: unknown) => {
            if (actionId !== 'daemon.filesystem.writeFile' || account?.accountOnlyLifetime.isCurrent() === false) return;
            const source = createServerAccountScope(account?.serverId ?? context.serverId, account?.accountId ?? context.runtimeAccountId);
            const request = FilesystemWriteFileInputSchema.safeParse(input);
            const response = FilesystemWriteFileOutputSchema.safeParse(result);
            if (source && request.success && response.success && response.data.success) {
                acknowledgeWorkspaceFileWrites({ ...source, machineId: target.machineId, rootPath: request.data.rootPath },
                    [{ path: request.data.path, hash: response.data.hash }]);
            }
        };
        if (delivery?.actionId === actionId && context.signal === delivery.signal) {
            const result = await delivery.execute({ actionId, input, context });
            account?.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
            acknowledgeWrite(result);
            return result;
        }
        // The workspace transfer family owns the real reader/destination and
        // drives the accepted prepared operation. A generic JSON invocation
        // cannot manufacture that custody from a caller-chosen identifier.
        const custodyFailure = resolveUiFilesystemTransferCustodyFailure(actionId, input);
        if (custodyFailure) return custodyFailure;
        const spec = getActionSpec(actionId);
        if (actionId === 'daemon.filesystem.copy') {
            const parsed = FilesystemCopyInputSchema.safeParse(input);
            if (!parsed.success) return { ok: false, errorCode: 'invalid_input', error: 'Invalid copy input' };
            if ('kind' in parsed.data) {
                const copy = parsed.data;
                const serverId = account?.serverId ?? context.serverId;
                if (copy.destination.serverId !== serverId || copy.destination.machineId !== target.machineId) {
                    return { ok: false, errorCode: 'target_unavailable', error: 'Copy destination differs from the admitted target' };
                }
                if (!account) return { ok: false, errorCode: 'target_unavailable', error: 'Copy requires captured Account custody' };
                const [{ captureLazyActionAccountContext }, { callAdmittedFilesystemTransferActionRpc, resolveMachineCarrierRoute, copyPreparedFilesystemFile }] = await Promise.all([
                    import('./actionAccountContext'),
                    import('@/sync/domains/transfers/runtime/transferRuntime'),
                ]);
                const sourceAccount = copy.source.serverId === account.serverId ? account
                    : await captureLazyActionAccountContext(copy.source.serverId, context.signal);
                try {
                    const [sourceRoute, destinationRoute] = await Promise.all([
                        resolveMachineCarrierRoute(copy.source.machineId, copy.source.serverId),
                        resolveMachineCarrierRoute(copy.destination.machineId, copy.destination.serverId),
                    ]);
                    account.assertCurrent();
                    sourceAccount.assertCurrent();
                    context.signal?.throwIfAborted();
                    if (sourceRoute.kind === 'unavailable') return { ok: false, errorCode: sourceRoute.errorCode, error: sourceRoute.error };
                    if (destinationRoute.kind === 'unavailable') return { ok: false, errorCode: destinationRoute.errorCode, error: destinationRoute.error };
                    // Both exact Home/Account routes are captured before either
                    // endpoint admits bytes; approval cannot reselect a requester.
                    const result = await copyPreparedFilesystemFile({ input: copy, sourceAccount, destinationAccount: account,
                        callAdmittedAction: params => callAdmittedFilesystemTransferActionRpc({ ...params, context, requestId: context.actionRequestId ?? undefined }),
                        acquireSourceCarrier: sourceRoute.acquire, acquireDestinationCarrier: destinationRoute.acquire,
                        signal: context.signal });
                    account.assertResultCurrent(spec.sideEffectClass);
                    return result.success ? result : { ok: false, errorCode: result.errorCode ?? 'filesystem_copy_failed', error: result.error };
                } finally {
                    if (sourceAccount !== account) sourceAccount.dispose();
                }
            }
        }
        const method = spec.bindings?.rpcMethod;
        if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        const original = await executeOriginalAccountFilesystemAction(account, { actionId, input, context });
        if (original) {
            const result = original.ok ? original.result : original;
            acknowledgeWrite(result);
            return result;
        }
        const result = await withActionAccountRequestSignal(account, context.signal, signal => callGuardedMachineRpcWithPolicy<unknown, unknown>({
            machineId: target.machineId, serverId: account?.serverId ?? context.serverId,
            accountId: account?.accountId ?? context.runtimeAccountId, method, payload: input, signal,
            requestId: context.actionRequestId ?? undefined,
        }));
        account?.assertResultCurrent(spec.sideEffectClass);
        acknowledgeWrite(result);
        return result;
    };
}
