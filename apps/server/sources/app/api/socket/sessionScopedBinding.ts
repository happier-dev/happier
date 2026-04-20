import type { Socket } from "socket.io";

import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { observeSessionScopedBindingStage } from "@/app/monitoring/metrics/sessionBindingMetrics";
import { db } from "@/storage/db";

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
                    },
                },
            },
        });
    if (!accessKey) {
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
            machine: accessKey.machine.revokedAt
                ? null
                : {
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

export function canRegisterSessionScopedRpcMethod(params: Readonly<{
    socket: Socket;
    method: string;
}>): boolean {
    const clientType = (params.socket.data as { clientType?: unknown } | undefined)?.clientType;
    if (clientType !== "session-scoped") {
        return true;
    }

    const binding = readSessionScopedSocketBinding(params.socket);
    if (!binding || binding.proof !== "machine-access-key") {
        return false;
    }

    const lastColon = params.method.lastIndexOf(":");
    if (lastColon <= 0) {
        return false;
    }
    return params.method.slice(0, lastColon) === binding.sessionId;
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

    const binding = readSessionScopedSocketBinding(params.socket);
    if (!binding || binding.sessionId !== params.sessionId) {
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

        const accessKey = await db.accessKey.findUnique({
            where: {
                accountId_machineId_sessionId: {
                    accountId: params.connection.userId,
                    machineId,
                    sessionId: binding.sessionId,
                },
            },
            select: { machineId: true },
        });
        if (!accessKey) {
            return false;
        }
    }
    return true;
}
