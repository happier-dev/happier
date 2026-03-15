import { describe, expect, it } from "vitest";

import { extractOpenAiCodexAccountId } from "./openaiCodexIdTokenClaims";

function buildJwt(payload: unknown): string {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `hdr.${b64}.sig`;
}

describe("openaiCodexIdTokenClaims", () => {
  it("extracts account id from organizations[0].id when present", () => {
    const token = buildJwt({ organizations: [{ id: "org_123" }] });
    expect(extractOpenAiCodexAccountId(token)).toBe("org_123");
  });
});
