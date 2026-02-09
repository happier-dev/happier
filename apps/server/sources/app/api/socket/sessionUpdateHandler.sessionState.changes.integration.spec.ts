import { describe, expect, it, vi } from "vitest";
import { createInTxHarness } from "../testkit/txHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess: vi.fn(async () => ({ accessLevel: "edit" })),
    requireAccessLevel: vi.fn(() => true),
}));

const emitUpdate = vi.fn();
const buildUpdateSessionUpdate = vi.fn((_sid: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-session" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildUpdateSessionUpdate,
    buildNewMessageUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(() => ({ t: "session-activity" })),
}));

const randomKeyNaked = vi.fn();
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async (_tx: any, params: any) => {
    if (params.accountId === "owner") return 201;
    if (params.accountId === "u2") return 202;
    return 999;
});
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/app/monitoring/metrics2", () => ({
    sessionAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        isSessionValid: vi.fn(async () => true),
        queueSessionUpdate: vi.fn(),
    },
}));

vi.mock("@/storage/prisma", () => ({
    isPrismaErrorCode: () => false,
}));

vi.mock("@/storage/db", () => ({
    db: {},
}));

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({
            session: {
                findUnique: async (args: any) => {
                    if (args?.select?.metadataVersion === true) {
                        return { metadataVersion: 1, metadata: "m1" };
                    }
                    if (args?.select?.agentStateVersion === true) {
                        return { agentStateVersion: 1, agentState: "a1" };
                    }
                    if (args?.select?.accountId === true) {
                        return { accountId: "owner", shares: [{ sharedWithUserId: "u2" }] };
                    }
                    return null;
                },
                updateMany: async () => ({ count: 1 }),
            },
    }));

    return { afterTx, inTx };
});

describe("sessionUpdateHandler (session state AccountChange integration)", () => {
    it("marks session metadata updates for all participants and emits updates using those cursors", async () => {
        randomKeyNaked.mockReset().mockReturnValueOnce("upd-a").mockReturnValueOnce("upd-b");
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "update-metadata");

        const callback = vi.fn();
        await handler({ sid: "s1", metadata: "m2", expectedVersion: 1 }, callback);

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "session", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u2", kind: "session", entityId: "s1" }));

        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 201, "upd-a", { value: "m2", version: 2 });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, "upd-b", { value: "m2", version: 2 });

        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledWith({ result: "success", version: 2, metadata: "m2" });
    });

    it("marks session agentState updates for all participants and emits updates using those cursors", async () => {
        emitUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        markAccountChanged.mockClear();

        randomKeyNaked.mockReset().mockReturnValueOnce("upd-c").mockReturnValueOnce("upd-d");
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "update-state");

        const callback = vi.fn();
        await handler({ sid: "s1", agentState: "a2", expectedVersion: 1 }, callback);

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "session", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u2", kind: "session", entityId: "s1" }));

        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 201, "upd-c", undefined, { value: "a2", version: 2 });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, "upd-d", undefined, { value: "a2", version: 2 });

        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledWith({ result: "success", version: 2, agentState: "a2" });
    });
});
