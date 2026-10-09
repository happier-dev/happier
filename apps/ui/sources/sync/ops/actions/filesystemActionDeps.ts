import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { FilesystemCopyInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import type { LazyActionAccountContext } from './actionAccountContext';

export function resolveUiFilesystemTransferCustodyFailure(actionId: string, input?: unknown) {
    const copy = actionId === 'daemon.filesystem.copy' ? FilesystemCopyInputSchema.safeParse(input) : null;
    const missingEntryReceipt = copy?.success && 'kind' in copy.data && copy.data.kind === 'prepared_transfer' && copy.data.source.kind === 'entry_tree';
    if (actionId !== 'daemon.filesystem.upload' && actionId !== 'daemon.filesystem.download' && !missingEntryReceipt) return null;
    return { ok: false as const, errorCode: 'filesystem_transfer_custody_required',
        error: 'A prepared source reader or download destination is required.' };
}

/** Action admission owns the request; the machine filesystem owns all effects. */
export function createUiFilesystemAction(account?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['filesystemActionExecute']> {
    return async ({ actionId, input, context }) => {
        context.signal?.throwIfAborted();
        account?.assertCurrent();
        const target = context.externalActionTarget;
        if (target?.kind !== 'machine' || !target.machineId.trim()) return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
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
                const [{ resolveMachineCarrierRoute }, { copyPreparedFilesystemFile }, { captureLazyActionAccountContext }] = await Promise.all([
                    import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease'),
                    import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/preparedFilesystemCopy'),
                    import('./actionAccountContext'),
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
        const result = await callGuardedMachineRpcWithPolicy<unknown, unknown>({
            machineId: target.machineId, serverId: account?.serverId ?? context.serverId,
            accountId: account?.accountId ?? context.runtimeAccountId, method, payload: input, signal: context.signal,
        });
        account?.assertResultCurrent(spec.sideEffectClass);
        return result;
    };
}
