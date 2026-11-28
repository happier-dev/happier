import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps, HostReviewedChildrenDomainPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import { prepareManagedMachineWakeChildren, type ManagedWakePreparationReads } from '@happier-dev/cli-common/machines/managed';
import { createManagedMachineActionClient, ManagedMachineActionError } from '@/sync/api/machines/managedMachineActions';
import { SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readMachineControlTargetForSessionAuthority } from '@/sync/ops/sessionMachineTarget';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { readActionMachineAtHome } from '@/sync/api/externalActionAccountTransport';
import type { LazyActionAccountContext } from './actionAccountContext';
import { executeUiManagedMachineRuntimeDemand } from './managedMachineWake';
import { readUiManagedProvisioners } from './managedProvisionerAction';
import { preparedSessionMessageTarget, projectSessionMessageTarget, type SessionMessageTargetContext } from './sessionMessageDelivery';
import { openManagedMachineReadSnapshots } from '@/sync/ops/machines/machinePresetCollectionClient';

/** The captured Account supplies exact reads; shared preparation alone decides whether a wake is demanded. */
export async function prepareUiManagedMachineWake(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    account: LazyActionAccountContext | undefined,
    composerSend = false,
): Promise<HostReviewedChildrenDomainPreparationV1> {
    if (!request.machineRuntimeDemand) return null;
    // The installed controller prepares retained native wake in the signed
    // receiver. The app only prepares operations that need an enrolled daemon.
    if (request.machineRuntimeDemand.target.kind === 'managed-machine') return null;
    if (!account) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    let facts: ReturnType<typeof projectSessionMessageTarget> | undefined;
    const captureTarget = request.actionId === 'session.message.send' ? (read: SessionTargetRead) => {
        facts = projectSessionMessageTarget(read);
    } : undefined;
    let hiddenMachineId: string | undefined;
    const stoppedSendVisibility = composerSend && captureTarget && request.context.surface === 'ui' && request.approvalReplay !== true
        && request.machineRuntimeDemand.activation === 'accepted-input'
        ? {
            applies: () => facts?.stopped === true && !facts.archived && !facts.isRecipient,
            captureHidden: (machineId: string) => { hiddenMachineId = machineId; },
        } : undefined;
    const result = await prepareManagedMachineWakeChildren(request,
        createUiManagedMachineWakeReads(account, captureTarget, stoppedSendVisibility),
        execution => executeUiManagedMachineRuntimeDemand(execution, account));
    const hiddenByHome = hiddenMachineId !== undefined && hiddenMachineId === facts?.machineId;
    if (!facts || result && 'ok' in result && !hiddenByHome) return result;
    // An exact inventory miss cannot distinguish withdrawal. Send may ask Home's
    // existing input admission owner using the retained Session target.
    const prepared = result && !('ok' in result) ? result : null;
    const executeWake = prepared?.executeAdmittedAction;
    // Input-owned wakes happen after delivery. An explicit wake runs before delivery
    // and may change the Session host, so its continuation must resolve fresh facts.
    if (executeWake && prepared?.children.some(child => child.role === 'managed-wake')) return prepared;
    const { serverId, accountId, endpointUrl, credentialAuthorityKind } = account;
    const targetFacts = { facts, serverId, accountId, endpointUrl, credentialAuthorityKind, hiddenByHome };
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
    captureTarget?: (read: SessionTargetRead) => void,
    stoppedSendVisibility?: Readonly<{ applies: () => boolean; captureHidden: (machineId: string) => void }>,
): ManagedWakePreparationReads {
    return {
        readMachineTarget: async (machineId, context) => {
            try {
                const machine = await getSyncSingleton().ensureMachineInventoryTarget({ serverId: account.serverId, machineId });
                account.assertCurrent();
                let managedMachineRef = machine?.managedMachineRef;
                const checkStoppedSendVisibility = stoppedSendVisibility?.applies() === true;
                if (managedMachineRef === undefined || checkStoppedSendVisibility) {
                    const { row, notFound } = await readActionMachineAtHome(account, machineId, context.signal);
                    if (!row) {
                        if (notFound && checkStoppedSendVisibility) stoppedSendVisibility?.captureHidden(machineId);
                        return { ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable' };
                    }
                    managedMachineRef = row.managedMachineRef;
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
        readSelectedProvisioners: pluginId => readUiManagedProvisioners(account, pluginId),
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
                return opened ?? null;
            } catch (error) {
                const code = context.signal?.aborted ? 'cancelled'
                    : error instanceof ManagedMachineActionError ? error.code : 'managed_request_failed';
                return { ok: false as const, errorCode: code, error: code };
            }
        },
    };
}
