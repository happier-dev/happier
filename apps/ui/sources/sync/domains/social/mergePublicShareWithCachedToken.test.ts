import { describe, expect, it } from "vitest";

import { mergePublicShareWithCachedToken } from "./mergePublicShareWithCachedToken";
import type { PublicSessionShare } from "./sharingTypes";

function createShare(overrides: Partial<PublicSessionShare> = {}): PublicSessionShare {
  return {
    id: "share-1",
    token: null,
    expiresAt: null,
    maxUses: null,
    useCount: 0,
    isConsentRequired: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("mergePublicShareWithCachedToken", () => {
  it("keeps the previous token when the server omits it", () => {
    const previous = createShare({ token: "tok_prev" });
    const next = mergePublicShareWithCachedToken({
      previousPublicShare: previous,
      cachedToken: "tok_prev",
      outcome: { ok: true, publicShare: createShare({ token: null }) },
    });
    expect(next.publicShare?.token).toBe("tok_prev");
    expect(next.cachedToken).toBe("tok_prev");
  });

  it("clears the cached token when the share is deleted", () => {
    const previous = createShare({ token: "tok_prev" });
    const next = mergePublicShareWithCachedToken({
      previousPublicShare: previous,
      cachedToken: "tok_prev",
      outcome: { ok: true, publicShare: null },
    });
    expect(next.publicShare).toBeNull();
    expect(next.cachedToken).toBeNull();
  });

  it("does not clear cached token on fetch errors", () => {
    const previous = createShare({ token: "tok_prev" });
    const next = mergePublicShareWithCachedToken({
      previousPublicShare: previous,
      cachedToken: "tok_prev",
      outcome: { ok: false },
    });
    expect(next.publicShare).toEqual(previous);
    expect(next.cachedToken).toBe("tok_prev");
  });
});

