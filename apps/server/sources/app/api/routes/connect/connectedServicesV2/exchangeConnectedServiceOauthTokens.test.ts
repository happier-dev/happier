import { describe, expect, it, vi } from "vitest";

import tweetnacl from "tweetnacl";

import { decodeBase64, encodeBase64, openBoxBundle, BOX_BUNDLE_PUBLIC_KEY_BYTES } from "@happier-dev/protocol";

import {
    ConnectedServiceOauthStateMismatchError,
    ConnectedServiceOauthTimeoutError,
    exchangeConnectedServiceOauthTokens,
} from "./exchangeConnectedServiceOauthTokens";
import { createEnvReset } from "../../../testkit/env";

function buildRecipientPublicKeyB64Url(): string {
    const bytes = new Uint8Array(BOX_BUNDLE_PUBLIC_KEY_BYTES).fill(7);
    return encodeBase64(bytes, "base64url");
}

function buildRecipientKeyPair(): Readonly<{ publicKeyB64Url: string; secretKey: Uint8Array }> {
    const secretKey = new Uint8Array(32).fill(7);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey;
    return { publicKeyB64Url: encodeBase64(publicKey, "base64url"), secretKey };
}

function buildJwt(payload: Readonly<Record<string, unknown>>): string {
    const encoder = new TextEncoder();
    return [
        encodeBase64(encoder.encode(JSON.stringify({ alg: "none" })), "base64url"),
        encodeBase64(encoder.encode(JSON.stringify(payload)), "base64url"),
        "sig",
    ].join(".");
}

describe("exchangeConnectedServiceOauthTokens", () => {
    const resetOauthExchangeEnv = createEnvReset();

    it("rejects openai api-key service oauth exchange", async () => {
        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "openai",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: vi.fn() as any,
            state: "s",
        })).rejects.toThrow(/openai api key/i);
    });

    it("rejects anthropic oauth exchange", async () => {
        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "anthropic",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: vi.fn() as any,
            state: "s",
        })).rejects.toThrow(/anthropic/i);
    });

    it("exchanges claude-subscription tokens", async () => {
        const recipient = buildRecipientKeyPair();
        const fetchMock = vi.fn(async (url: any, init: any) => {
            if (String(url).endsWith('/api/oauth/profile')) {
                return new Response(JSON.stringify({
                    account: { has_claude_max: true },
                    organization: {
                        organization_type: 'claude_max',
                        rate_limit_tier: 'default_claude_max_20x',
                    },
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
            expect(String(url)).toBe("https://platform.claude.com/v1/oauth/token");
            const body = JSON.parse(String(init?.body ?? "{}"));
            expect(body.grant_type).toBe("authorization_code");
            expect(body.code).toBe("c");
            expect(body.client_id).toBeTruthy();
            expect(body.code_verifier).toBe("v");
            expect(body.state).toBe("s");
            return new Response(JSON.stringify({
                access_token: "at",
                refresh_token: "rt",
                expires_in: 3600,
                token_type: "Bearer",
                scope: "user:inference",
                account: { uuid: "acct", email_address: "user@example.com" },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        const res = await exchangeConnectedServiceOauthTokens({
            serviceId: "claude-subscription",
            publicKeyB64Url: recipient.publicKeyB64Url,
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
            state: "s",
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(typeof res.bundleB64Url).toBe("string");
        expect(res.bundleB64Url.length).toBeGreaterThan(0);
        const opened = openBoxBundle({
            bundle: decodeBase64(res.bundleB64Url, "base64url"),
            recipientSecretKeyOrSeed: recipient.secretKey,
        });
        const payload = JSON.parse(new TextDecoder().decode(opened!));
        expect(payload.raw).toEqual({
            claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
        });
    });

    it("rejects a Claude exchange when the provider profile endpoint rejects the issued access token", async () => {
        const recipient = buildRecipientKeyPair();
        const fetchMock = vi.fn(async (url: any) => {
            if (String(url).endsWith("/api/oauth/profile")) {
                return new Response("", { status: 401, statusText: "Unauthorized" });
            }
            return new Response(JSON.stringify({
                access_token: "provider-rejected-access",
                refresh_token: "refresh",
                expires_in: 3600,
                token_type: "Bearer",
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "claude-subscription",
            publicKeyB64Url: recipient.publicKeyB64Url,
            code: "c",
            verifier: "v",
            redirectUri: "https://platform.claude.com/oauth/code/callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
            state: "s",
        })).rejects.toThrow(/access-token verification failed \(401\)/);
    });

    it("keeps Claude exchange usable when optional profile evidence is temporarily unavailable", async () => {
        const recipient = buildRecipientKeyPair();
        const fetchMock = vi.fn(async (url: any) => {
            if (String(url).endsWith("/api/oauth/profile")) {
                return new Response("", { status: 503, statusText: "Service Unavailable" });
            }
            return new Response(JSON.stringify({
                access_token: "accepted-access",
                refresh_token: "refresh",
                expires_in: 3600,
                token_type: "Bearer",
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "claude-subscription",
            publicKeyB64Url: recipient.publicKeyB64Url,
            code: "c",
            verifier: "v",
            redirectUri: "https://platform.claude.com/oauth/code/callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
            state: "s",
        })).resolves.toEqual({ bundleB64Url: expect.any(String) });
    });

    it("extracts OpenAI Codex account email from id_token claims during exchange", async () => {
        const idToken = buildJwt({
            chatgpt_account_id: "acct-from-token",
            "https://api.openai.com/profile": {
                email: "codex-user@example.test",
            },
        });
        const fetchMock = vi.fn(async (_url: any, init: any) => {
            const body = String(init?.body ?? "");
            expect(body).toContain("grant_type=authorization_code");
            expect(body).toContain("code=c");
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    access_token: "at",
                    refresh_token: "rt",
                    id_token: idToken,
                    expires_in: 3600,
                }),
                text: async () => "",
            } as any;
        });

        const recipient = buildRecipientKeyPair();
        const res = await exchangeConnectedServiceOauthTokens({
            serviceId: "openai-codex",
            publicKeyB64Url: recipient.publicKeyB64Url,
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        });

        const opened = openBoxBundle({
            bundle: decodeBase64(res.bundleB64Url, "base64url"),
            recipientSecretKeyOrSeed: recipient.secretKey,
        });
        expect(opened).toBeTruthy();
        const json = JSON.parse(new TextDecoder().decode(opened!));
        expect(json.providerAccountId).toBe("acct-from-token");
        expect(json.providerEmail).toBe("codex-user@example.test");
    });

    it("rejects claude-subscription exchange when state is missing", async () => {
        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "claude-subscription",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: vi.fn() as any,
            state: "",
        })).rejects.toBeInstanceOf(ConnectedServiceOauthStateMismatchError);
    });

    it("rejects Gemini OAuth exchange without contacting Google", async () => {
        const fetchMock = vi.fn();

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "gemini",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        })).rejects.toThrow(/Gemini OAuth exchange is not supported/i);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("passes an AbortSignal to token exchange fetch requests", async () => {
        resetOauthExchangeEnv({ HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: "5000" });
        const fetchMock = vi.fn(async (_url: any, init: any) => ({
            ok: true,
            status: 200,
            json: async () => ({
                access_token: "at",
                refresh_token: "rt",
                id_token: "id",
                expires_in: 3600,
                scope: "s",
                token_type: "Bearer",
            }),
            text: async () => "",
        }));

        await exchangeConnectedServiceOauthTokens({
            serviceId: "openai-codex",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const init = fetchMock.mock.calls[0]?.[1] as any;
        expect(init?.signal).toBeTruthy();
        expect(typeof init.signal.aborted).toBe("boolean");
    });

    it("aborts token exchange when the timeout elapses", async () => {
        resetOauthExchangeEnv({ HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: "1000" });
        vi.useFakeTimers();
        try {
            const fetchMock = vi.fn(async (_url: any, init: any) => {
                return await new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener?.("abort", () => {
                        const err = new Error("AbortError");
                        (err as any).name = "AbortError";
                        reject(err);
                    });
                });
            });

            const promise = exchangeConnectedServiceOauthTokens({
                serviceId: "openai-codex",
                publicKeyB64Url: buildRecipientPublicKeyB64Url(),
                code: "c",
                verifier: "v",
                redirectUri: "http://localhost:54545/oauth2callback",
                now: 1700000000000,
                fetcher: fetchMock as any,
            });

            const expectation = expect(promise).rejects.toBeInstanceOf(ConnectedServiceOauthTimeoutError);
            await vi.advanceTimersByTimeAsync(1500);
            await expectation;
        } finally {
            vi.useRealTimers();
            resetOauthExchangeEnv();
        }
    });
});
