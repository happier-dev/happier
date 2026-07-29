import { describe, expect, it } from "vitest";

import { parseStoredSessionTurn } from "./parseSessionTurnState";

describe("parseStoredSessionTurn provider checkpoint", () => {
    it("replays the opaque provider checkpoint persisted with canonical transcript anchors", () => {
        expect(parseStoredSessionTurn({
            turnId: "turn-1",
            agentId: "grok",
            status: "completed",
            startedAt: 10,
            updatedAt: 20,
            transcriptAnchorsJson: JSON.stringify({
                startUserMessageSeq: 7,
                providerCheckpoint: {
                    kind: "grok_prompt_index",
                    promptIndex: 3,
                },
            }),
            rollbackState: "eligible",
            rollbackUpdatedAt: 20,
        })).toMatchObject({
            turnId: "turn-1",
            transcriptAnchors: {
                startUserMessageSeq: 7,
            },
            rollback: {
                state: "eligible",
                providerCheckpoint: {
                    kind: "grok_prompt_index",
                    promptIndex: 3,
                },
            },
        });
    });
});
