import { describe, expect, it } from "vitest";

import { getSocketRooms } from "./socketRooms";

describe("getSocketRooms", () => {
    it("always includes user room", () => {
        expect(getSocketRooms({ userId: "u1", clientType: "user-scoped" })).toEqual(["user:u1", "user-scoped:u1"]);
    });

    it("includes session room for session-scoped clients", () => {
        expect(getSocketRooms({ userId: "u1", clientType: "session-scoped", sessionId: "s1" })).toEqual([
            "user:u1",
            "session:s1",
            "session:s1:u1",
        ]);
    });

    it("includes machine room for machine-scoped clients", () => {
        expect(getSocketRooms({ userId: "u1", clientType: "machine-scoped", machineId: "m1" })).toEqual([
            "user:u1",
            "machine:m1:u1",
        ]);
    });

    it("throws on missing required IDs", () => {
        expect(() => getSocketRooms({ userId: "u1", clientType: "session-scoped" })).toThrow(/sessionId/i);
        expect(() => getSocketRooms({ userId: "u1", clientType: "machine-scoped" })).toThrow(/machineId/i);
    });
});
