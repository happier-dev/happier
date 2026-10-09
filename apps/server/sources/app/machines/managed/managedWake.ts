import {
    ManagedWakeTargetV1Schema, ManagedWakeTargetsReadRequestV1Schema,
    SessionInputAdmissionReceiptV1Schema, createStoredReadSchema,
    type ManagedWakeTargetV1, type ManagedWakeTargetsReadRequestV1,
    type ExternalActionExecutionAuthorizationV1,
    ManagedFiniteWakeRequestV1Schema, MANAGED_FINITE_WAKE_RPC_METHOD, ManagedIntentResultSchema,
    MachineInstallationPublicKeySchema, encodeBase64,
} from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveEffectiveMachineRoleInTx, resolveCurrentMachineRecipientAccountIdsInTx, resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { auth } from '@/app/auth/auth';
import { verifyCurrentExternalActionPrincipalInTx, verifyCurrentExternalActionPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { isCurrentSessionInputMachineTargetInTx, readCurrentCommittedSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { emitAutomationRunUpdatedToMachineOnly } from '@/app/automations/automationChangePublisher';
import { afterTx, inTx, type Tx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { readWorkflowRunOriginWakeCandidatesInTx } from '@/app/workflows/workflowRunAttention';
import { ManagedMachineError, projectManagedMachine, requireManagedControllerInTx, sameManagedInput, type StoredManagedMachine } from './managedRows';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import type { RpcAckResponseEmitter } from '@/app/api/socket/rpc/_types';
import { readMachineDaemonSocketIdentity } from '@/app/machines/machineDaemonPresence';
import { readVerifiedMachineSocketInstallationIdFromSocketData } from '@/app/api/socket/machineSocketInstallationProof';

type FiniteWakePreparation = Readonly<{ kind: 'not-needed' | 'ready'; isCurrent(): Promise<boolean> }>
    | Readonly<{ kind: 'unavailable' | 'submitted-unknown' }>;

/** One original finite root may disclose custody only to its current installed controller. */
export async function readCurrentManagedFiniteWakeCustodyInTx(tx: Tx, input: Readonly<{
    actionOrigin: ExternalActionExecutionAuthorizationV1;
    target?: ManagedWakeTargetV1;
}>): Promise<NonNullable<ExternalActionExecutionAuthorizationV1['managedFiniteWake']> | null> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(input.actionOrigin.token);
    if (!binding || !sameManagedInput(binding, input.actionOrigin.binding)
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId
        || !Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, binding.actionId)
        || await readCurrentServerIdentityId(process.env, tx) !== binding.serverIdentityId) return null;
    const target = input.target ?? await resolveManagedWakeTargetInTx(tx, {
        actorAccountId: binding.accountId, machineId: binding.machineId,
        origin: { kind: 'finite-command', actionRequestId: binding.requestId },
    });
    if (!target) return null;
    const row = await tx.managedMachine.findUnique({ where: { id: target.managedId } });
    if (!row) return null;
    try { await assertManagedWakeOriginCurrentInTx(tx, { row, target, actionOrigin: input.actionOrigin }); }
    catch (error) { if (error instanceof ManagedMachineError) return null; throw error; }
    const controller = await resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId,
        machineId: target.controller.machineId, requiredRole: 'manage', requireOnline: true });
    if (controller.kind !== 'admitted' || controller.installationId !== target.controller.installationId
        || controller.custodianAccountId !== row.custodianAccountId) return null;
    const installed = await tx.machine.findUnique({ where: { id: target.controller.machineId }, select: {
        installationId: true, installationPublicKey: true,
    } });
    if (installed?.installationId !== target.controller.installationId || !installed.installationPublicKey) return null;
    const publicKey = MachineInstallationPublicKeySchema.safeParse(encodeBase64(installed.installationPublicKey, 'base64url'));
    return publicKey.success ? { target, installationPublicKey: publicKey.data } : null;
}

/** The HTTP or verified socket invocation owns this entire wait; no request/content is persisted or replayed. */
export async function prepareManagedFiniteActionWake(input: Readonly<{
    io: Server; actionOrigin: ExternalActionExecutionAuthorizationV1; signal: AbortSignal;
    forwardRpc?: typeof forwardRpcCall;
    isOriginalSourceCurrent?: () => Promise<boolean>;
}>): Promise<FiniteWakePreparation> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(input.actionOrigin.token);
    if (input.signal.aborted || !binding || !sameManagedInput(binding, input.actionOrigin.binding)
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId
        || !Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, binding.actionId)
        || !await verifyCurrentExternalActionPrincipal(binding)) return { kind: 'unavailable' };
    let target: ManagedWakeTargetV1 | undefined;
    const isCurrent = async (): Promise<boolean> => {
        if (input.signal.aborted || !await auth.verifyExternalActionExecutionAuthorization(input.actionOrigin.token)
            || (input.isOriginalSourceCurrent && !await input.isOriginalSourceCurrent())) return false;
        try {
            const current = await inTx(async tx => {
                if (await readCurrentServerIdentityId(process.env, tx) !== binding.serverIdentityId
                    || !await verifyCurrentExternalActionPrincipalInTx(tx, binding)) return false;
                const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId,
                    machineId: binding.machineId, actionId: binding.actionId });
                if (admission.kind !== 'admitted' || admission.installationId !== binding.installationId
                    || admission.custodianAccountId !== binding.custodianAccountId
                    // Original Account-mode currentness is checked by the signed
                    // principal owner; C40 independently admits the resource mode.
                    || binding.accountEncryptionMode === undefined) return false;
                if (target) {
                    const row = await tx.managedMachine.findUnique({ where: { id: target.managedId } });
                    if (!row) return false;
                    await assertManagedWakeOriginCurrentInTx(tx, { row, target, actionOrigin: input.actionOrigin });
                }
                return !input.signal.aborted;
            });
            // The source owner reads current publisher state through its own DB
            // and Socket boundaries; it must not wait on the transaction above.
            return current && !input.signal.aborted
                && (!input.isOriginalSourceCurrent || await input.isOriginalSourceCurrent())
                && !input.signal.aborted;
        } catch (error) { if (error instanceof ManagedMachineError) return false; throw error; }
    };
    if (!await isCurrent()) return { kind: 'unavailable' };
    const initial = await inTx(async tx => {
        const guest = await tx.machine.findUnique({ where: { id: binding.machineId }, select: { active: true } });
        if (guest?.active) return { online: true as const };
        const wake = await resolveManagedWakeTargetInTx(tx, { actorAccountId: binding.accountId, machineId: binding.machineId,
            origin: { kind: 'finite-command', actionRequestId: binding.requestId } });
        return { online: false as const, wake };
    });
    if (initial.online) return { kind: 'not-needed', isCurrent };
    target = initial.wake;
    if (!target || !await isCurrent()) return { kind: 'unavailable' };
    const wakeTarget = target;
    const controller = await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId,
        machineId: wakeTarget.controller.machineId, requiredRole: 'manage', requireOnline: true }));
    if (controller.kind !== 'admitted' || controller.installationId !== wakeTarget.controller.installationId) return { kind: 'unavailable' };
    const exact = (candidate: RpcAckResponseEmitter) =>
        readMachineDaemonSocketIdentity(candidate.data)?.machineId === wakeTarget.controller.machineId
        && readVerifiedMachineSocketInstallationIdFromSocketData(candidate.data) === wakeTarget.controller.installationId;
    let targetSocketId: string | undefined;
    const requestId = `rpc_${randomUUID()}`;
    const cancel = () => { if (targetSocketId) input.io.to(targetSocketId).emit(SOCKET_RPC_EVENTS.CANCEL, { requestId }); };
    input.signal.addEventListener('abort', cancel, { once: true });
    let unknown = false;
    try {
        const result = await (input.forwardRpc ?? forwardRpcCall)({ io: input.io, targetUserId: controller.custodianAccountId,
            method: `${wakeTarget.controller.machineId}:${MANAGED_FINITE_WAKE_RPC_METHOD}`,
            callParams: ManagedFiniteWakeRequestV1Schema.parse({ target: wakeTarget, actionOrigin: input.actionOrigin }),
            authorization: ACTION_API_SERVER_ORIGIN,
            cancellation: { targetRequestId: requestId, signal: input.signal, onTargetSelected: candidate => { targetSocketId = candidate.id; } },
            onSubmittedUnknown: () => { unknown = true; },
            targetGuard: {
                filterTargets: async candidates => await isCurrent() ? candidates.filter(exact) : [],
                runOperation: async ({ target: selected, readLatestTarget, operation }) => {
                    const latest = await readLatestTarget();
                    if (!exact(selected) || !latest || !exact(latest) || !await isCurrent()) return { status: 'unavailable' };
                    return { status: 'current', value: await operation() };
                },
            },
        });
        if (!result.ok) return { kind: unknown ? 'submitted-unknown' : 'unavailable' };
        const failure = ActionExecuteFailureSchema.safeParse(result.result);
        if (failure.success) return { kind: ['outcome_uncertain', 'native_intent_unconfirmed'].includes(failure.data.errorCode)
            ? 'submitted-unknown' : 'unavailable' };
        const output = result.result && typeof result.result === 'object' && 'ok' in result.result && result.result.ok === true
            && 'result' in result.result ? ManagedIntentResultSchema.safeParse(result.result.result) : null;
        if (!output?.success || output.data.kind !== 'accepted' || output.data.managedId !== wakeTarget.managedId) return { kind: 'submitted-unknown' };
        return await isCurrent() ? { kind: 'ready', isCurrent } : { kind: 'unavailable' };
    } catch { return { kind: unknown ? 'submitted-unknown' : 'unavailable' }; }
    finally { input.signal.removeEventListener('abort', cancel); }
}

/** Accepted-origin correlation only. This never admits a power Action or changes desired intent. */
export async function resolveManagedWakeTargetInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; machineId: string; origin: ManagedWakeTargetV1['origin'];
}>): Promise<ManagedWakeTargetV1 | undefined> {
    const homeId = await readCurrentServerIdentityId(process.env, tx);
    if (!homeId) return undefined;
    const row = await tx.managedMachine.findFirst({ where: {
        homeId, enrolledMachineId: input.machineId, archivedAt: null,
        creationState: 'active', allocation: 'bound', wakeOnAcceptedMessage: true,
    } });
    if (!row || row.desired === 'delete' || row.resource === null) return undefined;
    const controller = { machineId: row.controllerMachineId, installationId: row.controllerInstallationId };
    try { await requireManagedControllerInTx(tx, { homeId, custodianAccountId: row.custodianAccountId, controller }); }
    catch (error) { if (error instanceof ManagedMachineError) return undefined; throw error; }
    const guest = await tx.machine.findUnique({ where: { id: input.machineId } });
    if (classifyMachineAvailabilityState(guest) !== 'available'
        || await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: input.actorAccountId, machineId: controller.machineId }) !== 'manage'
        || !await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: input.actorAccountId, machineId: input.machineId })) return undefined;
    let projected;
    try { projected = projectManagedMachine(row); } catch { return undefined; }
    if (projected.observation?.availability === 'absent' || projected.observation?.storage === 'lost') return undefined;
    return ManagedWakeTargetV1Schema.parse({ homeId, managedId: row.id, enrolledMachineId: input.machineId,
        expectedIntentRevision: row.intentRevision, controller, origin: input.origin, reason: 'admitted-work' });
}

/** Real queued assignment is the durable origin; guest claims remain at the incumbent claim owner. */
export async function publishManagedRunWakeInTx(tx: Tx, input: Readonly<{ accountId: string; runId: string; cursor: number }>): Promise<void> {
    const run = await tx.automationRun.findUnique({ where: { id: input.runId }, include: { assignments: true } });
    if (!run || run.accountId !== input.accountId || run.state !== 'queued' || run.claimedByMachineId !== null) return;
    for (const assignment of run.assignments) {
        const target = await resolveManagedWakeTargetInTx(tx, { actorAccountId: input.accountId, machineId: assignment.machineId,
            origin: { kind: 'workflow-assignment', runId: run.id, revision: run.revision, assignment: { machineId: assignment.machineId } } });
        if (target) {
            const controller = await tx.machine.findUniqueOrThrow({ where: { id: target.controller.machineId }, select: { accountId: true } });
            const cursor = controller.accountId === input.accountId ? input.cursor
                : await markAccountChanged(tx, { accountId: controller.accountId, kind: 'machine', entityId: target.controller.machineId });
            afterTx(tx, () => emitAutomationRunUpdatedToMachineOnly({ accountId: controller.accountId,
                machineId: target.controller.machineId, run, cursor, managedWakeTargetV1: target }));
        }
    }
}

/** A cold delivery follows actual Session placement, even when no human input is pending. */
async function resolveSessionContextWakeTargetInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string; runId: string; revision: number;
}>): Promise<ManagedWakeTargetV1 | undefined> {
    const session = await tx.session.findUnique({ where: { id: input.sessionId },
        select: { accountId: true, archivedAt: true, runtimeMachineTarget: true } });
    if (!session || session.accountId !== input.accountId || session.archivedAt !== null) return undefined;
    const committed = await readCurrentCommittedSessionInputMachineTargetInTx(tx, input.sessionId);
    // Before the first publisher commit, an actual accepted input may already
    // hold an exact target. A stale committed placement can never take that path.
    const accepted = session.runtimeMachineTarget == null
        ? await readPendingManagedWakeTargetInTx(tx, input.sessionId) : undefined;
    const machineId = committed?.machineId ?? accepted?.enrolledMachineId;
    const homeId = committed?.homeId ?? accepted?.homeId;
    if (!machineId || !homeId) return undefined;
    const target = await resolveManagedWakeTargetInTx(tx, { actorAccountId: input.accountId, machineId,
        origin: { kind: 'context-delivery', session: { homeId, sessionId: input.sessionId },
            delivery: { runId: input.runId, revision: input.revision } } });
    return target && (!accepted || target.managedId === accepted.managedId) ? target : undefined;
}

/** Committed delivery uses Session placement, never an initial Run assignment guess. */
export async function publishManagedContextWakeInTx(tx: Tx, input: Readonly<{ runId: string; originSessionId: string }>): Promise<void> {
    const [run] = await readWorkflowRunOriginWakeCandidatesInTx(tx, input);
    if (!run) return;
    const target = await resolveSessionContextWakeTargetInTx(tx, { accountId: run.accountId,
        sessionId: input.originSessionId, runId: run.id, revision: run.revision });
    if (!target) return;
    const row = await tx.managedMachine.findUniqueOrThrow({ where: { id: target.managedId } });
    try { await assertManagedWakeOriginCurrentInTx(tx, { row, target }); }
    catch (error) { if (error instanceof ManagedMachineError) return; throw error; }
    const controller = await tx.machine.findUniqueOrThrow({ where: { id: target.controller.machineId }, select: { accountId: true } });
    const cursor = await markAccountChanged(tx, { accountId: controller.accountId, kind: 'machine', entityId: target.controller.machineId });
    afterTx(tx, () => emitAutomationRunUpdatedToMachineOnly({ accountId: controller.accountId,
        machineId: target.controller.machineId, run, cursor, managedWakeTargetV1: target }));
}

/**
 * Native policy admission can advance the row revision. The accepted origin is
 * therefore checked independently of the pre-admission intent revision; the
 * control owner binds that exact target in its admittedInput and checks its CAS.
 */
export async function assertManagedWakeOriginCurrentInTx(tx: Tx, input: Readonly<{
    row: StoredManagedMachine; target: ManagedWakeTargetV1;
    /** Supplied only from the existing verified external Action authority, never request JSON. */
    actionOrigin?: ExternalActionExecutionAuthorizationV1;
    /** Definite native refusal may itself establish unavailable storage. It never authorizes a native effect. */
    allowUnavailableObservation?: true;
}>): Promise<void> {
    const target = ManagedWakeTargetV1Schema.parse(input.target);
    const row = input.row;
    if (row.id !== target.managedId || row.homeId !== target.homeId || row.enrolledMachineId !== target.enrolledMachineId
        || row.controllerMachineId !== target.controller.machineId || row.controllerInstallationId !== target.controller.installationId
        || row.creationState !== 'active' || row.archivedAt !== null || !row.wakeOnAcceptedMessage
        || row.allocation !== 'bound' || row.resource === null || row.desired === 'delete') throw new ManagedMachineError('admission_unavailable');
    await requireManagedControllerInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId, controller: target.controller });
    let projected;
    try { projected = projectManagedMachine(row); } catch { throw new ManagedMachineError('admission_unavailable'); }
    if (!input.allowUnavailableObservation
        && (projected.observation?.availability === 'absent' || projected.observation?.storage === 'lost')) throw new ManagedMachineError('admission_unavailable');
    let actorAccountId: string;
    if (target.origin.kind === 'session-input') {
        const origin = target.origin;
        const session = await tx.session.findUnique({ where: { id: origin.session.sessionId }, select: {
            accountId: true, archivedAt: true, lastActiveAt: true, pendingActivationStatus: true,
            pendingActivationRequestId: true, pendingActivationRequestedAt: true, pendingActivationManagedTarget: true,
        } });
        const retained = createStoredReadSchema(ManagedWakeTargetV1Schema).safeParse(session?.pendingActivationManagedTarget);
        if (!session || session.archivedAt !== null || origin.session.homeId !== row.homeId
            || session.pendingActivationStatus !== 'waiting' || session.pendingActivationRequestId !== origin.pendingRequestId
            || session.pendingActivationRequestedAt?.getTime() !== origin.requestedAt
            || !session.pendingActivationRequestedAt || session.pendingActivationRequestedAt <= session.lastActiveAt
            || !retained.success || !sameManagedInput({ homeId: retained.data.homeId, managedId: retained.data.managedId,
                enrolledMachineId: retained.data.enrolledMachineId, origin: retained.data.origin },
                { homeId: target.homeId, managedId: target.managedId,
                    enrolledMachineId: target.enrolledMachineId, origin: target.origin })) throw new ManagedMachineError('admission_unavailable');
        const pending = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
            sessionId: origin.session.sessionId, localId: origin.pendingRequestId }, targetExecutionRunId: null },
            select: { status: true, messageRole: true, deliveryState: true, providerAction: true, inputAdmissionReceipt: true } });
        const receipt = SessionInputAdmissionReceiptV1Schema.safeParse(pending?.inputAdmissionReceipt);
        if (!pending || pending.status !== 'queued' || pending.messageRole !== 'user' || pending.deliveryState !== null || pending.providerAction !== null
            || !receipt.success || !['authenticatedAccount', 'authenticatedMachine'].includes(receipt.data.issuer)
            || (receipt.data.issuer === 'authenticatedAccount'
                && (receipt.data.actorAccountId !== session.accountId || receipt.data.sessionRelationship !== 'owner'))
            || !receipt.data.admittedTarget || receipt.data.admittedTarget.accountId !== session.accountId
            || receipt.data.admittedTarget.sessionId !== origin.session.sessionId
            || receipt.data.admittedTarget.machineId !== target.enrolledMachineId
            || !await isCurrentSessionInputMachineTargetInTx(tx, receipt.data.admittedTarget)) throw new ManagedMachineError('admission_unavailable');
        actorAccountId = session.accountId;
    } else if (target.origin.kind === 'workflow-assignment') {
        const origin = target.origin;
        const run = await tx.automationRun.findUnique({ where: { id: origin.runId }, select: {
            accountId: true, state: true, revision: true, claimedByMachineId: true, assignments: { select: { machineId: true } },
        } });
        if (!run || run.state !== 'queued' || run.claimedByMachineId !== null || run.revision !== origin.revision
            || origin.assignment.machineId !== row.enrolledMachineId
            || !run.assignments.some(assignment => assignment.machineId === origin.assignment.machineId)) throw new ManagedMachineError('admission_unavailable');
        actorAccountId = run.accountId;
    } else if (target.origin.kind === 'context-delivery') {
        const origin = target.origin;
        if (origin.session.homeId !== row.homeId) throw new ManagedMachineError('admission_unavailable');
        const [run] = await readWorkflowRunOriginWakeCandidatesInTx(tx, { originSessionId: origin.session.sessionId, runId: origin.delivery.runId });
        const current = run ? await resolveSessionContextWakeTargetInTx(tx, { accountId: run.accountId,
            sessionId: origin.session.sessionId, runId: run.id, revision: run.revision }) : undefined;
        if (!current || current.managedId !== target.managedId || current.enrolledMachineId !== target.enrolledMachineId
            || !run || run.revision !== origin.delivery.revision) throw new ManagedMachineError('admission_unavailable');
        actorAccountId = run.accountId;
    } else if (target.origin.kind === 'finite-command') {
        const supplied = input.actionOrigin;
        const binding = supplied ? await auth.verifyExternalActionExecutionAuthorization(supplied.token) : null;
        if (!binding || !sameManagedInput(binding, supplied?.binding)
            || binding.requestId !== target.origin.actionRequestId || binding.serverIdentityId !== row.homeId
            || !Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, binding.actionId)
            || binding.machineId !== target.enrolledMachineId || binding.target.kind !== 'machine'
            || binding.target.machineId !== target.enrolledMachineId
            || !await verifyCurrentExternalActionPrincipalInTx(tx, binding)) throw new ManagedMachineError('admission_unavailable');
        const admitted = await resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId,
            machineId: binding.machineId, actionId: binding.actionId });
        if (admitted.kind !== 'admitted' || admitted.installationId !== binding.installationId
            || admitted.custodianAccountId !== binding.custodianAccountId
            || binding.accountEncryptionMode === undefined) throw new ManagedMachineError('admission_unavailable');
        actorAccountId = binding.accountId;
    } else {
        // A finite Action needs its existing verified authority, never a request-body id.
        throw new ManagedMachineError('admission_unavailable');
    }
    if (await resolveEffectiveMachineRoleInTx(tx, { actorAccountId, machineId: row.controllerMachineId }) !== 'manage'
        || !await resolveEffectiveMachineRoleInTx(tx, { actorAccountId, machineId: target.enrolledMachineId })) throw new ManagedMachineError('permission_denied');
    const guest = await tx.machine.findUnique({ where: { id: target.enrolledMachineId } });
    if (classifyMachineAvailabilityState(guest) !== 'available') throw new ManagedMachineError('enrollment_retired');
}

export async function readPendingManagedWakeTargetInTx(tx: Tx, sessionId: string): Promise<ManagedWakeTargetV1 | undefined> {
    const session = await tx.session.findUnique({ where: { id: sessionId }, select: {
        id: true, accountId: true, lastActiveAt: true, pendingActivationStatus: true,
        pendingActivationRequestId: true, pendingActivationRequestedAt: true, pendingActivationManagedTarget: true,
    } });
    if (!session || session.pendingActivationStatus !== 'waiting') return undefined;
    const stored = createStoredReadSchema(ManagedWakeTargetV1Schema).safeParse(session.pendingActivationManagedTarget);
    if (!stored.success || stored.data.origin.kind !== 'session-input'
        || stored.data.origin.session.sessionId !== session.id
        || stored.data.origin.session.homeId !== stored.data.homeId
        || stored.data.origin.pendingRequestId !== session.pendingActivationRequestId
        || stored.data.origin.requestedAt !== session.pendingActivationRequestedAt?.getTime()
        || !session.pendingActivationRequestedAt || session.pendingActivationRequestedAt <= session.lastActiveAt) return undefined;
    const row = await tx.managedMachine.findUnique({ where: { id: stored.data.managedId } });
    if (!row) return undefined;
    const current = await resolveManagedWakeTargetInTx(tx, { actorAccountId: session.accountId,
        machineId: stored.data.enrolledMachineId, origin: stored.data.origin });
    if (!current || current.managedId !== stored.data.managedId || current.homeId !== stored.data.homeId
        || current.enrolledMachineId !== stored.data.enrolledMachineId) return undefined;
    try { await assertManagedWakeOriginCurrentInTx(tx, { row, target: current }); }
    catch (error) { if (error instanceof ManagedMachineError) return undefined; throw error; }
    return current;
}

/** Reconnect reads existing activation/assignment custody, not a second queue or copied Session content. */
export async function readManagedWakeTargets(input: Readonly<{ actorAccountId: string; request: ManagedWakeTargetsReadRequestV1 }>) {
    const request = ManagedWakeTargetsReadRequestV1Schema.parse(input.request);
    return inTx(async tx => {
        await requireManagedControllerInTx(tx, { ...request, custodianAccountId: input.actorAccountId });
        const managedRows = await tx.managedMachine.findMany({ where: { homeId: request.homeId,
            controllerMachineId: request.controller.machineId, controllerInstallationId: request.controller.installationId,
            custodianAccountId: input.actorAccountId, enrolledMachineId: { not: null }, archivedAt: null,
            creationState: 'active', allocation: 'bound', wakeOnAcceptedMessage: true } });
        const machineIds = managedRows.flatMap(row => row.enrolledMachineId ? [row.enrolledMachineId] : []);
        const targets: ManagedWakeTargetV1[] = [];
        const originAccountIds = await resolveCurrentMachineRecipientAccountIdsInTx(tx, request.controller.machineId);
        const sessions = await tx.session.findMany({ where: { pendingActivationStatus: 'waiting',
            pendingActivationRequestId: { not: null }, accountId: { in: originAccountIds } }, select: { id: true } });
        for (const session of sessions) {
            const current = await readPendingManagedWakeTargetInTx(tx, session.id);
            if (current && current.homeId === request.homeId
                && current.controller.machineId === request.controller.machineId
                && current.controller.installationId === request.controller.installationId) {
                targets.push(current);
            }
        }
        for (const run of await readWorkflowRunOriginWakeCandidatesInTx(tx, { accountIds: originAccountIds })) {
            if (!run.originSessionId) continue;
            const target = await resolveSessionContextWakeTargetInTx(tx, { accountId: run.accountId,
                sessionId: run.originSessionId, runId: run.id, revision: run.revision });
            if (target && target.homeId === request.homeId
                && target.controller.machineId === request.controller.machineId
                && target.controller.installationId === request.controller.installationId) targets.push(target);
        }
        const runs = await tx.automationRun.findMany({ where: { accountId: { in: originAccountIds },
            state: 'queued', claimedByMachineId: null, assignments: { some: { machineId: { in: machineIds } } } },
            select: { id: true, accountId: true, revision: true, assignments: { select: { machineId: true } } } });
        for (const run of runs) for (const assignment of run.assignments) {
            if (!machineIds.includes(assignment.machineId)) continue;
            const target = await resolveManagedWakeTargetInTx(tx, { actorAccountId: run.accountId, machineId: assignment.machineId,
                origin: { kind: 'workflow-assignment', runId: run.id, revision: run.revision, assignment: { machineId: assignment.machineId } } });
            if (target) targets.push(target);
        }
        return { targets };
    });
}
