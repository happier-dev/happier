import { describe, expect, it } from "vitest";

import { buildRpcMethodRoom } from "./rpcMethodRoom";

describe("buildRpcMethodRoom", () => {
    it("builds a stable per-user room name for an RPC method", () => {
        expect(buildRpcMethodRoom({
            userId: "user-1",
            method: "agent.run",
        })).toBe("rpc:user-1:agent.run");
    });

    it("keeps session-scoped method prefixes inside the room name", () => {
        expect(buildRpcMethodRoom({
            userId: "user-1",
            method: "sess_1:execution.run.stream.start",
        })).toBe("rpc:user-1:sess_1:execution.run.stream.start");
    });
});
