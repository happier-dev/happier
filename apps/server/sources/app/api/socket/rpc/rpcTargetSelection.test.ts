import { describe, expect, it, vi } from "vitest";

import { selectRpcTarget } from "./rpcTargetSelection";

function createCandidate(id: string) {
    return {
        id,
        timeout: vi.fn(),
    };
}

describe("selectRpcTarget", () => {
    it("rejects a self-call when the caller is the only available target", () => {
        expect(selectRpcTarget({
            targets: [createCandidate("caller-socket")],
            excludedSocketId: "caller-socket",
        })).toEqual({
            type: "self-call",
        });
    });

    it("chooses a non-caller target when both the caller and another socket are present", () => {
        const caller = createCandidate("caller-socket");
        const target = createCandidate("target-socket");

        expect(selectRpcTarget({
            targets: [caller, target],
            excludedSocketId: "caller-socket",
        })).toEqual({
            type: "target",
            target,
            hadMultipleTargets: true,
        });
    });

    it("chooses deterministically when more than one non-caller target is present", () => {
        const targetB = createCandidate("target-b");
        const targetA = createCandidate("target-a");

        expect(selectRpcTarget({
            targets: [targetB, targetA],
        })).toEqual({
            type: "target",
            target: targetA,
            hadMultipleTargets: true,
        });
    });
});
