import { describe, expect, it } from "vitest";
import { PresenceBatcher } from "./presenceBatcher";

describe("PresenceBatcher", () => {
    it("coalesces to max timestamp per entity", () => {
        const batcher = new PresenceBatcher();

        batcher.recordSessionAlive("s1", 10);
        batcher.recordSessionAlive("s1", 5);
        batcher.recordSessionAlive("s1", 11);

        batcher.recordMachineAlive("u1", "m1", 10);
        batcher.recordMachineAlive("u1", "m1", 9);
        batcher.recordMachineAlive("u1", "m1", 12);

        const first = batcher.drain();
        expect(first.sessions).toEqual([{ sessionId: "s1", timestamp: 11 }]);
        expect(first.machines).toEqual([{ accountId: "u1", machineId: "m1", timestamp: 12 }]);

        const second = batcher.drain();
        expect(second.sessions).toEqual([]);
        expect(second.machines).toEqual([]);
    });

    it("commit() does not drop newer timestamps recorded after snapshot", () => {
        const batcher = new PresenceBatcher();

        batcher.recordSessionAlive("s1", 10);
        const snap = batcher.snapshot();
        batcher.recordSessionAlive("s1", 11);

        batcher.commit(snap);

        const after = batcher.drain();
        expect(after.sessions).toEqual([{ sessionId: "s1", timestamp: 11 }]);
    });
});
