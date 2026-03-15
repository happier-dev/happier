import { describe, expect, it, vi } from "vitest";

import tweetnacl from "tweetnacl";

import { decodeBase64, encodeBase64, openBoxBundle } from "@happier-dev/protocol";

import {
  OPENAI_CODEX_DEVICE_REDIRECT_URI,
  startOpenAiCodexDeviceAuth,
  pollOpenAiCodexDeviceAuthOnce,
  exchangeOpenAiCodexDeviceAuthApprovalForBundle,
} from "./openaiCodexDeviceAuth";

function buildRecipientKeyPair(): Readonly<{ publicKeyB64Url: string; secretKey: Uint8Array }> {
  const secretKey = new Uint8Array(32).fill(7);
  const publicKey = tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey;
  return { publicKeyB64Url: encodeBase64(publicKey, "base64url"), secretKey };
}

describe("openai codex device auth", () => {
  it("starts device auth and returns user code + interval", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/api/accounts/deviceauth/usercode");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.client_id).toBeTruthy();
      return {
        ok: true,
        status: 200,
        json: async () => ({ device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: "5" }),
      } as any;
    });

    const res = await startOpenAiCodexDeviceAuth({ fetcher: fetchMock as any });
    expect(res.deviceAuthId).toBe("dev-1");
    expect(res.userCode).toBe("ABCD-EFGH");
    expect(res.intervalMs).toBe(5000);
    expect(res.verificationUrl).toContain("auth.openai.com");
  });

  it("treats 403/404 polling responses as pending", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as any);
    const res = await pollOpenAiCodexDeviceAuthOnce({
      fetcher: fetchMock as any,
      deviceAuthId: "dev-1",
      userCode: "ABCD-EFGH",
      intervalMs: 5000,
    });
    expect(res.status).toBe("pending");
    if (res.status === "pending") {
      expect(res.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("returns approval codes when polling succeeds", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ authorization_code: "auth-code-1", code_verifier: "verifier-1" }),
    })) as any;

    const res = await pollOpenAiCodexDeviceAuthOnce({
      fetcher: fetchMock,
      deviceAuthId: "dev-1",
      userCode: "ABCD-EFGH",
      intervalMs: 5000,
    });
    expect(res).toEqual({ status: "approved", authorizationCode: "auth-code-1", codeVerifier: "verifier-1" });
  });

  it("exchanges approval for a sealed bundle using the device redirect_uri", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/oauth/token");
      const body = String(init?.body ?? "");
      expect(body).toContain(`redirect_uri=${encodeURIComponent(OPENAI_CODEX_DEVICE_REDIRECT_URI)}`);
      expect(body).toContain("code_verifier=verifier-1");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id_token: "hdr.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0XzEifQ.sig",
          access_token: "at",
          refresh_token: "rt",
          expires_in: 60,
        }),
        text: async () => "",
      } as any;
    });

    const recipient = buildRecipientKeyPair();
    const res = await exchangeOpenAiCodexDeviceAuthApprovalForBundle({
      fetcher: fetchMock as any,
      publicKeyB64Url: recipient.publicKeyB64Url,
      authorizationCode: "auth-code-1",
      codeVerifier: "verifier-1",
      now: 1700000000000,
      randomBytes: (n) => new Uint8Array(n).fill(3),
    });

    expect(typeof res.bundleB64Url).toBe("string");
    expect(res.bundleB64Url.length).toBeGreaterThan(0);

    const opened = openBoxBundle({
      bundle: decodeBase64(res.bundleB64Url, "base64url"),
      recipientSecretKeyOrSeed: recipient.secretKey,
    });
    expect(opened).toBeTruthy();
    const json = JSON.parse(new TextDecoder().decode(opened!));
    expect(json.serviceId).toBe("openai-codex");
    expect(json.refreshToken).toBe("rt");
  });
});
