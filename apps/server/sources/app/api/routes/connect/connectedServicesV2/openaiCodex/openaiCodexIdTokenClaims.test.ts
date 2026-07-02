import { describe, expect, it } from "vitest";

import {
  extractOpenAiCodexAccountId,
  extractOpenAiCodexEmail,
} from "./openaiCodexIdTokenClaims";

function buildJwt(payload: unknown): string {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `hdr.${b64}.sig`;
}

describe("openaiCodexIdTokenClaims", () => {
  it("extracts account id from organizations[0].id when present", () => {
    const token = buildJwt({ organizations: [{ id: "org_123" }] });
    expect(extractOpenAiCodexAccountId(token)).toBe("org_123");
  });

  it("trims direct email claims", () => {
    const token = buildJwt({ email: "  codex-user@example.test  " });
    expect(extractOpenAiCodexEmail(token)).toBe("codex-user@example.test");
  });

  it("returns null for missing or blank email claims", () => {
    expect(extractOpenAiCodexEmail(buildJwt({}))).toBeNull();
    expect(extractOpenAiCodexEmail(buildJwt({ email: "   " }))).toBeNull();
    expect(extractOpenAiCodexEmail(null)).toBeNull();
  });
});
