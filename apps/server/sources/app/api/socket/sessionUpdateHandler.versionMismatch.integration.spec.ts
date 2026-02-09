import { describe, expect, it, vi } from "vitest";
import { UpdateMetadataAckResponseSchema, UpdateStateAckResponseSchema } from "@happier-dev/protocol/updates";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const updateSessionMetadata = vi.fn();
const updateSessionAgentState = vi.fn();
vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage: vi.fn(),
    updateSessionMetadata: (...args: any[]) => updateSessionMetadata(...args),
    updateSessionAgentState: (...args: any[]) => updateSessionAgentState(...args),
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildUpdateSessionUpdate: vi.fn(),
    buildNewMessageUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(),
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "id") }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/monitoring/metrics2", () => ({
    sessionAliveEventsCounter: { inc: vi.fn() },
    socketMessageAckCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: { isSessionValid: vi.fn(async () => true), queueSessionUpdate: vi.fn() },
}));
vi.mock("@/storage/db", () => ({ db: {} }));

describe("sessionUpdateHandler version-mismatch responses", () => {
    it("returns current metadata (not the attempted value) on version-mismatch", async () => {
        updateSessionMetadata.mockResolvedValueOnce({
            ok: false,
            error: "version-mismatch",
            current: { version: 5, metadata: "mCurrent" },
        });

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
        const socket = createFakeSocket();
        sessionUpdateHandler("u1", socket as any, { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any);

        const handler = getSocketHandler(socket, "update-metadata");
        const cb = vi.fn();
        await handler({ sid: "s1", metadata: "mAttempt", expectedVersion: 4 }, cb);

        expect(cb).toHaveBeenCalledWith({ result: "version-mismatch", version: 5, metadata: "mCurrent" });
        UpdateMetadataAckResponseSchema.parse(cb.mock.calls[0][0]);
    });

    it("returns current agentState (not the attempted value) on version-mismatch", async () => {
        updateSessionAgentState.mockResolvedValueOnce({
            ok: false,
            error: "version-mismatch",
            current: { version: 5, agentState: "aCurrent" },
        });

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
        const socket = createFakeSocket();
        sessionUpdateHandler("u1", socket as any, { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any);

        const handler = getSocketHandler(socket, "update-state");
        const cb = vi.fn();
        await handler({ sid: "s1", agentState: "aAttempt", expectedVersion: 4 }, cb);

        expect(cb).toHaveBeenCalledWith({ result: "version-mismatch", version: 5, agentState: "aCurrent" });
        UpdateStateAckResponseSchema.parse(cb.mock.calls[0][0]);
    });

    it("returns error (not version-mismatch) when current state is missing", async () => {
        updateSessionMetadata.mockResolvedValueOnce({
            ok: false,
            error: "version-mismatch",
            current: null,
        });

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
        const socket = createFakeSocket();
        sessionUpdateHandler("u1", socket as any, { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any);

        const handler = getSocketHandler(socket, "update-metadata");
        const cb = vi.fn();
        await handler({ sid: "s1", metadata: "mAttempt", expectedVersion: 4 }, cb);

        expect(cb).toHaveBeenCalledWith({ result: "error" });
    });
});
