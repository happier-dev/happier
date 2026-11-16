import { decodeMachineStoredContent } from '@/storage/sessionMachineStoredContent';
import { ManagedWakeTargetV1Schema, ManagedWakeTargetsReadRequestV1Schema, type ManagedWakeTargetV1, type ManagedWakeTargetsReadRequestV1, ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
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
import { ACCOUNT_DISPLAY_PROFILE_SELECT, resolveAccountDisplayLabelV1 } from '@/app/account/profile/accountDisplayProfile';
import { verifyCurrentExternalActionPrincipalInTx, verifyCurrentExternalActionPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { isCurrentSessionInputMachineTargetInTx, readCurrentCommittedSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { emitAutomationRunUpdatedToMachineOnly } from '@/app/automations/automationChangePublisher';
import { afterTx, inTx, type Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { jsonPathEquals } from '@/storage/jsonPathFilter';
import { markAccountChanged, type AccountChangePublication } from '@/app/changes/markAccountChanged';
import { readWorkflowRunOriginWakeCandidatesInTx } from '@/app/workflows/workflowRunAttention';
import { ManagedMachineError, hasBoundManagedLifecycle, projectManagedMachine, requireManagedControllerInTx, sameManagedInput, readManagedController, resolveManagedMachineRoleInTx, type StoredManagedMachine } from './managedRows';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import type { RpcAckResponseEmitter } from '@/app/api/socket/rpc/_types';
import { readMachineDaemonSocketIdentity } from '@/app/machines/machineDaemonPresence';
import { readVerifiedMachineSocketInstallationIdFromSocketData } from '@/app/api/socket/machineSocketInstallationProof';
import type { PendingActivationHoldReasonV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { resolveManagedFiniteWakeControllerV1, resolveManagedMachineRuntimeV1, resolveManagedWakeAvailabilityV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { isMachineReachableV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { serializeMachinePresence } from '@/app/machines/machineSerialization';
import { hasManagedWakeAuthority, readManagedWakeTargetBindingInTx } from './managedWakeBinding';
import { readManagedWakeSessionsInTx, readPendingManagedWakeTargetsInTx, readPendingManagedWakeInputTarget } from './managedWakePlacement';

type FiniteWakePreparation = Readonly<{ kind: 'not-needed' | 'ready'; isCurrent(): Promise<boolean> }>
    | Readonly<{ kind: 'unavailable'; reason?: Extract<ReturnType<typeof resolveManagedWakeAvailabilityV1>, { kind: 'unavailable' }>['reason'] }>
    | Readonly<{ kind: 'submitted-unknown' }>;

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
        finiteActionId: binding.actionId,
    });
    if (!target) return null;
    const finiteWake = resolveManagedFiniteWakeControllerV1(target);
    if (finiteWake.kind === 'unavailable') return null;
    const controllerBinding = finiteWake.controller;
    const row = await tx.managedMachine.findUnique({ where: { id: target.managedId } });
    if (!row) return null;
    try { await assertManagedWakeOriginCurrentInTx(tx, { row, target, actionOrigin: input.actionOrigin }); }
    catch (error) { if (error instanceof ManagedMachineError) return null; throw error; }
    const controller = await resolveMachineAdmissionInTx(tx, { actorAccountId: row.custodianAccountId,
        machineId: controllerBinding.machineId, requiredRole: 'manage', requireOnline: true });
    if (controller.kind !== 'admitted' || controller.installationId !== controllerBinding.installationId
        || controller.custodianAccountId !== row.custodianAccountId) return null;
    const installed = await tx.machine.findUnique({ where: { id: controllerBinding.machineId }, select: {
        installationId: true, installationPublicKey: true, account: { select: ACCOUNT_DISPLAY_PROFILE_SELECT },
    } });
    if (installed?.installationId !== controllerBinding.installationId || !installed.installationPublicKey) return null;
    const publicKey = MachineInstallationPublicKeySchema.safeParse(encodeBase64(installed.installationPublicKey, 'base64url'));
    // Enrollment may place another person's guest on this managed resource.
    // Guest disclosure covers its custodian once; only a new recipient needs another Ask.
    return publicKey.success ? { target, installationPublicKey: publicKey.data,
        ...(controller.custodianAccountId !== binding.accountId && controller.custodianAccountId !== binding.custodianAccountId
            ? { requesterCredentialDisclosure: { accountId: controller.custodianAccountId,
                displayName: resolveAccountDisplayLabelV1(installed.account) ?? '' } } : {}),
    } : null;
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
    // This finite request admits once. The HTTP/socket owner cancels its local
    // steps; guest dispatch and controller Home calls admit as new requests.
    const isCurrent = async (): Promise<boolean> => !input.signal.aborted;
    if (input.signal.aborted || (input.isOriginalSourceCurrent && !await input.isOriginalSourceCurrent())) return { kind: 'unavailable' };
    const initial = await inTx(async tx => {
        if (await readCurrentServerIdentityId(process.env, tx) !== binding.serverIdentityId) return null;
        const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId,
            machineId: binding.machineId, actionId: binding.actionId });
        if (admission.kind !== 'admitted' || admission.installationId !== binding.installationId
            || admission.custodianAccountId !== binding.custodianAccountId
            || binding.accountEncryptionMode === undefined) return null;
        const guest = await tx.machine.findUnique({ where: { id: binding.machineId }, select: { active: true, lastActiveAt: true } });
        if (guest && isMachineReachableV1({ machine: serializeMachinePresence(guest) })) return { online: true as const };
        const wake = await resolveManagedWakeTargetInTx(tx, { actorAccountId: binding.accountId, machineId: binding.machineId,
            origin: { kind: 'finite-command', actionRequestId: binding.requestId }, finiteActionId: binding.actionId, requireInspection: true });
        return { online: false as const, wake, controllerCustodianAccountId: admission.custodianAccountId };
    });
    if (!initial || input.signal.aborted) return { kind: 'unavailable' };
    if (initial.online) return { kind: 'not-needed', isCurrent };
    const target = initial.wake;
    if (!target) return { kind: 'unavailable' };
    const finiteWake = resolveManagedFiniteWakeControllerV1(target);
    if (finiteWake.kind === 'unavailable') return finiteWake;
    if (!await isCurrent()) return { kind: 'unavailable' };
    const wakeTarget = target;
    const controllerBinding = finiteWake.controller;
    // Target admission owns requester power. This read selects that resource's
    // installed custodian transport; the signed original requester stays on the Action.
    const controller = await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: initial.controllerCustodianAccountId,
        machineId: controllerBinding.machineId, requiredRole: 'manage', requireOnline: true }));
    const controllerAvailability = resolveManagedWakeAvailabilityV1(controllerBinding, controller.kind === 'admitted'
        ? { id: controllerBinding.machineId, installationId: controller.installationId, online: true } : undefined);
    if (controllerAvailability.kind === 'unavailable') return controllerAvailability;
    if (controller.kind !== 'admitted') return { kind: 'unavailable' };
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
            // The invoking HTTP/socket request owns cancellation throughout wake.
            timeoutMs: null,
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

export async function resolveManagedWakeTargetInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; machineId: string; origin: ManagedWakeTargetV1['origin'];
    requireAcceptedInputWake?: boolean;
    requireInspection?: boolean;
    /** Internal projection of the verified original finite Action, never request JSON. */
    finiteActionId?: string;
}>): Promise<ManagedWakeTargetV1 | undefined> {
    const binding = await readManagedWakeTargetBindingInTx(tx, input);
    if (input.requireInspection && !binding?.inspectionRequired) return undefined;
    if (input.requireAcceptedInputWake && !(binding?.inspectionRequired && binding.wakeOnAcceptedMessage)) return undefined;
    return binding && hasManagedWakeAuthority(binding.controllerRole, binding.wakeOnAcceptedMessage, input.origin.kind, input.finiteActionId)
        ? ManagedWakeTargetV1Schema.parse({ ...binding.binding, origin: input.origin }) : undefined;
}

/** Same binding and power-role owner as wake admission; this read cannot arm or start anything. */
export async function readManagedPendingActivationHoldReasonInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; machineId: string; homeId: string; resumeRequested: boolean;
}>): Promise<PendingActivationHoldReasonV1 | undefined> {
    const current = await readManagedWakeTargetBindingInTx(tx, input);
    if (!current?.inspectionRequired || current.binding.homeId !== input.homeId) return undefined;
    if (!hasManagedWakeAuthority(current.controllerRole, current.wakeOnAcceptedMessage, 'session-input')) return 'managed_power_required';
    return input.resumeRequested ? undefined : 'resume_not_requested';
}

/** Accepted origins invalidate the same policy reader as managed resource changes. */
export async function publishManagedWakeChangeInTx(tx: Tx, target: ManagedWakeTargetV1, accountId: string): Promise<AccountChangePublication> {
    // Machine-row changes only retire controller currentness. Accepted work
    // must reach the existing policy classifier, including after a lost live hint.
    return markAccountChanged(tx, { accountId, kind: 'account', entityId: target.managedId,
        hint: { managedMachinePolicy: true, ...(target.controller ? { machineId: target.controller.machineId } : {}) } });
}

/** Real queued assignment is the durable origin; guest claims remain at the incumbent claim owner. */
export async function publishManagedRunWakeInTx(tx: Tx, input: Readonly<{ accountId: string; runId: string; cursor: AccountChangePublication }>): Promise<void> {
    const run = await tx.automationRun.findUnique({ where: { id: input.runId }, include: { assignments: true } });
    if (!run || run.accountId !== input.accountId || run.state !== 'queued' || run.claimedByMachineId !== null) return;
    for (const assignment of run.assignments) {
        const target = await resolveManagedWakeTargetInTx(tx, { actorAccountId: input.accountId, machineId: assignment.machineId,
            origin: { kind: 'workflow-assignment', runId: run.id, revision: run.revision, assignment: { machineId: assignment.machineId } } });
        if (target && !target.controller) {
            await publishManagedWakeChangeInTx(tx, target, input.accountId);
        }
        if (target?.controller) {
            const controllerBinding = target.controller;
            const controller = await tx.machine.findUniqueOrThrow({ where: { id: controllerBinding.machineId }, select: { accountId: true } });
            const cursor = await publishManagedWakeChangeInTx(tx, target, controller.accountId);
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

export { readManagedWakePublicationAccountIdsInTx } from './managedWakePublicationAudience';

/** Committed delivery uses Session placement, never an initial Run assignment guess. */
export async function publishManagedContextWakeInTx(tx: Tx, input: Readonly<{ runId: string; originSessionId: string }>): Promise<void> {
    const [run] = await readWorkflowRunOriginWakeCandidatesInTx(tx, input);
    if (!run) return;
    const target = await resolveSessionContextWakeTargetInTx(tx, { accountId: run.accountId,
        sessionId: input.originSessionId, runId: run.id, revision: run.revision });
    if (!target) return;
    if (!target.controller) {
        await publishManagedWakeChangeInTx(tx, target, run.accountId);
        return;
    }
    const controllerBinding = target.controller;
    const row = await tx.managedMachine.findUniqueOrThrow({ where: { id: target.managedId } });
    try { await assertManagedWakeOriginCurrentInTx(tx, { row, target }); }
    catch (error) { if (error instanceof ManagedMachineError) return; throw error; }
    const controller = await tx.machine.findUniqueOrThrow({ where: { id: controllerBinding.machineId }, select: { accountId: true } });
    const cursor = await publishManagedWakeChangeInTx(tx, target, controller.accountId);
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
        || row.creationState !== 'active' || row.archivedAt !== null
        || !hasBoundManagedLifecycle(row) || row.desired === 'delete') throw new ManagedMachineError('admission_unavailable');
    await requireManagedControllerInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId, controller: target.controller });
    let projected;
    try { projected = projectManagedMachine(row); } catch { throw new ManagedMachineError('admission_unavailable'); }
    if (!input.allowUnavailableObservation
        && (projected.observation?.availability === 'absent' || projected.observation?.storage === 'lost')) throw new ManagedMachineError('admission_unavailable');
    let actorAccountId: string;
    let finiteActionId: string | undefined;
    if (target.origin.kind === 'session-input') {
        const origin = target.origin;
        const session = await tx.session.findUnique({ where: { id: origin.session.sessionId }, select: {
            id: true, accountId: true, archivedAt: true, runtimeMachineTarget: true, pendingActivationStatus: true,
            pendingActivationRequestId: true, pendingActivationRequestedAt: true, pendingActivationManagedTarget: true,
        } });
        if (!session || origin.session.homeId !== row.homeId) throw new ManagedMachineError('admission_unavailable');
        const pending = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
            sessionId: origin.session.sessionId, localId: origin.pendingRequestId }, targetExecutionRunId: null },
            select: { status: true, messageRole: true, authorAccountId: true, deliveryState: true, providerAction: true, inputAdmissionReceipt: true } });
        const admittedTarget = readPendingManagedWakeInputTarget(session, pending ?? undefined, target);
        if (!admittedTarget || !await isCurrentSessionInputMachineTargetInTx(tx, admittedTarget)) throw new ManagedMachineError('admission_unavailable');
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
        finiteActionId = binding.actionId;
    } else {
        // A finite Action needs its existing verified authority, never a request-body id.
        throw new ManagedMachineError('admission_unavailable');
    }
    if (!hasManagedWakeAuthority(await resolveManagedMachineRoleInTx(tx, row, actorAccountId), row.wakeOnAcceptedMessage, target.origin.kind, finiteActionId)
        || !await resolveEffectiveMachineRoleInTx(tx, { actorAccountId, machineId: target.enrolledMachineId })) throw new ManagedMachineError('permission_denied');
    const guest = await tx.machine.findUnique({ where: { id: target.enrolledMachineId } }).then(decodeMachineStoredContent);
    if (classifyMachineAvailabilityState(guest) !== 'available') throw new ManagedMachineError('enrollment_retired');
}

export async function readPendingManagedWakeTargetInTx(tx: Tx, sessionId: string): Promise<ManagedWakeTargetV1 | undefined> {
    const sessions = await readManagedWakeSessionsInTx(tx, [sessionId]);
    return (await readPendingManagedWakeTargetsInTx(tx, sessions)).get(sessionId);
}

/** Reconnect reads existing activation/assignment custody, not a second queue or copied Session content. */
export async function readManagedWakeTargets(input: Readonly<{
    actorAccountId: string; request: ManagedWakeTargetsReadRequestV1; managedId?: string;
}>) {
    const request = ManagedWakeTargetsReadRequestV1Schema.parse(input.request);
    return inTx(async tx => {
        await requireManagedControllerInTx(tx, { ...request, custodianAccountId: input.actorAccountId });
        const managedRows = await tx.managedMachine.findMany({ where: { homeId: request.homeId,
            ...(input.managedId ? { id: input.managedId } : {}),
            OR: [{ controllerMachineId: request.controller.machineId, controllerInstallationId: request.controller.installationId },
                { controllerMachineId: null }],
            custodianAccountId: input.actorAccountId, enrolledMachineId: { not: null }, archivedAt: null,
            creationState: 'active', allocation: 'bound', wakeOnAcceptedMessage: true },
            include: { enrolledMachine: { select: { active: true, lastActiveAt: true } } } });
        const candidateIds = new Set(managedRows.flatMap(row => {
            const projected = projectManagedMachine(row);
            return row.enrolledMachineId && (projected.submittedNativeEffect
                || resolveManagedMachineRuntimeV1(projected, row.enrolledMachineId,
                    row.enrolledMachine !== null && isMachineReachableV1({ machine: serializeMachinePresence(row.enrolledMachine) })).inspectionRequired) ? [row.id] : [];
        }));
        const machineIds = new Set(managedRows.flatMap(row => row.enrolledMachineId ? [row.enrolledMachineId] : []));
        const targets: ManagedWakeTargetV1[] = [];
        const originAccountIds = await resolveCurrentMachineRecipientAccountIdsInTx(tx, request.controller.machineId);
        // Accepted origins retain their original controller. Select by immutable
        // managed identity; the current row remains the controller-custody authority.
        for (const ids of portableQueryChunks({ values: managedRows.map(row => row.id), bindingsPerValue: 2, fixedBindings: 4 })) {
            const sessions = await tx.session.findMany({ where: { pendingActivationStatus: 'waiting',
                pendingActivationRequestId: { not: null },
                AND: [{ pendingActivationManagedTarget: jsonPathEquals(['homeId'], request.homeId) }],
                OR: ids.map(id => ({ pendingActivationManagedTarget: jsonPathEquals(['managedId'], id) })),
            }, select: { id: true, accountId: true } });
            for (const session of sessions) {
                const current = await readPendingManagedWakeTargetInTx(tx, session.id);
                if (current && current.homeId === request.homeId
                    && (!current.controller || current.controller.machineId === request.controller.machineId
                        && current.controller.installationId === request.controller.installationId)) {
                    targets.push(current);
                }
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
        const readAssignedRuns = (accountIds: readonly string[], guestIds: readonly string[]) => tx.automationRun.findMany({
            where: { accountId: { in: [...accountIds] }, state: 'queued', claimedByMachineId: null,
                assignments: { some: { machineId: { in: [...guestIds] } } } },
            select: { id: true, accountId: true, revision: true, assignments: { select: { machineId: true } } } });
        const runs = new Map<string, Awaited<ReturnType<typeof readAssignedRuns>>[number]>();
        // Reserve room for both IN sets, plus queued state and Prisma's offset.
        for (const guestIds of portableQueryChunks({ values: [...machineIds], bindingsPerValue: 2, fixedBindings: 2 })) {
            for (const accountIds of portableQueryChunks({ values: originAccountIds, bindingsPerValue: 1,
                fixedBindings: guestIds.length + 2 })) {
                for (const run of await readAssignedRuns(accountIds, guestIds)) runs.set(run.id, run);
            }
        }
        for (const run of runs.values()) for (const assignment of run.assignments) {
            if (!machineIds.has(assignment.machineId)) continue;
            const target = await resolveManagedWakeTargetInTx(tx, { actorAccountId: run.accountId, machineId: assignment.machineId,
                origin: { kind: 'workflow-assignment', runId: run.id, revision: run.revision, assignment: { machineId: assignment.machineId } } });
            if (target) targets.push(target);
        }
        return { targets: targets.filter(target => candidateIds.has(target.managedId)) };
    });
}
