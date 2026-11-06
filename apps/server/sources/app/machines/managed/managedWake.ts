import { ManagedWakeTargetV1Schema, ManagedWakeTargetsReadRequestV1Schema, type ManagedWakeTargetV1, type ManagedWakeTargetsReadRequestV1, ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { isExternalActionManagedWakeRootV1, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedFiniteWakeRequestV1Schema, MANAGED_FINITE_WAKE_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { MachineInstallationPublicKeySchema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
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
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { markAccountChanged, type AccountChangePublication } from '@/app/changes/markAccountChanged';
import { readWorkflowRunOriginWakeCandidatesInTx } from '@/app/workflows/workflowRunAttention';
import { ManagedMachineError, projectManagedMachine, requireManagedControllerInTx, sameManagedInput, readManagedController, resolveManagedMachineRoleInTx, type StoredManagedMachine } from './managedRows';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import type { RpcAckResponseEmitter } from '@/app/api/socket/rpc/_types';
import { readMachineDaemonSocketIdentity } from '@/app/machines/machineDaemonPresence';
import { readVerifiedMachineSocketInstallationIdFromSocketData } from '@/app/api/socket/machineSocketInstallationProof';
import type { PendingActivationHoldReasonV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { readPendingSessionInputAdmission } from '@/app/session/pending/pendingInputAdmission';
import { isManagedMachineWakeInspectionRequiredV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { isMachineReachableV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { serializeMachinePresence } from '@/app/machines/machineSerialization';

type FiniteWakePreparation = Readonly<{ kind: 'not-needed' | 'ready'; isCurrent(): Promise<boolean> }>
    | Readonly<{ kind: 'unavailable' | 'submitted-unknown' }>;

/** One original finite root may disclose custody only to its current installed controller. */
export async function readCurrentManagedFiniteWakeCustodyInTx(tx: Tx, input: Readonly<{
    actionOrigin: ExternalActionExecutionAuthorizationV1;
    target?: ManagedWakeTargetV1;
}>): Promise<NonNullable<ExternalActionExecutionAuthorizationV1['managedFiniteWake']> | null> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(input.actionOrigin.token);
    if (!binding || !sameManagedInput(binding, input.actionOrigin.binding)
        || !isExternalActionManagedWakeRootV1(binding)
        || await readCurrentServerIdentityId(process.env, tx) !== binding.serverIdentityId) return null;
    const target = input.target ?? await resolveManagedWakeTargetInTx(tx, {
        actorAccountId: binding.accountId, machineId: binding.machineId,
        origin: { kind: 'finite-command', actionRequestId: binding.requestId },
    });
    if (!target?.controller) return null;
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
        || !isExternalActionManagedWakeRootV1(binding)
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
        const guest = await tx.machine.findUnique({ where: { id: binding.machineId }, select: { active: true, lastActiveAt: true } });
        if (guest && isMachineReachableV1({ machine: serializeMachinePresence(guest) })) return { online: true as const };
        const wake = await resolveManagedWakeTargetInTx(tx, { actorAccountId: binding.accountId, machineId: binding.machineId,
            origin: { kind: 'finite-command', actionRequestId: binding.requestId }, requireInspection: true });
        return { online: false as const, wake };
    });
    if (initial.online) return { kind: 'not-needed', isCurrent };
    target = initial.wake;
    if (!target?.controller || !await isCurrent()) return { kind: 'unavailable' };
    const wakeTarget = target;
    const controllerBinding = target.controller;
    const controller = await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId,
        machineId: controllerBinding.machineId, requiredRole: 'manage', requireOnline: true }));
    if (controller.kind !== 'admitted' || controller.installationId !== controllerBinding.installationId) return { kind: 'unavailable' };
    const exact = (candidate: RpcAckResponseEmitter) =>
        readMachineDaemonSocketIdentity(candidate.data)?.machineId === controllerBinding.machineId
        && readVerifiedMachineSocketInstallationIdFromSocketData(candidate.data) === controllerBinding.installationId;
    let targetSocketId: string | undefined;
    const requestId = `rpc_${randomUUID()}`;
    const cancel = () => { if (targetSocketId) input.io.to(targetSocketId).emit(SOCKET_RPC_EVENTS.CANCEL, { requestId }); };
    input.signal.addEventListener('abort', cancel, { once: true });
    let unknown = false;
    try {
        const result = await (input.forwardRpc ?? forwardRpcCall)({ io: input.io, targetUserId: controller.custodianAccountId,
            method: `${controllerBinding.machineId}:${MANAGED_FINITE_WAKE_RPC_METHOD}`,
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
async function readManagedWakeTargetBindingInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; machineId: string;
}>) {
    const homeId = await readCurrentServerIdentityId(process.env, tx);
    if (!homeId) return undefined;
    const row = await tx.managedMachine.findFirst({ where: {
        homeId, enrolledMachineId: input.machineId, archivedAt: null,
        creationState: 'active', allocation: 'bound', wakeOnAcceptedMessage: true,
    } });
    if (!row || row.desired === 'delete' || row.resource === null) return undefined;
    const controller = readManagedController(row);
    try { await requireManagedControllerInTx(tx, { homeId, custodianAccountId: row.custodianAccountId, controller }); }
    catch (error) { if (error instanceof ManagedMachineError) return undefined; throw error; }
    const guest = await tx.machine.findUnique({ where: { id: input.machineId } });
    if (classifyMachineAvailabilityState(guest) !== 'available'
        || !await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: input.actorAccountId, machineId: input.machineId })) return undefined;
    const controllerRole = await resolveManagedMachineRoleInTx(tx, row, input.actorAccountId);
    let projected;
    try { projected = projectManagedMachine(row); } catch { return undefined; }
    if (projected.observation?.availability === 'absent' || projected.observation?.storage === 'lost') return undefined;
    return { binding: { homeId, managedId: row.id, enrolledMachineId: input.machineId,
        expectedIntentRevision: row.intentRevision, controller, reason: 'admitted-work' as const }, controllerRole,
        wakeOnAcceptedMessage: row.wakeOnAcceptedMessage,
        inspectionRequired: isManagedMachineWakeInspectionRequiredV1(projected, input.machineId,
            guest !== null && isMachineReachableV1({ machine: serializeMachinePresence(guest) })) };
}

export async function resolveManagedWakeTargetInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; machineId: string; origin: ManagedWakeTargetV1['origin'];
    requireAcceptedInputWake?: boolean;
    requireInspection?: boolean;
}>): Promise<ManagedWakeTargetV1 | undefined> {
    const binding = await readManagedWakeTargetBindingInTx(tx, input);
    if (input.requireInspection && !binding?.inspectionRequired) return undefined;
    if (input.requireAcceptedInputWake && !(binding?.inspectionRequired && binding.wakeOnAcceptedMessage)) return undefined;
    return binding?.controllerRole === 'manage' ? ManagedWakeTargetV1Schema.parse({ ...binding.binding, origin: input.origin }) : undefined;
}

/** Same binding and power-role owner as wake admission; this read cannot arm or start anything. */
export async function readManagedPendingActivationHoldReasonInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; machineId: string; homeId: string; resumeRequested: boolean;
}>): Promise<PendingActivationHoldReasonV1 | undefined> {
    const current = await readManagedWakeTargetBindingInTx(tx, input);
    if (!current?.inspectionRequired || current.binding.homeId !== input.homeId) return undefined;
    if (current.controllerRole !== 'manage') return 'managed_power_required';
    return input.resumeRequested ? undefined : 'resume_not_requested';
}

/** Real queued assignment is the durable origin; guest claims remain at the incumbent claim owner. */
export async function publishManagedRunWakeInTx(tx: Tx, input: Readonly<{ accountId: string; runId: string; cursor: AccountChangePublication }>): Promise<void> {
    const run = await tx.automationRun.findUnique({ where: { id: input.runId }, include: { assignments: true } });
    if (!run || run.accountId !== input.accountId || run.state !== 'queued' || run.claimedByMachineId !== null) return;
    for (const assignment of run.assignments) {
        const target = await resolveManagedWakeTargetInTx(tx, { actorAccountId: input.accountId, machineId: assignment.machineId,
            origin: { kind: 'workflow-assignment', runId: run.id, revision: run.revision, assignment: { machineId: assignment.machineId } } });
        if (target && !target.controller) {
            await markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: target.managedId,
                hint: { managedMachinePolicy: true } });
        }
        if (target?.controller) {
            const controllerBinding = target.controller;
            const controller = await tx.machine.findUniqueOrThrow({ where: { id: controllerBinding.machineId }, select: { accountId: true } });
            const cursor = controller.accountId === input.accountId ? input.cursor
                : await markAccountChanged(tx, { accountId: controller.accountId, kind: 'machine', entityId: controllerBinding.machineId });
            afterTx(tx, () => emitAutomationRunUpdatedToMachineOnly({ accountId: controller.accountId,
                machineId: controllerBinding.machineId, run, cursor: cursor.resolveCursor(), managedWakeTargetV1: target }));
        }
    }
}

/** A cold delivery follows actual Session placement, even when no human input is pending. */
async function readSessionContextWakePlacementInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string;
}>) {
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
    return { machineId, homeId, accepted };
}

async function resolveSessionContextWakeTargetInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string; runId: string; revision: number;
}>): Promise<ManagedWakeTargetV1 | undefined> {
    const placement = await readSessionContextWakePlacementInTx(tx, input);
    if (!placement) return undefined;
    const { machineId, homeId, accepted } = placement;
    const target = await resolveManagedWakeTargetInTx(tx, { actorAccountId: input.accountId, machineId,
        origin: { kind: 'context-delivery', session: { homeId, sessionId: input.sessionId },
            delivery: { runId: input.runId, revision: input.revision } } });
    return target && (!accepted || target.managedId === accepted.managedId) ? target : undefined;
}

/** Acquisition projects the same eligible wake binding without admitting or publishing work. */
export async function readManagedWakePublicationAccountIdsInTx(tx: Tx, input: Readonly<{
    machineTargets: readonly Readonly<{ accountId: string; machineId: string }>[];
    sessionIds: readonly string[];
}>): Promise<string[]> {
    const targets = new Map(input.machineTargets.map(target => [JSON.stringify(target), target]));
    const sessions: { id: string; accountId: string }[] = [];
    for (const ids of portableQueryChunks({ values: [...new Set(input.sessionIds)], bindingsPerValue: 1, fixedBindings: 1 })) {
        sessions.push(...await tx.session.findMany({
            where: { id: { in: [...ids] } }, select: { id: true, accountId: true },
        }));
    }
    for (const session of sessions) {
        const placement = await readSessionContextWakePlacementInTx(tx, { accountId: session.accountId, sessionId: session.id });
        if (placement) {
            const target = { accountId: session.accountId, machineId: placement.machineId };
            targets.set(JSON.stringify(target), target);
        }
    }
    // Enrollment admits only a guest owned by its custodian. Taking that existing
    // authority also prevents an enrollment committed during acquisition from
    // introducing a previously absent custodian into the later publication.
    const accountIds = new Set<string>();
    const machineIds = [...new Set([...targets.values()].map(target => target.machineId))];
    for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        const machines = await tx.machine.findMany({
            where: { id: { in: [...ids] } }, select: { accountId: true },
        });
        for (const machine of machines) accountIds.add(machine.accountId);
    }
    for (const target of targets.values()) {
        const current = await readManagedWakeTargetBindingInTx(tx, { actorAccountId: target.accountId, machineId: target.machineId });
        if (current?.controllerRole !== 'manage') continue;
        const binding = current.binding;
        if (!binding.controller) continue;
        const controller = await tx.machine.findUnique({ where: { id: binding.controller.machineId }, select: { accountId: true } });
        if (controller) accountIds.add(controller.accountId);
    }
    return [...accountIds].sort();
}

/** Committed delivery uses Session placement, never an initial Run assignment guess. */
export async function publishManagedContextWakeInTx(tx: Tx, input: Readonly<{ runId: string; originSessionId: string }>): Promise<void> {
    const [run] = await readWorkflowRunOriginWakeCandidatesInTx(tx, input);
    if (!run) return;
    const target = await resolveSessionContextWakeTargetInTx(tx, { accountId: run.accountId,
        sessionId: input.originSessionId, runId: run.id, revision: run.revision });
    if (!target) return;
    if (!target.controller) {
        await markAccountChanged(tx, { accountId: run.accountId, kind: 'account', entityId: target.managedId,
            hint: { managedMachinePolicy: true } });
        return;
    }
    const controllerBinding = target.controller;
    const row = await tx.managedMachine.findUniqueOrThrow({ where: { id: target.managedId } });
    try { await assertManagedWakeOriginCurrentInTx(tx, { row, target }); }
    catch (error) { if (error instanceof ManagedMachineError) return; throw error; }
    const controller = await tx.machine.findUniqueOrThrow({ where: { id: controllerBinding.machineId }, select: { accountId: true } });
    const cursor = await markAccountChanged(tx, { accountId: controller.accountId, kind: 'machine', entityId: controllerBinding.machineId });
    afterTx(tx, () => emitAutomationRunUpdatedToMachineOnly({ accountId: controller.accountId,
        machineId: controllerBinding.machineId, run, cursor: cursor.resolveCursor(), managedWakeTargetV1: target }));
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
        || !sameManagedInput(readManagedController(row), target.controller)
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
            || !session.pendingActivationRequestedAt
            || !retained.success || !sameManagedInput({ homeId: retained.data.homeId, managedId: retained.data.managedId,
                enrolledMachineId: retained.data.enrolledMachineId, origin: retained.data.origin },
                { homeId: target.homeId, managedId: target.managedId,
                    enrolledMachineId: target.enrolledMachineId, origin: target.origin })) throw new ManagedMachineError('admission_unavailable');
        const pending = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
            sessionId: origin.session.sessionId, localId: origin.pendingRequestId }, targetExecutionRunId: null },
            select: { status: true, messageRole: true, authorAccountId: true, deliveryState: true, providerAction: true, inputAdmissionReceipt: true } });
        const receipt = pending ? readPendingSessionInputAdmission({ sessionId: origin.session.sessionId,
            accountId: session.accountId, pending }) : undefined;
        if (!pending || pending.status !== 'queued' || pending.messageRole !== 'user' || pending.deliveryState !== null || pending.providerAction !== null
            || !receipt?.admittedTarget || receipt.admittedTarget.machineId !== target.enrolledMachineId
            || !await isCurrentSessionInputMachineTargetInTx(tx, receipt.admittedTarget)) throw new ManagedMachineError('admission_unavailable');
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
            || !isExternalActionManagedWakeRootV1(binding)
            || binding.machineId !== target.enrolledMachineId
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
    if (await resolveManagedMachineRoleInTx(tx, row, actorAccountId) !== 'manage'
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
        || !session.pendingActivationRequestedAt) return undefined;
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
            OR: [{ controllerMachineId: request.controller.machineId, controllerInstallationId: request.controller.installationId },
                { controllerMachineId: null }],
            custodianAccountId: input.actorAccountId, enrolledMachineId: { not: null }, archivedAt: null,
            creationState: 'active', allocation: 'bound', wakeOnAcceptedMessage: true },
            include: { enrolledMachine: { select: { active: true, lastActiveAt: true } } } });
        const candidateIds = new Set(managedRows.flatMap(row => {
            const projected = projectManagedMachine(row);
            return row.enrolledMachineId && (projected.submittedNativeEffect
                || isManagedMachineWakeInspectionRequiredV1(projected, row.enrolledMachineId,
                    row.enrolledMachine !== null && isMachineReachableV1({ machine: serializeMachinePresence(row.enrolledMachine) }))) ? [row.id] : [];
        }));
        const machineIds = managedRows.flatMap(row => row.enrolledMachineId ? [row.enrolledMachineId] : []);
        const targets: ManagedWakeTargetV1[] = [];
        const originAccountIds = await resolveCurrentMachineRecipientAccountIdsInTx(tx, request.controller.machineId);
        const sessions = await tx.session.findMany({ where: { pendingActivationStatus: 'waiting',
            pendingActivationRequestId: { not: null }, accountId: { in: originAccountIds } }, select: { id: true } });
        for (const session of sessions) {
            const current = await readPendingManagedWakeTargetInTx(tx, session.id);
            if (current && current.homeId === request.homeId
                && (!current.controller || current.controller.machineId === request.controller.machineId
                    && current.controller.installationId === request.controller.installationId)) {
                targets.push(current);
            }
        }
        for (const run of await readWorkflowRunOriginWakeCandidatesInTx(tx, { accountIds: originAccountIds })) {
            if (!run.originSessionId) continue;
            const target = await resolveSessionContextWakeTargetInTx(tx, { accountId: run.accountId,
                sessionId: run.originSessionId, runId: run.id, revision: run.revision });
            if (target && target.homeId === request.homeId
                && (!target.controller || target.controller.machineId === request.controller.machineId
                    && target.controller.installationId === request.controller.installationId)) targets.push(target);
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
        return { targets: targets.filter(target => candidateIds.has(target.managedId)) };
    });
}
