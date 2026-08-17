import { describe, expect, it } from "vitest";

import { getSocketRooms } from "./socketRooms";

describe("getSocketRooms", () => {
    it("includes the shared user room for user-scoped clients", () => {
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
            "user-machines:u1",
            "machine:m1:u1",
        ]);
    });

    it("joins the AccountChange wake room only for AccountStoredContent V3 sockets", () => {
        const v3Rooms = getSocketRooms({
            userId: "u1",
            clientType: "machine-scoped",
            machineId: "m1",
            includeAccountStoredContentV3Room: true,
        } as any);
        const v2Rooms = getSocketRooms({
            userId: "u1",
            clientType: "machine-scoped",
            machineId: "m1",
            includeAccountStoredContentV3Room: false,
        } as any);

        expect(v3Rooms).toContain("account-stored-content-v3:u1");
        expect(v2Rooms).not.toContain("account-stored-content-v3:u1");
    });

    it("throws on missing required IDs", () => {
        expect(() => getSocketRooms({ userId: "u1", clientType: "session-scoped" })).toThrow(/sessionId/i);
        expect(() => getSocketRooms({ userId: "u1", clientType: "machine-scoped" })).toThrow(/machineId/i);
    });

    it("a live-stream viewer (user-scoped) is a member of its emit-fallback room", () => {
        // C5 room contract: the relay handler delivers viewer-targeted frames to the per-tab
        // socket id room (`io.to(viewerSocketId)`) — socket.io auto-joins every socket to that
        // private room, so per-tab isolation is structural. When no viewerSocketId is minted the
        // handler falls back to the shared user room, which a user-scoped client provably joins.
        // This is the `getSocketRooms(viewer) ⊇ emit-room` invariant for the fallback path.
        const viewerRooms = getSocketRooms({ userId: "u1", clientType: "user-scoped" });
        expect(viewerRooms).toContain("user:u1");
    });
});
