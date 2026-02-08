import { describe, expect, it } from "vitest";

import { resolveElevenLabsAgentId } from "./elevenLabsEnv";

describe("resolveElevenLabsAgentId", () => {
    it("returns undefined when neither agent id is configured", () => {
        expect(resolveElevenLabsAgentId({})).toBeUndefined();
    });
});
