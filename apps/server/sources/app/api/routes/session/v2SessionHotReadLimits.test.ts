import { describe, expect, it } from "vitest";

import { resolveV2SessionListInitialPinnedRowLimit } from "./v2SessionHotReadLimits";

describe("v2 session hot read limits", () => {
    it("resolves the initial pinned row limit from configuration", () => {
        expect(resolveV2SessionListInitialPinnedRowLimit({
            HAPPIER_V2_SESSION_LIST_INITIAL_PINNED_ROW_LIMIT: "7",
        } as NodeJS.ProcessEnv)).toBe(7);
    });
});
