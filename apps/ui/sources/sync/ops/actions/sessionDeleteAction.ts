import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { completeOfflineSessionDelete } from '@happier-dev/protocol/actions/executor/session/delete';
import { createUiAccountAction, resolveUiAccountActionReceiverMachineId } from './accountActionDeps';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

/** Resolve the Session once; known-offline Machines leave their managed files in Storage. */
export function createUiSessionDeleteAction(account: LazyActionAccountContext | undefined): NonNullable<ActionExecutorDeps['sessionDelete']> {
    const execute = account ? createUiAccountAction({ account }) : null;
    return async ({ input, context, deleteFromHome }) => {
        if (!account || !execute) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        return withActionAccountRequestSignal(account, context.signal, async signal => {
            account.assertCurrent();
            let snapshot: Awaited<ReturnType<typeof readSessionSnapshotForAuthority>>;
            try {
                snapshot = await runWithServerRequestAuthorityForServerAccountScope({
                    scope: account.accountLifetime.scope, activeRequest: account.request,
                }, authority => readSessionSnapshotForAuthority({ authority, sessionId: input.sessionId,
                    includeTurns: false, signal, isCurrent: account.accountLifetime.isCurrent }));
            } catch (error) {
                // Only an observed absence can take the Home-only idempotent path.
                if (error instanceof SessionSnapshotReadError && error.httpStatus === 404) return deleteFromHome();
                if (error instanceof SessionSnapshotReadError) return { ok: false, errorCode: error.errorCode, error: error.errorCode };
                throw error;
            }
            account.assertCurrent();
            const metadata = readSessionOwnerMetadataView(snapshot.session);
            if (!metadata) return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
            const machineId = resolveSessionMachineId(metadata);
            // Imported histories without a native Machine have no managed-directory owner.
            if (!machineId) return deleteFromHome();
            const target = context.externalActionTarget;
            if (target && (target.kind !== 'machine' || target.machineId !== machineId)) {
                return { ok: false, errorCode: 'machine_target_mismatch', error: 'machine_target_mismatch' };
            }
            const args = { actionId: 'session.delete' as const, input, context: { ...context,
                serverId: account.serverId, runtimeAccountId: account.accountId,
                externalActionTarget: { kind: 'machine' as const, machineId }, signal } };
            const receiver = await resolveUiAccountActionReceiverMachineId(account, args);
            if (typeof receiver !== 'string') {
                return receiver.errorCode === 'machine_unreachable'
                    ? completeOfflineSessionDelete(await deleteFromHome(), machineId, metadata) : receiver;
            }
            return execute(args);
        });
    };
}
