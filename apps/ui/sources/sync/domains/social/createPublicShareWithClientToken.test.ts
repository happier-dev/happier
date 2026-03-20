import { describe, expect, it } from "vitest";

import { createPublicShareWithClientToken } from "./createPublicShareWithClientToken";
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

describe("createPublicShareWithClientToken", () => {
  it("stores the token in the cache before invoking the API", async () => {
    const calls: string[] = [];
    let cachedToken: string | null = null;
    const tokenCache = {
      get: () => cachedToken,
      set: (token: string | null) => {
        cachedToken = token;
        calls.push(`set:${token}`);
      },
    };

    await expect(
      createPublicShareWithClientToken({
        credentials: { t: "creds" },
        sessionId: "session-1",
        sessionEncryptionMode: "plain",
        isConsentRequired: true,
        tokenCache,
        generateTokenHex: () => "tok_test",
        api: {
          createPublicShare: async () => {
            calls.push("create");
            throw new Error("timeout");
          },
          getPublicShare: async () => {
            calls.push("get");
            return null;
          },
        },
      }),
    ).rejects.toThrow("timeout");

    expect(calls.indexOf("set:tok_test")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("create")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("set:tok_test")).toBeLessThan(calls.indexOf("create"));
  });

  it("recovers the created share when the create request fails after persistence", async () => {
    let cachedToken: string | null = null;
    const tokenCache = { get: () => cachedToken, set: (token: string | null) => (cachedToken = token) };

    const share = await createPublicShareWithClientToken({
      credentials: { t: "creds" },
      sessionId: "session-1",
      sessionEncryptionMode: "plain",
      isConsentRequired: true,
      tokenCache,
      generateTokenHex: () => "tok_test",
      api: {
        createPublicShare: async () => {
          throw new Error("timeout");
        },
        getPublicShare: async () => createShare({ token: null }),
      },
    });

    expect(share.token).toBe("tok_test");
    expect(tokenCache.get()).toBe("tok_test");
  });

  it("encrypts the session DEK for e2ee public shares", async () => {
    let receivedEncryptedDataKey: string | null = null;
    const tokenCache = { get: () => null, set: () => {} };

    const share = await createPublicShareWithClientToken({
      credentials: { t: "creds" },
      sessionId: "session-1",
      sessionEncryptionMode: "e2ee",
      isConsentRequired: false,
      tokenCache,
      generateTokenHex: () => "tok_test",
      getSessionDataKey: () => new Uint8Array([1, 2, 3]),
      encryptDataKeyForPublicShare: async () => "edk_b64",
      api: {
        createPublicShare: async (_creds, _sid, request) => {
          receivedEncryptedDataKey = request.encryptedDataKey ?? null;
          return createShare({ token: request.token, isConsentRequired: request.isConsentRequired });
        },
        getPublicShare: async () => null,
      },
    });

    expect(receivedEncryptedDataKey).toBe("edk_b64");
    expect(share.token).toBe("tok_test");
    expect(share.isConsentRequired).toBe(false);
  });
});

