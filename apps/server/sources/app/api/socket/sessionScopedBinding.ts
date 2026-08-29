import type { Socket } from "socket.io";

import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { observeSessionScopedBindingStage } from "@/app/monitoring/metrics/sessionBindingMetrics";
import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

export type SessionScopedBindingProof = "owner-session" | "machine-access-key";

export type SessionScopedSocketBinding = Readonly<{
    sessionId: string;
    machineId: string | null;
    proof: SessionScopedBindingProof;
}>;

export type SessionScopedSocketBindingCacheWarmState = Readonly<{
    session: Readonly<{
        active: boolean;
        lastActiveAt: Date | null;
    }>;
    machine: Readonly<{
        active: boolean;
        lastActiveAt: Date | null;
    }> | null;
}>;

type SessionScopedBindingResolution =
    | Readonly<{ ok: true; binding: SessionScopedSocketBinding; cacheWarmState: SessionScopedSocketBindingCacheWarmState }>
    | Readonly<{ ok: false; statusCode: number; error: "invalid-session" | "invalid-session-access-key" }>;

type MachineAccessKeyAvailability = Readonly<{
    machineId: string;
    machine: Readonly<{
        revokedAt: Date | null;
        replacedByMachineId: string | null;
    }>;
}> | null;

/**
 * Session-level form of the same machine access correspondence: proves that at
 * least one available Account machine currently holds the session access
 * relationship without a caller-nominated machine. Sessions may retain keys
 * from several machines (including revoked/replaced ones), so the incumbent
 * availability predicate (`revokedAt: null AND replacedByMachineId: null` —
 * the exact predicate behind classifyMachineAvailabilityState) is expressed in
 * the query itself: every candidate row is an available machine and whichever
 * row the unordered read returns proves the correspondence. The classification
 * below is the same-owner re-check, and the opaque payload is never read.
 */
export async function hasCurrentMachineAccessForSessionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    sessionId: string;
}>): Promise<boolean> {
    const accessKey = await params.tx.accessKey.findFirst({
        where: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            machine: { revokedAt: null, replacedByMachineId: null },
            session: { accountId: params.accountId },
        },
        select: {
            machine: { select: { revokedAt: true, replacedByMachineId: true } },
            session: { select: { accountId: true } },
        },
    });
    return accessKey !== null
        && accessKey.session.accountId === params.accountId
        && classifyMachineAvailabilityState(accessKey.machine) === "available";
}

/** Revalidates the exact machine/session access relationship inside the caller's transaction. */
export async function hasCurrentSessionScopedMachineAccessInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
    sessionId: string;
}>): Promise<boolean> {
    const accessKey = await params.tx.accessKey.findUnique({
        where: {
            accountId_machineId_sessionId: {
                accountId: params.accountId,
                machineId: params.machineId,
                sessionId: params.sessionId,
            },
        },
        select: {
            machine: { select: { revokedAt: true, replacedByMachineId: true } },
            session: { select: { accountId: true } },
        },
    });
    return accessKey !== null
        && accessKey.session.accountId === params.accountId
        && classifyMachineAvailabilityState(accessKey.machine) === "available";
}

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export async function resolveSessionScopedSocketBinding(params: Readonly<{
    userId: string;
    sessionId: string;
    machineId?: string | null;
}>): Promise<SessionScopedBindingResolution> {
    const sessionId = normalizeNonEmptyString(params.sessionId);
    const machineId = normalizeNonEmptyString(params.machineId);
    if (!sessionId) {
        return { ok: false, statusCode: 403, error: "invalid-session" };
    }

    if (!machineId) {
        const startedAt = Date.now();
        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: { accountId: true, active: true, lastActiveAt: true },
        });
        if (!session || session.accountId !== params.userId) {
            observeSessionScopedBindingStage({
                stage: "owner_session_lookup",
                result: "error",
                durationMs: Date.now() - startedAt,
            });
            return { ok: false, statusCode: 403, error: "invalid-session" };
        }
        observeSessionScopedBindingStage({
            stage: "owner_session_lookup",
            result: "ok",
            durationMs: Date.now() - startedAt,
        });
        return {
            ok: true,
            binding: {
                sessionId,
                machineId: null,
                proof: "owner-session",
            },
            cacheWarmState: {
                session: {
                    active: session.active,
                    lastActiveAt: session.lastActiveAt,
                },
                machine: null,
            },
        };
    }

    const startedAt = Date.now();
    const accessKey = await db.accessKey.findUnique({
            where: {
                accountId_machineId_sessionId: {
                    accountId: params.userId,
                    machineId,
                    sessionId,
                },
            },
            select: {
                machineId: true,
                session: {
                    select: {
                        active: true,
                        lastActiveAt: true,
                    },
                },
                machine: {
                    select: {
                        active: true,
                        lastActiveAt: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                    },
                },
            },
        });
    if (
        !accessKey
        || classifyMachineAvailabilityState(accessKey.machine) !== "available"
    ) {
        observeSessionScopedBindingStage({
            stage: "machine_access_key_lookup",
            result: "error",
            durationMs: Date.now() - startedAt,
        });
        return { ok: false, statusCode: 403, error: "invalid-session-access-key" };
    }
    observeSessionScopedBindingStage({
        stage: "machine_access_key_lookup",
        result: "ok",
        durationMs: Date.now() - startedAt,
    });

    return {
        ok: true,
        binding: {
            sessionId,
            machineId,
            proof: "machine-access-key",
        },
        cacheWarmState: {
            session: {
                active: accessKey.session.active,
                lastActiveAt: accessKey.session.lastActiveAt,
            },
            machine: {
                active: accessKey.machine.active,
                lastActiveAt: accessKey.machine.lastActiveAt,
            },
        },
    };
}

export function readSessionScopedSocketBinding(socket: Socket): SessionScopedSocketBinding | null {
    const binding = (socket.data as { sessionScopedBinding?: unknown } | undefined)?.sessionScopedBinding;
    if (!binding || typeof binding !== "object") return null;
    const candidate = binding as Record<string, unknown>;
    const sessionId = normalizeNonEmptyString(candidate.sessionId);
    const proof = candidate.proof === "machine-access-key" || candidate.proof === "owner-session"
        ? candidate.proof
        : null;
    const machineId = normalizeNonEmptyString(candidate.machineId);
    if (!sessionId || !proof) return null;
    if (proof === "machine-access-key" && !machineId) return null;
    return {
        sessionId,
        machineId,
        proof,
    };
}

async function readMachineAccessKeyAvailability(params: Readonly<{
    accountId: string;
    sessionId: string;
    machineId: string;
}>): Promise<MachineAccessKeyAvailability> {
    return await db.accessKey.findUnique({
        where: {
            accountId_machineId_sessionId: {
                accountId: params.accountId,
                machineId: params.machineId,
                sessionId: params.sessionId,
            },
        },
        select: {
            machineId: true,
            machine: { select: { revokedAt: true, replacedByMachineId: true } },
        },
    });
}

function isAvailableMachineAccessKey(accessKey: MachineAccessKeyAvailability): boolean {
    return Boolean(
        accessKey
        && classifyMachineAvailabilityState(accessKey.machine) === "available",
    );
}

function readSessionScopedRpcMethodSessionId(method: string): string | null {
    const lastColon = method.lastIndexOf(":");
    if (lastColon <= 0) {
        return null;
    }
    return normalizeNonEmptyString(method.slice(0, lastColon));
}

async function canUseSessionScopedRpcMethodWithMachineAccessKey(params: Readonly<{
    socket: Socket;
    accountId: string;
    method: string;
}>): Promise<boolean> {
    const binding = readSessionScopedSocketBinding(params.socket);
    if (!binding || binding.proof !== "machine-access-key") {
        return false;
    }

    const methodSessionId = readSessionScopedRpcMethodSessionId(params.method);
    if (methodSessionId !== binding.sessionId) {
        return false;
    }

    const machineId = binding.machineId;
    if (!machineId) {
        return false;
    }

    return isAvailableMachineAccessKey(await readMachineAccessKeyAvailability({
        accountId: params.accountId,
        sessionId: binding.sessionId,
        machineId,
    }));
}

export async function canRegisterSessionScopedRpcMethod(params: Readonly<{
    socket: Socket;
    accountId: string;
    method: string;
}>): Promise<boolean> {
    const clientType = (params.socket.data as { clientType?: unknown } | undefined)?.clientType;
    if (clientType !== "session-scoped") {
        return true;
    }

    return canUseSessionScopedRpcMethodWithMachineAccessKey(params);
}

export async function canCallSessionScopedRpcMethod(params: Readonly<{
    socket: Socket;
    accountId: string;
    method: string;
}>): Promise<boolean> {
    const clientType = (params.socket.data as { clientType?: unknown } | undefined)?.clientType;
    if (clientType !== "session-scoped") {
        return true;
    }

    return canUseSessionScopedRpcMethodWithMachineAccessKey(params);
}

function readSessionScopedConnectionSessionId(connection: ClientConnection): string | null {
    if (connection.connectionType !== "session-scoped") return null;
    return normalizeNonEmptyString(connection.sessionId);
}

export function canTargetSessionFromSocket(params: Readonly<{
    socket: Socket;
    connection: ClientConnection;
    sessionId: string;
}>): boolean {
    const sessionId = normalizeNonEmptyString(params.sessionId);
    if (!sessionId) return false;
    if (params.connection.connectionType !== "session-scoped") {
        return true;
    }

    const bindingSessionId = readSessionScopedSocketBinding(params.socket)?.sessionId ?? null;
    const connectionSessionId = readSessionScopedConnectionSessionId(params.connection);
    const scopedSessionIds = [bindingSessionId, connectionSessionId].filter((value): value is string => value !== null);
    if (scopedSessionIds.length === 0) return false;
    return scopedSessionIds.every((scopedSessionId) => scopedSessionId === sessionId);
}

export async function canReadAccessKeyFromSessionScopedSocket(params: Readonly<{
    socket: Socket;
    connection: ClientConnection;
    sessionId: string;
    machineId: string;
}>): Promise<boolean> {
    const machineId = normalizeNonEmptyString(params.machineId);
    if (!machineId) {
        return false;
    }
    if (!canTargetSessionFromSocket(params)) {
        return false;
    }
    if (params.connection.connectionType !== "session-scoped") {
        return true;
    }

    const binding = readSessionScopedSocketBinding(params.socket);
    if (!binding || binding.proof !== "machine-access-key") {
        return true;
    }
    if (binding.machineId !== machineId) {
        return false;
    }

    return isAvailableMachineAccessKey(await readMachineAccessKeyAvailability({
        accountId: params.connection.userId,
        machineId,
        sessionId: binding.sessionId,
    }));
}

export async function canPublishFromSessionScopedSocket(params: Readonly<{
    socket: Socket;
    connection: ClientConnection;
    sessionId: string;
    requireMachineBinding?: boolean;
}>): Promise<boolean> {
    if (params.connection.connectionType !== "session-scoped") {
        return false;
    }
    if (!canTargetSessionFromSocket(params)) {
        return false;
    }

    const binding = readSessionScopedSocketBinding(params.socket);
    if (!binding) {
        return false;
    }
    if (params.requireMachineBinding === true) {
        if (binding.proof !== "machine-access-key") {
            return false;
        }
        const machineId = binding.machineId;
        if (!machineId) {
            return false;
        }

        const accessKey = await readMachineAccessKeyAvailability({
            accountId: params.connection.userId,
            machineId,
            sessionId: binding.sessionId,
        });
        if (!isAvailableMachineAccessKey(accessKey)) {
            return false;
        }
    }
    return true;
}
