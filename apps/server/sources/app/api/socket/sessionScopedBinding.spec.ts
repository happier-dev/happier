import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionFindUniqueMock = vi.fn();
const accessKeyFindUniqueMock = vi.fn();
const observeSessionScopedBindingStageMock = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findUnique: (...args: unknown[]) => sessionFindUniqueMock(...args),
        },
        accessKey: {
            findUnique: (...args: unknown[]) => accessKeyFindUniqueMock(...args),
        },
    },
}));

vi.mock("@/app/monitoring/metrics/sessionBindingMetrics", () => ({
    observeSessionScopedBindingStage: (...args: unknown[]) => observeSessionScopedBindingStageMock(...args),
}));

import {
    canReadAccessKeyFromSessionScopedSocket,
    canPublishFromSessionScopedSocket,
    resolveSessionScopedSocketBinding,
} from "./sessionScopedBinding";

describe("resolveSessionScopedSocketBinding", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("resolves a machine-bound binding from the access key relation without a separate session lookup", async () => {
        sessionFindUniqueMock.mockImplementation(() => {
            throw new Error("machine-bound binding should not query session separately");
        });
        accessKeyFindUniqueMock.mockResolvedValueOnce({
            machineId: "m1",
                machine: {
                    active: true,
                    lastActiveAt: new Date("2026-04-20T12:00:00.000Z"),
                    revokedAt: null,
                    replacedByMachineId: null,
                },
            session: {
                active: true,
                lastActiveAt: new Date("2026-04-20T11:00:00.000Z"),
            },
        });

        await expect(
            resolveSessionScopedSocketBinding({
                userId: "u1",
                sessionId: "s1",
                machineId: "m1",
            }),
        ).resolves.toEqual({
            ok: true,
            binding: {
                sessionId: "s1",
                machineId: "m1",
                proof: "machine-access-key",
            },
            cacheWarmState: {
                session: {
                    active: true,
                    lastActiveAt: new Date("2026-04-20T11:00:00.000Z"),
                },
                machine: {
                    active: true,
                    lastActiveAt: new Date("2026-04-20T12:00:00.000Z"),
                },
            },
        });
        expect(observeSessionScopedBindingStageMock).toHaveBeenCalledWith(
            expect.objectContaining({
                stage: "machine_access_key_lookup",
                result: "ok",
                durationMs: expect.any(Number),
            }),
        );
    });

    it("keeps the owner-session path on the session lookup when no machine binding is requested", async () => {
        sessionFindUniqueMock.mockResolvedValueOnce({
            accountId: "u1",
            active: true,
            lastActiveAt: new Date("2026-04-20T10:00:00.000Z"),
        });

        await expect(
            resolveSessionScopedSocketBinding({
                userId: "u1",
                sessionId: "s1",
            }),
        ).resolves.toEqual({
            ok: true,
            binding: {
                sessionId: "s1",
                machineId: null,
                proof: "owner-session",
            },
            cacheWarmState: {
                session: {
                    active: true,
                    lastActiveAt: new Date("2026-04-20T10:00:00.000Z"),
                },
                machine: null,
            },
        });
        expect(accessKeyFindUniqueMock).not.toHaveBeenCalled();
        expect(observeSessionScopedBindingStageMock).toHaveBeenCalledWith(
            expect.objectContaining({
                stage: "owner_session_lookup",
                result: "ok",
                durationMs: expect.any(Number),
            }),
        );
    });

    it("records an error-stage observation when the machine access key is missing", async () => {
        accessKeyFindUniqueMock.mockResolvedValueOnce(null);

        await expect(
            resolveSessionScopedSocketBinding({
                userId: "u1",
                sessionId: "s1",
                machineId: "m1",
            }),
        ).resolves.toEqual({
            ok: false,
            statusCode: 403,
            error: "invalid-session-access-key",
        });

        expect(observeSessionScopedBindingStageMock).toHaveBeenCalledWith(
            expect.objectContaining({
                stage: "machine_access_key_lookup",
                result: "error",
                durationMs: expect.any(Number),
            }),
        );
    });

    it("rejects a machine-bound binding when a lingering access key points at a replaced machine", async () => {
        accessKeyFindUniqueMock.mockResolvedValueOnce({
            machineId: "m1",
            machine: {
                active: true,
                lastActiveAt: new Date("2026-04-20T12:00:00.000Z"),
                revokedAt: null,
                replacedByMachineId: "m2",
            },
            session: {
                active: true,
                lastActiveAt: new Date("2026-04-20T11:00:00.000Z"),
            },
        });

        await expect(
            resolveSessionScopedSocketBinding({
                userId: "u1",
                sessionId: "s1",
                machineId: "m1",
            }),
        ).resolves.toEqual({
            ok: false,
            statusCode: 403,
            error: "invalid-session-access-key",
        });
    });

    it("rejects machine-bound publishes when a lingering access key points at a replaced machine", async () => {
        accessKeyFindUniqueMock.mockResolvedValueOnce({
            machineId: "m1",
            machine: {
                revokedAt: null,
                replacedByMachineId: "m2",
            },
        });

        await expect(
            canPublishFromSessionScopedSocket({
                socket: {
                    data: {
                        clientType: "session-scoped",
                        sessionScopedBinding: {
                            sessionId: "s1",
                            machineId: "m1",
                            proof: "machine-access-key",
                        },
                    },
                } as any,
                connection: {
                    connectionType: "session-scoped",
                    socket: {} as any,
                    userId: "u1",
                    sessionId: "s1",
                },
                sessionId: "s1",
                requireMachineBinding: true,
            }),
        ).resolves.toBe(false);
    });

    it("keeps owner-session sockets authorized to read machine access keys within the bound session", async () => {
        await expect(
            canReadAccessKeyFromSessionScopedSocket({
                socket: {
                    data: {
                        clientType: "session-scoped",
                        sessionScopedBinding: {
                            sessionId: "s1",
                            machineId: null,
                            proof: "owner-session",
                        },
                    },
                } as any,
                connection: {
                    connectionType: "session-scoped",
                    socket: {} as any,
                    userId: "u1",
                    sessionId: "s1",
                },
                sessionId: "s1",
                machineId: "m2",
            }),
        ).resolves.toBe(true);

        expect(accessKeyFindUniqueMock).not.toHaveBeenCalled();
    });

    it("rejects machine-bound sockets that target a sibling machine access key in the same session", async () => {
        await expect(
            canReadAccessKeyFromSessionScopedSocket({
                socket: {
                    data: {
                        clientType: "session-scoped",
                        sessionScopedBinding: {
                            sessionId: "s1",
                            machineId: "m1",
                            proof: "machine-access-key",
                        },
                    },
                } as any,
                connection: {
                    connectionType: "session-scoped",
                    socket: {} as any,
                    userId: "u1",
                    sessionId: "s1",
                },
                sessionId: "s1",
                machineId: "m2",
            }),
        ).resolves.toBe(false);

        expect(accessKeyFindUniqueMock).not.toHaveBeenCalled();
    });
});
