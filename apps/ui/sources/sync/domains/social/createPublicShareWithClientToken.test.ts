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
  it("stores and merges the generated token only after the create commits", async () => {
    const calls: string[] = [];
    let cachedToken: string | null = null;
    const tokenCache = {
      get: () => cachedToken,
      set: (token: string | null) => {
        cachedToken = token;
        calls.push(`set:${token}`);
      },
    };

    const created = await createPublicShareWithClientToken({
      credentials: { t: "creds" },
      sessionId: "session-1",
      sessionEncryptionMode: "plain",
      isConsentRequired: true,
      tokenCache,
      generateTokenHex: () => "tok_test",
      api: {
        createPublicShare: async () => {
          calls.push(`create:cache=${cachedToken}`);
          return createShare({ id: "share-committed", token: null });
        },
      },
    });

    expect(calls).toEqual(["create:cache=null", "set:tok_test"]);
    expect(created).toMatchObject({ id: "share-committed", token: "tok_test" });
  });

  it("fails closed, clears the attempted token, and does not attach it to an existing share", async () => {
    let cachedToken: string | null = "tok_existing";
    const tokenCache = { get: () => cachedToken, set: (token: string | null) => (cachedToken = token) };
    let getCalls = 0;
    const apiWithRecoverySentinel = {
      createPublicShare: async () => {
        throw new Error("timeout");
      },
      getPublicShare: async () => {
        getCalls += 1;
        return createShare({ id: "prior-share", token: null });
      },
    };

    await expect(createPublicShareWithClientToken({
      credentials: { t: "creds" },
      sessionId: "session-1",
      sessionEncryptionMode: "plain",
      isConsentRequired: true,
      tokenCache,
      generateTokenHex: () => "tok_test",
      api: apiWithRecoverySentinel,
    })).rejects.toThrow("timeout");

    expect(tokenCache.get()).toBeNull();
    expect(getCalls).toBe(0);
  });

  it("never caches the generated token when E2EE key preflight fails", async () => {
    let cachedToken: string | null = "tok_existing";
    const cachedValues: Array<string | null> = [];
    const tokenCache = {
      get: () => cachedToken,
      set: (token: string | null) => {
        cachedToken = token;
        cachedValues.push(token);
      },
    };
    let createCalls = 0;

    await expect(createPublicShareWithClientToken({
      credentials: { t: "creds" },
      sessionId: "session-1",
      sessionEncryptionMode: "e2ee",
      isConsentRequired: true,
      tokenCache,
      generateTokenHex: () => "tok_uncommitted",
      getSessionDataKey: () => null,
      encryptDataKeyForPublicShare: async () => "unreachable",
      api: {
        createPublicShare: async () => {
          createCalls += 1;
          return createShare();
        },
      },
    })).rejects.toThrow("Session data key is required");

    expect(createCalls).toBe(0);
    expect(cachedValues).not.toContain("tok_uncommitted");
    expect(tokenCache.get()).toBeNull();
  });

  it("never caches the generated token when E2EE encryption preflight rejects", async () => {
    let cachedToken: string | null = null;
    const cachedValues: Array<string | null> = [];
    const tokenCache = {
      get: () => cachedToken,
      set: (token: string | null) => {
        cachedToken = token;
        cachedValues.push(token);
      },
    };

    await expect(createPublicShareWithClientToken({
      credentials: { t: "creds" },
      sessionId: "session-1",
      sessionEncryptionMode: "e2ee",
      isConsentRequired: true,
      tokenCache,
      generateTokenHex: () => "tok_uncommitted",
      getSessionDataKey: () => new Uint8Array([1, 2, 3]),
      encryptDataKeyForPublicShare: async () => {
        throw new Error("encryption failed");
      },
      api: {
        createPublicShare: async () => createShare(),
      },
    })).rejects.toThrow("encryption failed");

    expect(cachedValues).not.toContain("tok_uncommitted");
    expect(tokenCache.get()).toBeNull();
  });

  it("clears the cache when token generation fails before create", async () => {
    let cachedToken: string | null = "tok_existing";
    const tokenCache = {
      get: () => cachedToken,
      set: (token: string | null) => {
        cachedToken = token;
      },
    };
    let createCalls = 0;

    await expect(createPublicShareWithClientToken({
      credentials: { t: "creds" },
      sessionId: "session-1",
      sessionEncryptionMode: "plain",
      isConsentRequired: true,
      tokenCache,
      generateTokenHex: () => {
        throw new Error("random source failed");
      },
      api: {
        createPublicShare: async () => {
          createCalls += 1;
          return createShare();
        },
      },
    })).rejects.toThrow("random source failed");

    expect(createCalls).toBe(0);
    expect(tokenCache.get()).toBeNull();
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
      },
    });

    expect(receivedEncryptedDataKey).toBe("edk_b64");
    expect(share.token).toBe("tok_test");
    expect(share.isConsentRequired).toBe(false);
  });
});
