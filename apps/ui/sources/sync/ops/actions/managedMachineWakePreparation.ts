import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps, HostReviewedChildrenDomainPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import { prepareManagedMachineWakeChildren, type ManagedWakePreparationReads } from '@happier-dev/cli-common/machines/managed';
import { createManagedMachineActionClient, ManagedMachineActionError } from '@/sync/api/machines/managedMachineActions';
import { SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readMachineControlTargetForSessionAuthority } from '@/sync/ops/sessionMachineTarget';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { readOriginalAccountActionMachine } from '@/sync/api/externalActionAccountTransport';
import type { LazyActionAccountContext } from './actionAccountContext';
import { executeUiManagedMachineRuntimeDemand } from './managedMachineWake';
import { readUiManagedProvisioners } from './managedProvisionerAction';
import { preparedSessionMessageTarget, projectSessionMessageTarget, type SessionMessageTargetContext } from './sessionMessageDelivery';
import { openManagedMachineReadSnapshots } from '@/sync/ops/machines/machinePresetCollectionClient';

/** The captured Account supplies exact reads; shared preparation alone decides whether a wake is demanded. */
export async function prepareUiManagedMachineWake(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    account: LazyActionAccountContext | undefined,
): Promise<HostReviewedChildrenDomainPreparationV1> {
    if (!request.machineRuntimeDemand) return null;
    if (!account) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    let facts: ReturnType<typeof projectSessionMessageTarget> | undefined;
    const captureTarget = request.actionId === 'session.message.send' ? (read: SessionTargetRead) => {
        facts = projectSessionMessageTarget(read);
    } : undefined;
    const prepared = await prepareManagedMachineWakeChildren(request, createUiManagedMachineWakeReads(account, captureTarget),
        execution => executeUiManagedMachineRuntimeDemand(execution, account));
    if (!facts || prepared && 'ok' in prepared) return prepared;
    const executeWake = prepared?.executeAdmittedAction;
    // Input-owned wakes happen after delivery. An explicit wake runs before delivery
    // and may change the Session host, so its continuation must resolve fresh facts.
    if (executeWake && prepared?.children.some(child => child.role === 'managed-wake')) return prepared;
    const { serverId, accountId, endpointUrl, credentialAuthorityKind } = account;
    const targetFacts = { facts, serverId, accountId, endpointUrl, credentialAuthorityKind };
    return {
        children: prepared?.children ?? [],
        ...prepared,
        executeAdmittedAction: execution => {
            const execute: typeof execution.execute = (context, target) => {
                const original = !target || target.machineId === targetFacts.facts.machineId
                    && (target.serverId === undefined || target.serverId === serverId);
                const sendContext: SessionMessageTargetContext = original
                    ? { ...context, [preparedSessionMessageTarget]: targetFacts } : context;
                return execution.execute(sendContext, target);
            };
            return executeWake ? executeWake({ ...execution, execute }) : execute(execution.context);
        },
    };
}

type SessionTargetRead = Awaited<ReturnType<typeof readMachineControlTargetForSessionAuthority>>;

/** Preparation resolves the captured Home's exact Session target once. */
export function createUiManagedMachineWakeReads(account: LazyActionAccountContext,
    captureTarget?: (read: SessionTargetRead) => void): ManagedWakePreparationReads {
    return {
        readMachineTarget: async (machineId, context) => {
            try {
                const machine = await getSyncSingleton().ensureMachineInventoryTarget({ serverId: account.serverId, machineId });
                account.assertCurrent();
                let managedMachineRef = machine?.managedMachineRef;
                if (managedMachineRef === undefined) {
                    const target = await readOriginalAccountActionMachine(account, machineId, context.signal);
                    if (!target) return { ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable' };
                    managedMachineRef = target.managedMachineRef;
                }
                account.assertCurrent();
                return { reachable: Boolean(machine && isMachineReachable(account.accountLifetime.scope, machine)),
                    managedMachineRef };
            } catch (error) {
                const code = context.signal?.aborted ? 'cancelled' : 'machine_inventory_unavailable';
                return { ok: false as const, errorCode: code, error: code,
                    failureCause: projectActionFailureCauseV1(error, 'machines.inventory'),
                    ...(code === 'cancelled' ? {} : { details: { remedy: 'retry' as const } }) };
            }
        },
        readSelectedProvisioners: async pluginId => {
            const entries = await readUiManagedProvisioners(account, pluginId);
            return 'ok' in entries ? null : entries;
        },
        readSessionMachineId: async (target, context) => {
            try {
                const read = await runWithServerRequestAuthorityForServerAccountScope({
                    scope: account.accountLifetime.scope, activeRequest: account.request,
                }, authority => readMachineControlTargetForSessionAuthority({ authority, sessionId: target.sessionId,
                    signal: context.signal, isCurrent: account.accountLifetime.isCurrent }));
                account.assertCurrent();
                captureTarget?.(read);
                return read.target?.machineId ?? null;
            } catch (error) {
                const code = context.signal?.aborted ? 'cancelled'
                    : error instanceof SessionSnapshotReadError ? error.errorCode : 'session_target_unavailable';
                return { ok: false as const, errorCode: code, error: code };
            }
        },
        readManagedMachine: async (target, context) => {
            // Only a managed Machine is Home-identity scoped; an ordinary Machine of a Home that
            // publishes no portable identity (a manually added Home) never reaches this read.
            if (!account.serverIdentityId) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
            try {
                const result = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get', target,
                    { signal: context.signal });
                account.assertCurrent();
                const [opened] = await openManagedMachineReadSnapshots(account.accountLifetime.scope, [result], context.signal);
                account.assertCurrent();
                return opened?.launch ? opened
                    : { ok: false as const, errorCode: 'content_unavailable', error: 'content_unavailable' };
            } catch (error) {
                const code = context.signal?.aborted ? 'cancelled'
                    : error instanceof ManagedMachineActionError ? error.code : 'managed_request_failed';
                return { ok: false as const, errorCode: code, error: code };
            }
        },
    };
}
