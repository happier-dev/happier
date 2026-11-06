import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { prepareManagedMachineWakeChildren, type ManagedWakePreparationReads } from '@happier-dev/cli-common/machines/managed';
import { createManagedMachineActionClient, ManagedMachineActionError } from '@/sync/api/machines/managedMachineActions';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { storage } from '@/sync/domains/state/storage';
import { readOriginalAccountActionMachine } from '@/sync/api/externalActionAccountTransport';
import type { LazyActionAccountContext } from './actionAccountContext';
import { executeUiManagedMachineRuntimeDemand } from './managedMachineWake';
import { readUiManagedProvisioners } from './managedProvisionerAction';

/** The captured Account supplies exact reads; shared preparation alone decides whether a wake is demanded. */
export async function prepareUiManagedMachineWake(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    account: LazyActionAccountContext | undefined,
) {
    if (!request.machineRuntimeDemand) return null;
    if (!account?.serverIdentityId) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    return prepareManagedMachineWakeChildren(request, createUiManagedMachineWakeReads(account),
        execution => executeUiManagedMachineRuntimeDemand(execution, account));
}

/** Preparation resolves the captured Home's exact Session target once. */
export function createUiManagedMachineWakeReads(account: LazyActionAccountContext): ManagedWakePreparationReads {
    return {
        readMachineTarget: async (machineId, context) => {
            try {
                const machine = resolveServerScopedMachine(storage.getState(), account.serverId, machineId);
                let managedMachineRef = machine?.managedMachineRef;
                if (managedMachineRef === undefined) {
                    const target = await readOriginalAccountActionMachine(account, machineId, context.signal);
                    if (!target) return { ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable' };
                    managedMachineRef = target.managedMachineRef;
                }
                account.assertCurrent();
                return { reachable: Boolean(machine && isMachineReachable(account.accountLifetime.scope, machine)),
                    managedMachineRef };
            } catch {
                const code = context.signal?.aborted ? 'cancelled' : 'machine_inventory_unavailable';
                return { ok: false as const, errorCode: code, error: code };
            }
        },
        readSelectedProvisioners: async pluginId => {
            const entries = await readUiManagedProvisioners(account, pluginId);
            return 'ok' in entries ? null : entries;
        },
        readSessionMachineId: async (target, context) => {
            try {
                const { session } = await runWithServerRequestAuthorityForServerAccountScope({
                    scope: account.accountLifetime.scope, activeRequest: account.request,
                }, authority => readSessionSnapshotForAuthority({ authority, sessionId: target.sessionId,
                    includeTurns: false, signal: context.signal, isCurrent: account.accountLifetime.isCurrent }));
                account.assertCurrent();
                return resolveMachineControlTargetForSessionFromState({ ...storage.getState(),
                    sessions: { [target.sessionId]: session }, sessionListRowsByServerId: {},
                }, { ...account.accountLifetime.scope, sessionId: target.sessionId })?.machineId ?? null;
            } catch (error) {
                const code = context.signal?.aborted ? 'cancelled'
                    : error instanceof SessionSnapshotReadError ? error.errorCode : 'session_target_unavailable';
                return { ok: false as const, errorCode: code, error: code };
            }
        },
        readManagedMachine: async (target, context) => {
            try {
                const result = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get', target,
                    { signal: context.signal });
                account.assertCurrent();
                return result;
            } catch (error) {
                const code = context.signal?.aborted ? 'cancelled'
                    : error instanceof ManagedMachineActionError ? error.code : 'managed_request_failed';
                return { ok: false as const, errorCode: code, error: code };
            }
        },
    };
}
