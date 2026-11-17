import { afterEach, describe, expect, it, vi } from "vitest";

import { eventRouter } from "@/app/events/eventRouter";
import type { SocketRoomEmitter } from "@/app/events/socketRoomEmitter";
import { publishMachineAliveObservation } from "./machinePublication";

describe("Machine alive publication", () => {
    afterEach(() => eventRouter.clearIo());

    it("costs no cluster broadcast and no room emit for a continuing beat of an online Machine", async () => {
        // The Socket.IO adapter is the cluster boundary: every serverSideEmit is a Pub/Sub publish to all nodes.
        const serverSideEmit = vi.fn();
        const emit = vi.fn();
        const io = { serverSideEmit, to: vi.fn(() => ({ emit })), in: vi.fn(() => ({ emit })) } as unknown as SocketRoomEmitter;
        eventRouter.setIo(io);
        const admission = { recipientAccountIds: ["account-1"], wasOffline: false, lastActiveAt: new Date(1) };
        for (let beat = 1; beat <= 10; beat += 1) {
            await publishMachineAliveObservation("account-1", "machine-1", beat * 60_000, admission);
        }
        expect(serverSideEmit.mock.calls.length).toBe(0);
        expect(emit.mock.calls.length).toBe(0);
    });
});
