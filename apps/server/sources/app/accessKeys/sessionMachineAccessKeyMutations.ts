import { readMachineAvailabilityStateInTx } from "@/app/machines/machineStateGuards";
import { resolveMachineAdmissionInTx } from "@/app/machines/machineAccess";
import { isPrismaErrorCode } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

/**
 * Canonical `AccessKey(accountId, machineId, sessionId)` writer.
 *
 * `AccessKey` is the exact Account–Machine–Session correspondence consumed by
 * Session-scoped socket admission, so every writer goes through this service:
 * route handlers authenticate and parse, then call it, and transaction callers
 * compose it with their other writes. It never mints a Session/Machine binding
 * of its own — the tuple must already exist and the Machine must be available.
 *
 * Callers that are not composing a wider transaction pass the shared client.
 */

export type SessionMachineAccessKeyBinding = Readonly<{
    accountId: string;
    machineId: string;
    sessionId: string;
}>;

export type SessionMachineAccessKeyRow = Readonly<{
    data: string;
    dataVersion: number;
    createdAt: Date;
    updatedAt: Date;
}>;

export type SessionMachineBindingState = "available" | "missing";

export type CreateSessionMachineAccessKeyResult =
    | Readonly<{ ok: true; created: boolean; accessKey: SessionMachineAccessKeyRow }>
    | Readonly<{ ok: false; reason: "binding-not-found" | "already-exists" }>;

export type UpdateSessionMachineAccessKeyResult =
    | Readonly<{ ok: true; version: number }>
    | Readonly<{ ok: false; reason: "not-found" }>
    | Readonly<{
        ok: false;
        reason: "version-mismatch";
        currentVersion: number;
        currentData: string;
    }>;

/** The Session must belong to the Account and the Machine must be available. */
export async function readSessionMachineBindingStateInTx(
    tx: Tx,
    binding: SessionMachineAccessKeyBinding,
): Promise<SessionMachineBindingState> {
    const [session, machine] = await Promise.all([
        tx.session.findFirst({
            where: { id: binding.sessionId, accountId: binding.accountId },
            select: { id: true },
        }),
        readRequesterMachineAvailabilityInTx(tx, binding),
    ]);
    return session !== null && machine === "available" ? "available" : "missing";
}

/** Only the uninstalled owned predecessor tuple predates C41 installation admission. */
async function readRequesterMachineAvailabilityInTx(tx: Tx, binding: SessionMachineAccessKeyBinding): Promise<SessionMachineBindingState> {
    const machine = await tx.machine.findUnique({ where: { id: binding.machineId }, select: { accountId: true, installationId: true } });
    if (machine?.accountId === binding.accountId && machine.installationId === null) {
        return await readMachineAvailabilityStateInTx({ tx, accountId: binding.accountId, machineId: binding.machineId }) === "available" ? "available" : "missing";
    }
    const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId, machineId: binding.machineId });
    return admission.kind === "admitted" ? "available" : "missing";
}

export async function readSessionMachineAccessKeyInTx(
    tx: Tx,
    binding: SessionMachineAccessKeyBinding,
): Promise<SessionMachineAccessKeyRow | null> {
    return tx.accessKey.findUnique({
        where: { accountId_machineId_sessionId: { ...binding } },
        select: {
            data: true,
            dataVersion: true,
            createdAt: true,
            updatedAt: true,
        },
    });
}

/**
 * Returns the exact Session rooms whose socket admission depends on one
 * Machine's AccessKey tuples. Machine revoke/replacement uses this projection
 * before invalidating the Machine so the existing socket-room owner can evict
 * both established profiles after commit, including across server replicas.
 * The input Account is the Machine custodian; each returned Account is the
 * requester owning that Session's exact AccessKey tuple.
 */
export async function readMachineAccessKeySessionBindingsInTx(
    tx: Tx,
    binding: Readonly<{ accountId: string; machineId: string }>,
): Promise<Readonly<{ accountId: string; sessionId: string }>[]> {
    return tx.accessKey.findMany({
        where: {
            machineId: binding.machineId,
            machine: { accountId: binding.accountId },
        },
        select: { accountId: true, sessionId: true },
    });
}

export async function createSessionMachineAccessKeyInTx(
    tx: Tx,
    params: SessionMachineAccessKeyBinding & Readonly<{ data: string }>,
): Promise<CreateSessionMachineAccessKeyResult> {
    const binding: SessionMachineAccessKeyBinding = {
        accountId: params.accountId,
        machineId: params.machineId,
        sessionId: params.sessionId,
    };

    if (await readSessionMachineBindingStateInTx(tx, binding) !== "available") {
        return { ok: false, reason: "binding-not-found" };
    }

    if (await readSessionMachineAccessKeyInTx(tx, binding)) {
        return { ok: false, reason: "already-exists" };
    }

    try {
        const accessKey = await tx.accessKey.create({
            data: { ...binding, data: params.data, dataVersion: 1 },
            select: {
                data: true,
                dataVersion: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        return { ok: true, created: true, accessKey };
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;

        // A concurrent writer won the unique tuple. The binding is already
        // established, so the caller's retry observes the winner instead of a
        // conflict.
        const winner = await readSessionMachineAccessKeyInTx(tx, binding);
        if (!winner) return { ok: false, reason: "already-exists" };
        return { ok: true, created: false, accessKey: winner };
    }
}

export async function updateSessionMachineAccessKeyDataInTx(
    tx: Tx,
    params: SessionMachineAccessKeyBinding & Readonly<{
        data: string;
        expectedVersion: number;
    }>,
): Promise<UpdateSessionMachineAccessKeyResult> {
    const binding: SessionMachineAccessKeyBinding = {
        accountId: params.accountId,
        machineId: params.machineId,
        sessionId: params.sessionId,
    };

    // The tuple already proves Session correspondence, so currentness here is
    // the Machine's availability.
    const machineState = await readSessionMachineBindingStateInTx(tx, binding);
    if (machineState !== "available") {
        return { ok: false, reason: "not-found" };
    }

    const current = await readSessionMachineAccessKeyInTx(tx, binding);
    if (!current) return { ok: false, reason: "not-found" };
    if (current.dataVersion !== params.expectedVersion) {
        return {
            ok: false,
            reason: "version-mismatch",
            currentVersion: current.dataVersion,
            currentData: current.data,
        };
    }

    const { count } = await tx.accessKey.updateMany({
        where: { ...binding, dataVersion: params.expectedVersion },
        data: {
            data: params.data,
            dataVersion: params.expectedVersion + 1,
            updatedAt: new Date(),
        },
    });

    if (count === 0) {
        const winner = await readSessionMachineAccessKeyInTx(tx, binding);
        if (!winner) return { ok: false, reason: "not-found" };
        return {
            ok: false,
            reason: "version-mismatch",
            currentVersion: winner.dataVersion,
            currentData: winner.data,
        };
    }

    return { ok: true, version: params.expectedVersion + 1 };
}
