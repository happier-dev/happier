import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/mini';
import { PendingRequestedActionV1StoredSchema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ManagedWakeTargetV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { type PendingActivationAuthorizationV1, type PendingActivationFailureCodeV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { TransactionReplayRequiredError, type Tx } from '@/storage/inTx';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { getActivePrismaRuntime } from '@/storage/db';
import { readManagedPendingActivationHoldReasonInTx, resolveManagedWakeTargetInTx } from '@/app/machines/managed/managedWake';
import { projectManagedMachine } from '@/app/machines/managed/managedRows';
import { markAccountChanged, type AccountChangePublication } from '@/app/changes/markAccountChanged';
import { isCurrentSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { readPendingSessionInputAdmission } from './pendingInputAdmission';
export { readPendingOwnerInputAdmission } from './pendingInputAdmission';
import type { EffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import { PendingActivationFailureCodeV1Schema, PendingActivationFailureDetailsV1Schema,
    type PendingActivationFailureDetailsV1, type PendingActivationHoldReasonV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { PendingMessageRowRaw } from './mapPendingMessageRow';

const StoredActivationFailureSchema = z.extend(PendingActivationFailureDetailsV1Schema, { failureCode: PendingActivationFailureCodeV1Schema });

function readStoredActivationFailure(value: unknown) {
    const code = PendingActivationFailureCodeV1Schema.safeParse(value);
    if (code.success) return { failureCode: code.data };
    if (typeof value !== 'string') return undefined;
    try { return StoredActivationFailureSchema.safeParse(JSON.parse(value)).data; } catch { return undefined; }
}

/** Read-only sibling projection; the predecessor's closed authorization envelope stays unchanged. */
export function mapPendingActivationFailureDetails(row: object): PendingActivationFailureDetailsV1 | undefined {
    if (mapPendingActivationAuthorization(row)?.status !== 'failed') return undefined;
    const failure = readStoredActivationFailure(Reflect.get(row, 'pendingActivationFailureCode'));
    if (!failure || !('reason' in failure)) return undefined;
    const { failureCode: _code, ...details } = failure;
    return details;
}

export type PendingActivationTarget = Readonly<{ accountId: string; requestId: string;
    machinePublication?: Readonly<{ target: SessionInputMachineTargetV1; custodianAccountId: string; requestedAt: number }>;
    managedControllerPublication?: Readonly<{ accountId: string; cursor: number }> }>;

export type PendingActivationPublicationTarget = Omit<PendingActivationTarget, 'managedControllerPublication'>
    & Readonly<{ managedControllerPublication?: AccountChangePublication }>;

/**
 * Cursor lock audience only. Include the target Machine's owner even before
 * enrollment: enrollment's mandatory publication locks this same custodian
 * before committing. This grants no Machine, Session or wake authority.
 * Normal activation admission revalidates the controller after Account locks.
 */
export async function readPendingActivationControllerAccountIdsInTx(
    tx: Tx,
    targetMachineId: string | undefined,
): Promise<readonly string[]> {
    if (!targetMachineId) return [];
    const [machine, enrollment] = await Promise.all([
        tx.machine.findUnique({ where: { id: targetMachineId }, select: { accountId: true } }),
        tx.managedMachine.findUnique({
            where: { enrolledMachineId: targetMachineId }, select: { custodianAccountId: true },
        }),
    ]);
    return [...new Set([machine?.accountId, enrollment?.custodianAccountId]
        .filter((id): id is string => typeof id === 'string'))].sort();
}

const ACTIVATION_ELIGIBILITY_SELECT = {
    messageRole: true,
    status: true,
    deliveryState: true,
    providerAction: true,
    requestedAction: true,
    authorAccountId: true,
    inputAdmissionReceipt: true,
} as const;

export function shouldArmPendingActivationAuthorization(params: Readonly<{
    requestedAction: { kind: string };
    resumeWhenAvailable?: boolean;
}>): boolean {
    return params.requestedAction.kind !== 'reset_start' && (params.resumeWhenAvailable === true
        || (params.resumeWhenAvailable !== false && params.requestedAction.kind === 'send_now'));
}

/** Queue diagnostics use current admitted placement; they never create activation or block ordinary delivery. */
export async function readPendingActivationHoldReasonsInTx(tx: Tx, input: Readonly<{
    sessionId: string; actorAccountId: string; rows: readonly PendingMessageRowRaw[];
}>): Promise<ReadonlyMap<string, PendingActivationHoldReasonV1>> {
    const holds = new Map<string, PendingActivationHoldReasonV1>();
    const session = await tx.session.findUnique({ where: { id: input.sessionId }, select: AUTHORIZATION_SELECT });
    if (!session || session.accountId !== input.actorAccountId) return holds;
    const candidates = input.rows.flatMap(row => {
        const action = PendingRequestedActionV1StoredSchema.safeParse(row.requestedAction ?? { v: 1, kind: 'enqueue' });
        if (row.status !== 'queued' || row.targetExecutionRunId != null || row.deliveryState != null
            || row.providerAction != null || !action.success || !['enqueue', 'send_now'].includes(action.data.kind)) return [];
        const receipt = readPendingSessionInputAdmission({ sessionId: input.sessionId, accountId: session.accountId,
            pending: { messageRole: typeof row.messageRole === 'string' ? row.messageRole : null,
                authorAccountId: row.authorAccountId, inputAdmissionReceipt: row.inputAdmissionReceipt } });
        return receipt?.admittedTarget ? [{ localId: row.localId, target: receipt.admittedTarget }] : [];
    });
    const activation = mapPendingActivationAuthorization(session);
    const targets = new Map(candidates.map(candidate => [JSON.stringify(candidate.target), candidate.target]));
    for (const target of targets.values()) {
        if (!await isCurrentSessionInputMachineTargetInTx(tx, target)) continue;
        const resumeRequested = Boolean(activation?.status === 'waiting' && activation.managedWakeTargetV1
            && candidates.some(candidate => candidate.localId === activation.requestId
            && isDeepStrictEqual(candidate.target, target)));
        const reason = await readManagedPendingActivationHoldReasonInTx(tx, { actorAccountId: session.accountId,
            machineId: target.machineId, homeId: target.homeId, resumeRequested });
        if (reason) for (const candidate of candidates) if (isDeepStrictEqual(candidate.target, target)) holds.set(candidate.localId, reason);
    }
    return holds;
}

const AUTHORIZATION_SELECT = {
    accountId: true,
    lastActiveAt: true,
    pendingActivationRequestId: true,
    pendingActivationRequestedAt: true,
    pendingActivationStatus: true,
    pendingActivationFailureCode: true,
    pendingActivationManagedTarget: true,
} as const;

function clearAuthorizationData() { return {
    pendingActivationRequestId: null,
    pendingActivationRequestedAt: null,
    pendingActivationStatus: null,
    pendingActivationFailureCode: null,
    pendingActivationManagedTarget: getActivePrismaRuntime().DbNull,
} as const; }

function nextRequestedAt(params: Readonly<{
    now: Date;
    lastActiveAt: Date;
    priorRequestedAt: Date | null;
}>): Date {
    return new Date(Math.max(
        params.now.getTime(),
        params.lastActiveAt.getTime() + 1,
        (params.priorRequestedAt?.getTime() ?? -1) + 1,
    ));
}

export function mapPendingActivationAuthorization(row: object): PendingActivationAuthorizationV1 | undefined {
    const value = row as Record<string, unknown>;
    const requestId = value.pendingActivationRequestId;
    const requestedAt = value.pendingActivationRequestedAt;
    const status = value.pendingActivationStatus;
    if (
        typeof requestId !== 'string'
        || !(requestedAt instanceof Date)
    ) return undefined;
    const target = createStoredReadSchema(ManagedWakeTargetV1Schema).safeParse(value.pendingActivationManagedTarget);
    const managedWakeTargetV1 = target.success && target.data.origin.kind === 'session-input'
        && target.data.origin.pendingRequestId === requestId && target.data.origin.requestedAt === requestedAt.getTime()
        ? target.data : undefined;
    if (status === 'waiting') return { requestId, requestedAt: requestedAt.getTime(), status,
        ...(managedWakeTargetV1 ? { managedWakeTargetV1 } : {}) };
    const failure = readStoredActivationFailure(value.pendingActivationFailureCode);
    if (status === 'failed' && failure) {
        return {
            requestId,
            requestedAt: requestedAt.getTime(),
            status,
            failureCode: failure.failureCode,
            ...(managedWakeTargetV1 ? { managedWakeTargetV1 } : {}),
        };
    }
    return undefined;
}

export async function armPendingActivationAuthorizationInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    requestId: string;
    /** Access resolved for this mutation's credential in the same transaction. */
    currentAccess: Pick<EffectiveSessionAccess, 'accountId' | 'sessionId' | 'level'>;
    now?: Date;
    resumeWhenAvailable?: true;
}>): Promise<PendingActivationPublicationTarget | undefined> {
    if (params.currentAccess.sessionId !== params.sessionId) return undefined;
    const eligible = await params.tx.sessionPendingMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.requestId }, targetExecutionRunId: null },
        select: ACTIVATION_ELIGIBILITY_SELECT,
    });
    const requestedAction = PendingRequestedActionV1StoredSchema.safeParse(eligible?.requestedAction);
    const inputAdmissionReceipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(
        eligible?.inputAdmissionReceipt,
    );
    if (
        !eligible
        || !inputAdmissionReceipt.success
        || !['authenticatedAccount', 'authenticatedMachine'].includes(inputAdmissionReceipt.data.issuer)
        || eligible.messageRole !== 'user'
        || eligible.status !== 'queued'
        || eligible.deliveryState !== null
        || eligible.providerAction !== null
        || !requestedAction.success
        || !shouldArmPendingActivationAuthorization({
            requestedAction: requestedAction.data,
            resumeWhenAvailable: params.resumeWhenAvailable,
        })
    ) return undefined;
    const controllerAccountIds = await readPendingActivationControllerAccountIdsInTx(
        params.tx, inputAdmissionReceipt.data.admittedTarget?.machineId,
    );
    await acquireSessionAccountCursorLocksInTx(params.tx, [params.sessionId], controllerAccountIds);
    const currentEligible = await params.tx.sessionPendingMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.requestId }, targetExecutionRunId: null },
        select: ACTIVATION_ELIGIBILITY_SELECT,
    });
    const currentControllerAccountIds = await readPendingActivationControllerAccountIdsInTx(
        params.tx, inputAdmissionReceipt.data.admittedTarget?.machineId,
    );
    // Standalone arming can wait on Accounts after reading the receipt. Rejoin
    // the complete admission with its current receipt instead of committing a
    // refusal from that stale eligible row or adding another Account later.
    if (!isDeepStrictEqual(eligible, currentEligible)
        || !isDeepStrictEqual(controllerAccountIds, currentControllerAccountIds)) {
        throw new TransactionReplayRequiredError('pending-activation-target-changed');
    }
    const session = await params.tx.session.findUniqueOrThrow({
        where: { id: params.sessionId },
        select: AUTHORIZATION_SELECT,
    });
    if (params.currentAccess.level === 'owner' && session.accountId !== params.currentAccess.accountId) return undefined;
    const ownerAdmission = readPendingSessionInputAdmission({ sessionId: params.sessionId, accountId: session.accountId, pending: eligible });
    if (!ownerAdmission) return undefined;
    const admittedTarget = ownerAdmission.admittedTarget;
    if (admittedTarget && !await isCurrentSessionInputMachineTargetInTx(params.tx, admittedTarget)) return undefined;
    const actorAccountId = session.accountId;
    const requestedAt = nextRequestedAt({
        now: params.now ?? new Date(),
        lastActiveAt: session.lastActiveAt,
        priorRequestedAt: session.pendingActivationRequestedAt,
    });
    const retained = createStoredReadSchema(ManagedWakeTargetV1Schema).safeParse(session.pendingActivationManagedTarget);
    const priorTarget = retained.success && retained.data.origin.kind === 'session-input'
        && retained.data.origin.session.sessionId === params.sessionId && retained.data.origin.pendingRequestId === params.requestId
        && session.pendingActivationRequestId === params.requestId ? retained.data : undefined;
    const managedTarget = admittedTarget
        ? await resolveManagedWakeTargetInTx(params.tx, { actorAccountId,
            requireAcceptedInputWake: params.currentAccess.level !== 'owner',
            machineId: admittedTarget.machineId, origin: { kind: 'session-input',
                session: { homeId: admittedTarget.homeId, sessionId: params.sessionId },
                pendingRequestId: params.requestId, requestedAt: requestedAt.getTime() } })
        : undefined;
    // Shared input can trigger the custodian's existing managed wake policy;
    // it cannot acquire ordinary Session start authority or vendor control.
    if (params.currentAccess.level !== 'owner' && !managedTarget) return undefined;
    if (inputAdmissionReceipt.data.issuer === 'authenticatedMachine' && !managedTarget && !admittedTarget) return undefined;
    if (priorTarget && managedTarget && priorTarget.managedId !== managedTarget.managedId) return undefined;
    await params.tx.session.update({
        where: { id: params.sessionId },
        data: {
            pendingActivationRequestId: params.requestId,
            pendingActivationRequestedAt: requestedAt,
            pendingActivationStatus: 'waiting',
            pendingActivationFailureCode: null,
            pendingActivationManagedTarget: managedTarget ?? getActivePrismaRuntime().DbNull,
        },
    });
    let managedControllerPublication: PendingActivationPublicationTarget['managedControllerPublication'];
    if (managedTarget) {
        if (managedTarget.controller) {
            const controller = await params.tx.machine.findUniqueOrThrow({ where: { id: managedTarget.controller.machineId }, select: { accountId: true } });
            managedControllerPublication = await markAccountChanged(params.tx, {
                accountId: controller.accountId, kind: 'machine', entityId: managedTarget.controller.machineId,
            });
        } else managedControllerPublication = await markAccountChanged(params.tx, {
            accountId: session.accountId, kind: 'account', entityId: managedTarget.managedId,
            hint: { managedMachinePolicy: true },
        });
    }
    const targetMachine = admittedTarget ? await params.tx.machine.findUniqueOrThrow({ where: { id: admittedTarget.machineId }, select: { accountId: true } }) : undefined;
    return { accountId: session.accountId, requestId: params.requestId,
        ...(admittedTarget && targetMachine ? { machinePublication: { target: admittedTarget,
            custodianAccountId: targetMachine.accountId, requestedAt: requestedAt.getTime() } } : {}),
        ...(managedControllerPublication ? { managedControllerPublication } : {}) };
}

/** Reconnect and lossy hints read one exact retained receipt, never enumerate candidate keys. */
export async function readPendingActivationTargetInTx(tx: Tx, sessionId: string): Promise<PendingActivationTarget | undefined> {
    const session = await tx.session.findUnique({ where: { id: sessionId }, select: { ...AUTHORIZATION_SELECT, archivedAt: true } });
    if (!session || session.archivedAt !== null || session.pendingActivationStatus !== 'waiting'
        || !session.pendingActivationRequestId || !session.pendingActivationRequestedAt) return undefined;
    const row = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
        sessionId, localId: session.pendingActivationRequestId }, targetExecutionRunId: null },
        select: { status: true, messageRole: true, deliveryState: true, providerAction: true,
            authorAccountId: true, inputAdmissionReceipt: true } });
    const receipt = row && readPendingSessionInputAdmission({ sessionId, accountId: session.accountId, pending: row });
    if (!row || row.status !== 'queued' || row.messageRole !== 'user' || row.deliveryState !== null || row.providerAction !== null
        || !receipt || !receipt.admittedTarget
        || !await isCurrentSessionInputMachineTargetInTx(tx, receipt.admittedTarget)) return undefined;
    const machine = await tx.machine.findUniqueOrThrow({ where: { id: receipt.admittedTarget.machineId }, select: { accountId: true } });
    return { accountId: session.accountId, requestId: session.pendingActivationRequestId,
        machinePublication: { target: receipt.admittedTarget, custodianAccountId: machine.accountId,
            requestedAt: session.pendingActivationRequestedAt.getTime() } };
}

export async function reconcilePendingActivationAuthorizationForRemovedRequestInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    requestId: string;
}>): Promise<boolean> {
    await acquireSessionAccountCursorLocksInTx(params.tx, [params.sessionId]);
    const session = await params.tx.session.findUniqueOrThrow({
        where: { id: params.sessionId },
        select: AUTHORIZATION_SELECT,
    });
    if (session.pendingActivationRequestId !== params.requestId) return false;
    const updated = await params.tx.session.updateMany({
        where: {
            id: params.sessionId,
            pendingActivationRequestId: params.requestId,
            pendingActivationRequestedAt: session.pendingActivationRequestedAt,
        },
        data: clearAuthorizationData(),
    });
    return updated.count > 0;
}

export async function markPendingActivationAuthorizationFailedInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    requestId: string;
    requestedAt: Date;
    failureCode: PendingActivationFailureCodeV1;
    failureDetails?: PendingActivationFailureDetailsV1;
}>): Promise<boolean> {
    await acquireSessionAccountCursorLocksInTx(params.tx, [params.sessionId]);
    if (params.failureCode === 'runtime_start_failed') {
        const session = await params.tx.session.findUnique({ where: { id: params.sessionId }, select: AUTHORIZATION_SELECT });
        const authorization = session ? mapPendingActivationAuthorization(session) : undefined;
        const target = authorization?.managedWakeTargetV1;
        if (authorization?.status === 'waiting' && target && authorization.requestId === params.requestId
            && authorization.requestedAt === params.requestedAt.getTime()) {
            // A runtime report cannot settle compute's still-pending wake.
            // Its signed policy owner reports definite power/Ask failures;
            // ordinary Agent-start failures apply only after compute runs.
            const row = await params.tx.managedMachine.findUnique({ where: { id: target.managedId } });
            if (!row || row.homeId !== target.homeId || row.enrolledMachineId !== target.enrolledMachineId) return false;
            const machine = projectManagedMachine(row);
            if (machine.observation?.availability !== 'present' || machine.observation.power !== 'running'
                || machine.observation.storage === 'lost' || machine.submittedNativeEffect) return false;
        }
    }
    const updated = await params.tx.session.updateMany({
        where: {
            id: params.sessionId,
            pendingActivationRequestId: params.requestId,
            pendingActivationRequestedAt: params.requestedAt,
            pendingActivationStatus: 'waiting',
        },
        data: {
            pendingActivationStatus: 'failed',
            pendingActivationFailureCode: params.failureDetails ? JSON.stringify({ failureCode: params.failureCode,
                ...PendingActivationFailureDetailsV1Schema.parse(params.failureDetails) }) : params.failureCode,
        },
    });
    return updated.count > 0;
}
