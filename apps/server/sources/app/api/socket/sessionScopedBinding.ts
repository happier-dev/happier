import type { Socket } from "socket.io";

import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { observeSessionScopedBindingStage } from "@/app/monitoring/metrics/sessionBindingMetrics";
import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { readSessionMachineBindingStateInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";

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

/**
 * Proves at least one currently usable requester tuple without a nominated
 * Machine. Retained keys are not grants: the canonical binding owner rechecks
 * C41 for each foreign candidate. An unavailable first candidate cannot hide a
 * usable second Machine. The opaque key payload is never read.
 */
export async function hasCurrentMachineAccessForSessionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    sessionId: string;
}>): Promise<boolean> {
    const accessKeys = await params.tx.accessKey.findMany({
        where: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            machine: { revokedAt: null, replacedByMachineId: null },
            session: { accountId: params.accountId },
        },
        select: {
            machineId: true,
            machine: { select: { revokedAt: true, replacedByMachineId: true } },
            session: { select: { accountId: true } },
        },
    });
    for (const key of accessKeys) {
        if (key.session.accountId === params.accountId && await readSessionMachineBindingStateInTx(params.tx, {
            accountId: params.accountId, sessionId: params.sessionId, machineId: key.machineId,
        }) === "available") return true;
    }
    return false;
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
        && classifyMachineAvailabilityState(accessKey.machine) === "available"
        && await readSessionMachineBindingStateInTx(params.tx, params) === "available";
}

type SessionActionRpcSourceBinding = Readonly<{
    accountId: string;
    machineId: string;
    installationId: string;
    sourceSessionId: string;
    targetSessionId?: string;
}>;

/** Current persisted half of the already-admitted publisher source proof. */
export async function hasCurrentSessionActionRpcSourceBindingInTx(tx: Tx, params: SessionActionRpcSourceBinding): Promise<boolean> {
    const machine = await tx.machine.findUnique({ where: { id: params.machineId }, select: {
        installationId: true, kind: true, revokedAt: true, replacedByMachineId: true,
    } });
    if (classifyMachineAvailabilityState(machine) !== 'available'
        || machine?.kind === 'ephemeral_session_runner' || machine?.installationId !== params.installationId
        || !await hasCurrentSessionScopedMachineAccessInTx({ tx, accountId: params.accountId,
            machineId: params.machineId, sessionId: params.sourceSessionId })) return false;
    if (params.targetSessionId && params.targetSessionId !== params.sourceSessionId) {
        const target = await tx.session.findUnique({ where: { id: params.targetSessionId }, select: { accountId: true } });
        if (target?.accountId !== params.accountId) return false;
    }
    return true;
}

/** The installed daemon may attest original Session facts only while it hosts that Account's Session. */
export async function hasCurrentSessionActionRpcSourceBinding(params: SessionActionRpcSourceBinding & Readonly<{
    resolveCurrentSessionMachine?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<string | null>;
}>): Promise<boolean> {
    if (!params.resolveCurrentSessionMachine) return false;
    if (!await hasCurrentSessionActionRpcSourceBindingInTx(db, params)) return false;
    try {
        return await params.resolveCurrentSessionMachine({ accountId: params.accountId, sessionId: params.sourceSessionId }) === params.machineId
            && await hasCurrentSessionActionRpcSourceBindingInTx(db, params);
    } catch { return false; }
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
        || await readSessionMachineBindingStateInTx(db, { accountId: params.userId, sessionId, machineId }) !== "available"
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

    return hasCurrentSessionScopedMachineAccessInTx({
        tx: db,
        accountId: params.accountId,
        sessionId: binding.sessionId,
        machineId,
    });
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

    return hasCurrentSessionScopedMachineAccessInTx({
        tx: db,
        accountId: params.connection.userId,
        machineId,
        sessionId: binding.sessionId,
    });
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

        const available = await hasCurrentSessionScopedMachineAccessInTx({
            tx: db,
            accountId: params.connection.userId,
            machineId,
            sessionId: binding.sessionId,
        });
        if (!available) {
            return false;
        }
    }
    return true;
}
