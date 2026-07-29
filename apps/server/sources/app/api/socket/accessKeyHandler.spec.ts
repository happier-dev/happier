import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const sessionFindFirst = vi.fn();
const machineFindFirst = vi.fn();
const accessKeyFindUnique = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findFirst: sessionFindFirst,
        },
        machine: {
            findFirst: machineFindFirst,
        },
        accessKey: {
            findUnique: accessKeyFindUnique,
        },
    },
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("accessKeyHandler", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("rejects machine-bound session-scoped access-key reads for a sibling machine in the same session", async () => {
        const { accessKeyHandler } = await import("./accessKeyHandler");
        const socket = createFakeSocket({
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "s-bound",
                    machineId: "m-bound",
                    proof: "machine-access-key",
                },
            },
        });

        accessKeyHandler("user-1", socket as any, {
            connectionType: "session-scoped",
            socket: socket as any,
            userId: "user-1",
            sessionId: "s-bound",
        } as any);

        const callback = vi.fn();
        await getSocketHandler(socket, "access-key-get")({ sessionId: "s-bound", machineId: "m-other" }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "Forbidden" });
        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(machineFindFirst).not.toHaveBeenCalled();
        expect(accessKeyFindUnique).not.toHaveBeenCalled();
    });

    it("rejects session-scoped access-key reads whose target session does not match the socket binding", async () => {
        const { accessKeyHandler } = await import("./accessKeyHandler");
        const socket = createFakeSocket({
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "s-bound",
                    machineId: null,
                    proof: "owner-session",
                },
            },
        });

        accessKeyHandler("user-1", socket as any, {
            connectionType: "session-scoped",
            socket: socket as any,
            userId: "user-1",
            sessionId: "s-bound",
        } as any);

        const callback = vi.fn();
        await getSocketHandler(socket, "access-key-get")({ sessionId: "s-other", machineId: "m-1" }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "Forbidden" });
        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(machineFindFirst).not.toHaveBeenCalled();
        expect(accessKeyFindUnique).not.toHaveBeenCalled();
    });
});
