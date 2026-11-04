import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { SESSION_ACCESS_SESSION_BATCH_SIZE, type EffectiveSessionAccess } from "@/app/session/access/sessionAccess";
import { SessionInputAdmissionReceiptV1Schema, type SessionInputAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { SessionInputMachineTargetV1Schema, type SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { CallerInputConstraintsV1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import type { Tx } from '@/storage/inTx';
import { resolveMachineAdmissionInTx, resolveMachineAdmissionsInTx } from '@/app/machines/machineAccess';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';

/** Exact input placement comes from the requester tuple and C41, never a first-key guess. */
export async function readCurrentSessionInputMachineTargetInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string; machineId: string;
}>, options?: Readonly<{ admittedWork: true }>): Promise<SessionInputMachineTargetV1 | undefined> {
    const binding = { accountId: input.accountId, sessionId: input.sessionId, machineId: input.machineId };
    const key = await tx.accessKey.findUnique({ where: { accountId_machineId_sessionId: binding },
        select: { session: { select: { accountId: true } },
            machine: options?.admittedWork ? { select: { installationId: true, revokedAt: true, replacedByMachineId: true } } : false } });
    if (!key || key.session.accountId !== input.accountId) return undefined;
    let installationId: string;
    if (options?.admittedWork) {
        // The root already admitted the grant; only the retained tuple and
        // installed resource remain structural requirements at this effect.
        if (!key.machine.installationId || classifyMachineAvailabilityState(key.machine) !== 'available') return undefined;
        installationId = key.machine.installationId;
    } else {
        const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: input.accountId, machineId: input.machineId });
        if (admission.kind !== 'admitted') return undefined;
        installationId = admission.installationId;
    }
    const homeId = await readCurrentServerIdentityId(process.env, tx);
    if (!homeId) return undefined;
    return SessionInputMachineTargetV1Schema.parse({ ...binding, homeId, installationId });
}

/** Retained placement cannot follow a replacement installation or another Home. */
export async function isCurrentSessionInputMachineTargetInTx(tx: Tx, target: SessionInputMachineTargetV1): Promise<boolean> {
    return (await areCurrentSessionInputMachineTargetsInTx(tx, [target]))[0] ?? false;
}

/** One coherent set of placement facts; results correspond to the supplied targets. */
export async function areCurrentSessionInputMachineTargetsInTx(tx: Tx, targets: readonly SessionInputMachineTargetV1[]): Promise<readonly boolean[]> {
    if (targets.length === 0) return [];
    if (targets.length > SESSION_ACCESS_SESSION_BATCH_SIZE) {
        const currentness: boolean[] = [];
        for (let offset = 0; offset < targets.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            currentness.push(...await areCurrentSessionInputMachineTargetsInTx(tx, targets.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE)));
        }
        return currentness;
    }
    const sessions = await tx.session.findMany({ where: { id: { in: [...new Set(targets.map(target => target.sessionId))] } },
        select: { id: true, accountId: true, runtimeMachineTarget: true } });
    const bySession = new Map(sessions.map(session => [session.id, session]));
    const keys = await tx.accessKey.findMany({ where: { OR: targets.map(({ accountId, sessionId, machineId }) => ({ accountId, sessionId, machineId })) },
        select: { accountId: true, sessionId: true, machineId: true } });
    const bindingKey = (value: Readonly<{ accountId: string; sessionId: string; machineId: string }>) => JSON.stringify([value.accountId, value.sessionId, value.machineId]);
    const bindings = new Set(keys.map(bindingKey));
    const homeId = await readCurrentServerIdentityId(process.env, tx);
    const byAccount = new Map<string, Awaited<ReturnType<typeof resolveMachineAdmissionsInTx>>>();
    for (const accountId of new Set(targets.map(target => target.accountId))) {
        byAccount.set(accountId, await resolveMachineAdmissionsInTx(tx, { actorAccountId: accountId,
            machineIds: targets.filter(target => target.accountId === accountId).map(target => target.machineId) }));
    }
    return targets.map(target => {
        const session = bySession.get(target.sessionId);
        const admission = byAccount.get(target.accountId)?.get(target.machineId);
        if (!session || session.accountId !== target.accountId || !bindings.has(bindingKey(target)) || !homeId || homeId !== target.homeId
            || admission?.kind !== 'admitted' || admission.installationId !== target.installationId) return false;
        if (session.runtimeMachineTarget == null) return true;
        const committed = createStoredReadSchema(SessionInputMachineTargetV1Schema).safeParse(session.runtimeMachineTarget);
        return committed.success && sameMachineTarget(committed.data, target);
    });
}

function sameMachineTarget(left: SessionInputMachineTargetV1, right: SessionInputMachineTargetV1): boolean {
    return left.homeId === right.homeId && left.accountId === right.accountId && left.sessionId === right.sessionId
        && left.machineId === right.machineId && left.installationId === right.installationId;
}

/** Only an actual publisher commit establishes cold placement; keys alone never select it. */
export async function readCurrentCommittedSessionInputMachineTargetInTx(tx: Tx, sessionId: string,
    options?: Readonly<{ admittedWork: true }>): Promise<SessionInputMachineTargetV1 | undefined> {
    const session = await tx.session.findUnique({ where: { id: sessionId },
        select: { accountId: true, archivedAt: true, runtimeMachineTarget: true } });
    if (!session || session.archivedAt !== null || session.runtimeMachineTarget == null) return undefined;
    const stored = createStoredReadSchema(SessionInputMachineTargetV1Schema).safeParse(session.runtimeMachineTarget);
    if (!stored.success || stored.data.sessionId !== sessionId || stored.data.accountId !== session.accountId) return undefined;
    const current = await readCurrentSessionInputMachineTargetInTx(tx, stored.data, options);
    return current && sameMachineTarget(current, stored.data) ? stored.data : undefined;
}

export function readStoredSessionInputAdmissionReceipt(value: unknown): SessionInputAdmissionReceiptV1 | undefined {
    const parsed = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/** Provider effects use the receipt's selected tuple, not another usable Session publisher. */
export async function isSessionInputTargetCurrentForPublisherInTx(tx: Tx, value: unknown, publisher: Readonly<{
    accountId: string; sessionId: string; machineId: string;
}>): Promise<boolean> {
    const receipt = readStoredSessionInputAdmissionReceipt(value);
    if (value != null && !receipt) return false;
    const target = receipt?.admittedTarget;
    if (!target) {
        // Released target-less input only predates foreign Machine placement.
        // Never infer a foreign target from another usable AccessKey tuple.
        const machine = await tx.machine.findUnique({ where: { id: publisher.machineId }, select: { accountId: true } });
        return machine !== null && machine.accountId === publisher.accountId;
    }
    return target.accountId === publisher.accountId && target.sessionId === publisher.sessionId
        && target.machineId === publisher.machineId && await isCurrentSessionInputMachineTargetInTx(tx, target);
}

/** The sole server receipt builder; callers supply transaction-final admission. */
export function buildSessionInputAdmissionReceipt(input: (
    | Readonly<{ issuer: "authenticatedAccount"; access: EffectiveSessionAccess; callerInputConstraints?: CallerInputConstraintsV1; admittedTarget?: SessionInputMachineTargetV1 }>
    | Readonly<{ issuer: "authenticatedMachine"; callerInputConstraints?: CallerInputConstraintsV1; admittedTarget?: SessionInputMachineTargetV1 }>
    ) & Readonly<{ nextTurnNote?: SessionInputAdmissionReceiptV1['nextTurnNote'] }>,
): SessionInputAdmissionReceiptV1 {
    const constraints = input.callerInputConstraints
        && (input.callerInputConstraints.models !== null || input.callerInputConstraints.permissionModes !== null)
        ? { callerInputConstraints: {
            models: input.callerInputConstraints.models,
            permissionModes: input.callerInputConstraints.permissionModes,
        } } : {};
    if (input.issuer === "authenticatedMachine") {
        return SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: input.issuer, ...constraints,
            ...(input.nextTurnNote ? { nextTurnNote: input.nextTurnNote } : {}),
            ...(input.admittedTarget ? { admittedTarget: input.admittedTarget } : {}) });
    }
    if (!input.access.capabilities.submitAgentInput || input.access.level === "view") {
        throw new TypeError("Session input admission requires current input capability");
    }
    return SessionInputAdmissionReceiptV1Schema.parse({
        v: 1,
        issuer: input.issuer,
        actorAccountId: input.access.accountId,
        sessionRelationship: input.access.level === "owner" ? "owner"
            : input.access.level === "admin" ? "sharedAdmin" : "sharedEditor",
        ...constraints,
        ...(input.nextTurnNote ? { nextTurnNote: input.nextTurnNote } : {}),
        ...(input.admittedTarget ? { admittedTarget: input.admittedTarget } : {}),
    });
}

/** Shared transcript readers receive attribution, never the native-only private rule proof. */
export function projectSessionInputAdmissionReceipt(value: unknown): Readonly<{ inputAdmissionReceipt?: SessionInputAdmissionReceiptV1 }> {
    if (value === null || value === undefined) return {};
    const receipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).parse(value);
    const { followSources: _privateFollowSources, followRelations: _privateFollowRelations, ...publicReceipt } = receipt;
    return { inputAdmissionReceipt: publicReceipt };
}

/** Relationship changes never change the identity of an already admitted input. */
export function isSameSessionInputAdmissionIssuer(
    existing: SessionInputAdmissionReceiptV1,
    current: SessionInputAdmissionReceiptV1,
): boolean {
    return existing.issuer === current.issuer
        && existing.nextTurnNote === current.nextTurnNote
        && (existing.issuer === "authenticatedMachine"
            || current.issuer === "authenticatedAccount" && existing.actorAccountId === current.actorAccountId)
        && (existing.admittedTarget === undefined ? current.admittedTarget === undefined
            : current.admittedTarget !== undefined
                && existing.admittedTarget.homeId === current.admittedTarget.homeId
                && existing.admittedTarget.accountId === current.admittedTarget.accountId
                && existing.admittedTarget.sessionId === current.admittedTarget.sessionId
                && existing.admittedTarget.machineId === current.admittedTarget.machineId
                && existing.admittedTarget.installationId === current.admittedTarget.installationId);
}
