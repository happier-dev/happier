import { describe, expect, it } from "vitest";

import {
    createSessionRollbackEligibleTurnsSelect,
    readSessionTurnRollbackEligibleStarts,
} from "./sessionRollbackEligibilityProjection";

describe("session rollback eligibility projection", () => {
    it("uses the canonical bounded eligible-turn relation projection", () => {
        expect(createSessionRollbackEligibleTurnsSelect()).toMatchObject({
            where: { rollbackState: "eligible" },
            take: 50,
            select: { transcriptAnchorsJson: true, rollbackState: true },
        });
    });

    it("returns sorted unique valid start sequence facts", () => {
        expect(readSessionTurnRollbackEligibleStarts({ turns: [
            { rollbackState: "eligible", transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 8 }) },
            { rollbackState: "eligible", transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 2 }) },
            { rollbackState: "eligible", transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 8 }) },
            { rollbackState: "rolled_back", transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1 }) },
            { rollbackState: "eligible", transcriptAnchorsJson: "bad-json" },
        ] })).toEqual([2, 8]);
    });
});
