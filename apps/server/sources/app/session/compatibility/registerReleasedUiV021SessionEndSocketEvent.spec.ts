import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

const applyReleasedUiV021SessionEnd = vi.hoisted(() => vi.fn(async () => ({ status: "applied" as const })));
vi.mock("./applyReleasedUiV021SessionEnd", () => ({ applyReleasedUiV021SessionEnd }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

import { registerReleasedUiV021SessionEndSocketEvent } from "./registerReleasedUiV021SessionEndSocketEvent";
import type { ClientConnection } from "@/app/events/eventRouter";

type UserScopedConnection = Extract<ClientConnection, { connectionType: "user-scoped" }>;

describe("released UI v0.2.1 session-end socket adapter", () => {
    beforeEach(() => applyReleasedUiV021SessionEnd.mockClear());

    it("clamps the released event and delegates to the current lifecycle owner", async () => {
        const handlers: Array<(value: unknown) => void> = [];
        const socket = {
            on: vi.fn((event: string, registered: (value: unknown) => void) => {
                if (event === "session-end") handlers.push(registered);
            }),
        };
        const connection = { connectionType: "user-scoped" as const, userId: "owner", socket };
        registerReleasedUiV021SessionEndSocketEvent({
            socket: socket as unknown as Socket,
            accountId: "owner",
            connection: connection as unknown as UserScopedConnection,
            now: () => 2_000,
        });

        handlers[0]?.({ sid: "session-1", time: 3_000 });
        await vi.waitFor(() => expect(applyReleasedUiV021SessionEnd).toHaveBeenCalledWith({
            accountId: "owner",
            sessionId: "session-1",
            observedAt: 2_000,
            connection,
        }));
    });

    it("ignores malformed and released-window-stale events", async () => {
        const handlers: Array<(value: unknown) => void> = [];
        const socket = { on: vi.fn((_event: string, registered: (value: unknown) => void) => handlers.push(registered)) };
        registerReleasedUiV021SessionEndSocketEvent({
            socket: socket as unknown as Socket,
            accountId: "owner",
            connection: { connectionType: "user-scoped", userId: "owner", socket } as unknown as UserScopedConnection,
            now: () => 1_000_000,
        });
        handlers[0]?.({ sid: "session-1", time: 1 });
        handlers[0]?.({ sid: "session-1", time: "bad" });
        handlers[0]?.({ time: 1_000_000 });
        await Promise.resolve();
        expect(applyReleasedUiV021SessionEnd).not.toHaveBeenCalled();
    });
});
