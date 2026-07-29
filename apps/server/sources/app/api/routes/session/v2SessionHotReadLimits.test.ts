import { describe, expect, it } from "vitest";

import {
    resolveSessionRollbackEligibleTurnRelationLimit,
    resolveV2SessionListInitialAttentionRowLimit,
} from "./v2SessionHotReadLimits";

describe("v2 session hot read limits", () => {
    it("resolves the initial durable attention row limit from configuration", () => {
        expect(resolveV2SessionListInitialAttentionRowLimit({
            HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: "7",
        } as NodeJS.ProcessEnv)).toBe(7);
    });

    it("resolves the rollback eligible turn relation limit from configuration", () => {
        expect(resolveSessionRollbackEligibleTurnRelationLimit({
            HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: "7",
        } as NodeJS.ProcessEnv)).toBe(7);
    });
});
