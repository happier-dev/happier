import {
    PendingRequestedActionV1Schema,
    SessionInputAdmissionReceiptV1Schema,
    ManagedWakeTargetV1Schema, createStoredReadSchema,
    type PendingActivationAuthorizationV1,
    type PendingActivationFailureCodeV1,
    type SessionInputAdmissionReceiptV1,
} from '@happier-dev/protocol';
import type { SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { Tx } from '@/storage/inTx';
import { getActivePrismaRuntime } from '@/storage/db';
import { resolveManagedWakeTargetInTx } from '@/app/machines/managed/managedWake';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { readStoredSessionInputAdmissionReceipt, isCurrentSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';

export type PendingActivationTarget = Readonly<{ accountId: string; requestId: string;
    machinePublication?: Readonly<{ target: SessionInputMachineTargetV1; custodianAccountId: string; requestedAt: number }>;
    managedControllerPublication?: Readonly<{ accountId: string; cursor: number }> }>;

/** One owner recovery admission predicate for activation and reset-bound Pending starts. */
export function readPendingOwnerInputAdmission(input: Readonly<{
    sessionId: string; accountId: string;
    pending: Readonly<{ messageRole: string | null; authorAccountId: string | null; inputAdmissionReceipt: unknown }>;
}>): SessionInputAdmissionReceiptV1 | undefined {
    const receipt = readStoredSessionInputAdmissionReceipt(input.pending.inputAdmissionReceipt);
    if (!receipt || input.pending.messageRole !== 'user'
        || input.pending.authorAccountId !== null && input.pending.authorAccountId !== input.accountId
        || receipt.issuer === 'authenticatedAccount' && (receipt.actorAccountId !== input.accountId || receipt.sessionRelationship !== 'owner')
        || receipt.admittedTarget && (receipt.admittedTarget.accountId !== input.accountId || receipt.admittedTarget.sessionId !== input.sessionId)) return undefined;
    return receipt;
}

export function shouldArmPendingActivationAuthorization(params: Readonly<{
    requestedAction: { kind: string };
    resumeWhenAvailable?: boolean;
}>): boolean {
    return params.requestedAction.kind !== 'reset_start' && (params.resumeWhenAvailable === true
        || (params.resumeWhenAvailable !== false && params.requestedAction.kind === 'send_now'));
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

export function clearPendingActivationAuthorizationForPublisherActivityData() {
    return clearAuthorizationData();
}

export function mapPendingActivationAuthorization(row: object): PendingActivationAuthorizationV1 | undefined {
    const value = row as Record<string, unknown>;
    const requestId = value.pendingActivationRequestId;
    const requestedAt = value.pendingActivationRequestedAt;
    const lastActiveAt = value.lastActiveAt;
    const status = value.pendingActivationStatus;
    if (
        typeof requestId !== 'string'
        || !(requestedAt instanceof Date)
        || !(lastActiveAt instanceof Date)
        || requestedAt.getTime() <= lastActiveAt.getTime()
    ) return undefined;
    const target = createStoredReadSchema(ManagedWakeTargetV1Schema).safeParse(value.pendingActivationManagedTarget);
    const managedWakeTargetV1 = target.success && target.data.origin.kind === 'session-input'
        && target.data.origin.pendingRequestId === requestId && target.data.origin.requestedAt === requestedAt.getTime()
        ? target.data : undefined;
    if (status === 'waiting') return { requestId, requestedAt: requestedAt.getTime(), status,
        ...(managedWakeTargetV1 ? { managedWakeTargetV1 } : {}) };
    if (status === 'failed' && value.pendingActivationFailureCode === 'runtime_start_failed') {
        return {
            requestId,
            requestedAt: requestedAt.getTime(),
            status,
            failureCode: value.pendingActivationFailureCode,
            ...(managedWakeTargetV1 ? { managedWakeTargetV1 } : {}),
        };
    }
    return undefined;
}

export async function armPendingActivationAuthorizationInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    requestId: string;
    now?: Date;
    resumeWhenAvailable?: true;
}>): Promise<PendingActivationTarget | undefined> {
    const eligible = await params.tx.sessionPendingMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.requestId }, targetExecutionRunId: null },
        select: {
            messageRole: true,
            status: true,
            deliveryState: true,
            providerAction: true,
            requestedAction: true,
            authorAccountId: true,
            inputAdmissionReceipt: true,
        },
    });
    const requestedAction = PendingRequestedActionV1Schema.safeParse(eligible?.requestedAction);
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
    const session = await params.tx.session.findUniqueOrThrow({
        where: { id: params.sessionId },
        select: AUTHORIZATION_SELECT,
    });
    const ownerAdmission = readPendingOwnerInputAdmission({ sessionId: params.sessionId, accountId: session.accountId, pending: eligible });
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
            machineId: admittedTarget.machineId, origin: { kind: 'session-input',
                session: { homeId: admittedTarget.homeId, sessionId: params.sessionId },
                pendingRequestId: params.requestId, requestedAt: requestedAt.getTime() } })
        : undefined;
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
    let managedControllerPublication: PendingActivationTarget['managedControllerPublication'];
    if (managedTarget) {
        const controller = await params.tx.machine.findUniqueOrThrow({ where: { id: managedTarget.controller.machineId }, select: { accountId: true } });
        managedControllerPublication = { accountId: controller.accountId,
            cursor: await markAccountChanged(params.tx, { accountId: controller.accountId, kind: 'machine', entityId: managedTarget.controller.machineId }) };
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
        || !session.pendingActivationRequestId || !session.pendingActivationRequestedAt
        || session.pendingActivationRequestedAt <= session.lastActiveAt) return undefined;
    const row = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
        sessionId, localId: session.pendingActivationRequestId }, targetExecutionRunId: null },
        select: { status: true, messageRole: true, deliveryState: true, providerAction: true,
            authorAccountId: true, inputAdmissionReceipt: true } });
    const receipt = row && readPendingOwnerInputAdmission({ sessionId, accountId: session.accountId, pending: row });
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
}>): Promise<boolean> {
    const updated = await params.tx.session.updateMany({
        where: {
            id: params.sessionId,
            pendingActivationRequestId: params.requestId,
            pendingActivationRequestedAt: params.requestedAt,
            pendingActivationStatus: 'waiting',
            lastActiveAt: { lt: params.requestedAt },
        },
        data: {
            pendingActivationStatus: 'failed',
            pendingActivationFailureCode: params.failureCode,
        },
    });
    return updated.count > 0;
}
