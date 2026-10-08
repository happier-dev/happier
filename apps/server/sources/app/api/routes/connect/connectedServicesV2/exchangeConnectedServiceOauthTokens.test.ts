import { describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_CLIENT_SECRET, AGY_OAUTH_SCOPES } from "@happier-dev/agents";

import { decodeBase64, encodeBase64, openBoxBundle, BOX_BUNDLE_PUBLIC_KEY_BYTES } from "@happier-dev/protocol";

import {
    ConnectedServiceOauthExchangeError,
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

function buildJwt(payload: Record<string, unknown>): string {
    return [
        "hdr",
        Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
        "sig",
    ].join(".");
}

describe("exchangeConnectedServiceOauthTokens", () => {
    const resetOauthExchangeEnv = createEnvReset();

    it("exchanges native Antigravity tokens with PKCE and seals verified account/project metadata without an ID token", async () => {
        const recipient = buildRecipientKeyPair();
        const fetchMock: typeof fetch = async (input, init) => {
            const url = String(input);
            if (url === "https://oauth2.googleapis.com/token") {
                const body = new URLSearchParams(String(init?.body));
                expect(body.get("client_id")).toBe(AGY_OAUTH_CLIENT_ID);
                expect(body.get("client_secret")).toBe(AGY_OAUTH_CLIENT_SECRET);
                expect(body.get("code_verifier")).toBe("pkce-verifier");
                expect(body.get("redirect_uri")).toBe("http://localhost:54545/");
                return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600,
                    scope: AGY_OAUTH_SCOPES.join(" "), token_type: "Bearer" });
            }
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer at");
            if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
                return Response.json({ sub: "google-account-a", email: "a@example.test", email_verified: true });
            }
            if (url.endsWith(":loadCodeAssist")) {
                expect(JSON.parse(String(init?.body))).toMatchObject({ cloudaicompanionProject: 'requested-project' });
                return Response.json({ cloudaicompanionProject: "project-a", currentTier: { id: "paid-tier" } });
            }
            throw new Error("Unexpected provider request");
        };
        const result = await exchangeConnectedServiceOauthTokens({
            serviceId: "antigravity", publicKeyB64Url: recipient.publicKeyB64Url, code: "code", verifier: "pkce-verifier",
            redirectUri: "http://localhost:54545/", state: "state", now: 1700000000000, fetcher: fetchMock,
            projectId: "requested-project",
        });
        const opened = openBoxBundle({ bundle: decodeBase64(result.bundleB64Url, "base64url"), recipientSecretKeyOrSeed: recipient.secretKey });
        expect(opened).toBeTruthy();
        const payload = JSON.parse(new TextDecoder().decode(opened!));
        expect(payload).toMatchObject({ serviceId: "antigravity", idToken: null,
            providerAccountId: "google-account-a", providerEmail: "a@example.test", expiresAt: 1700003600000,
            scope: AGY_OAUTH_SCOPES.join(" "), raw: { antigravity: {
                clientId: AGY_OAUTH_CLIENT_ID, authMethod: "oauth-personal", projectId: "project-a", tierId: "paid-tier",
            } } });
    });

    it("redacts Antigravity provider errors and preserves invalid-grant classification", async () => {
        const fetchMock: typeof fetch = async () => Response.json({
            error: "invalid_grant", error_description: "private-provider-detail",
        }, { status: 400 });
        const operation = exchangeConnectedServiceOauthTokens({
            serviceId: "antigravity", publicKeyB64Url: buildRecipientPublicKeyB64Url(), code: "code", verifier: "v",
            redirectUri: "http://localhost:54545/", state: "state", now: 1700000000000, fetcher: fetchMock,
        });
        await expect(operation).rejects.toMatchObject({ errorCode: "connect_oauth_invalid_grant" });
        await expect(operation).rejects.not.toThrow("private-provider-detail");
    });

    it("uses one exchange deadline across Antigravity token and account verification requests", async () => {
        resetOauthExchangeEnv({ HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: "1000" });
        vi.useFakeTimers();
        try {
            const fetchMock: typeof fetch = async (input, init) => {
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(resolve, 600);
                    init?.signal?.addEventListener("abort", () => {
                        clearTimeout(timer);
                        reject(new DOMException("Aborted", "AbortError"));
                    }, { once: true });
                });
                if (String(input).endsWith("/token")) return Response.json({
                    access_token: "at", refresh_token: "rt", scope: AGY_OAUTH_SCOPES.join(" "),
                });
                if (String(input).endsWith("/userinfo")) return Response.json({ sub: "account-a", email: "a@example.test" });
                return Response.json({ cloudaicompanionProject: "project-a", currentTier: { id: "paid-tier" } });
            };
            const operation = exchangeConnectedServiceOauthTokens({
                serviceId: "antigravity", publicKeyB64Url: buildRecipientPublicKeyB64Url(), code: "code", verifier: "v",
                redirectUri: "http://localhost:54545/", state: "state", now: 1700000000000, fetcher: fetchMock,
            });
            const settled = operation.then(() => null, (error: unknown) => error);
            await vi.advanceTimersByTimeAsync(2000);
            expect(await settled).toBeInstanceOf(ConnectedServiceOauthTimeoutError);
        } finally {
            vi.useRealTimers();
            resetOauthExchangeEnv();
        }
    });

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

    it("extracts OpenAI Codex account email from id_token claims during exchange", async () => {
        const recipient = buildRecipientKeyPair();
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                access_token: "at",
                refresh_token: "rt",
                id_token: buildJwt({
                    chatgpt_account_id: "acct-from-token",
                    email: "codex-user@example.test",
                }),
                expires_in: 3600,
            }),
            text: async () => "",
        }));

        const res = await exchangeConnectedServiceOauthTokens({
            serviceId: "openai-codex",
            publicKeyB64Url: recipient.publicKeyB64Url,
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
            state: "s",
        });

        const opened = openBoxBundle({
            bundle: decodeBase64(res.bundleB64Url, "base64url"),
            recipientSecretKeyOrSeed: recipient.secretKey,
        });
        expect(opened).toBeTruthy();
        const payload = JSON.parse(new TextDecoder().decode(opened!));
        expect(payload.providerAccountId).toBe("acct-from-token");
        expect(payload.providerEmail).toBe("codex-user@example.test");
    });

    it("exchanges claude-subscription tokens", async () => {
        const recipient = buildRecipientKeyPair();
        const fetchMock = vi.fn(async (url: any, init: any) => {
            if (String(url).endsWith('/api/oauth/profile')) {
                expect(init?.headers?.Authorization).toBe('Bearer at');
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
        expect(opened).toBeTruthy();
        const payload = JSON.parse(new TextDecoder().decode(opened!));
        expect(payload.raw).toEqual({
            claudeAiOauth: {
                subscriptionType: 'max',
                rateLimitTier: 'default_claude_max_20x',
            },
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

    it("exchanges gemini tokens and sends client_secret", async () => {
        const fetchMock = vi.fn(async (_url: any, init: any) => {
            const body = String(init?.body?.toString?.() ?? init?.body ?? "");
            expect(body).toContain("client_secret=");
            return {
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
            } as any;
        });

        const res = await exchangeConnectedServiceOauthTokens({
            serviceId: "gemini",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        });

        expect(typeof res.bundleB64Url).toBe("string");
        expect(res.bundleB64Url.length).toBeGreaterThan(0);
    });

    it("returns a dedicated error when Gemini does not return a refresh token", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                access_token: "at",
                // refresh_token intentionally omitted
                expires_in: 3600,
                scope: "s",
                token_type: "Bearer",
            }),
            text: async () => "",
        }));

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "gemini",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        })).rejects.toMatchObject({
            errorCode: "connect_oauth_missing_refresh_token",
        } satisfies Partial<ConnectedServiceOauthExchangeError>);
    });

    it("returns a dedicated error when Gemini OAuth code is invalid", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 400,
            json: async () => ({ error: "invalid_grant", error_description: "Bad Request" }),
            text: async () => "invalid_grant",
        }));

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "gemini",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        })).rejects.toMatchObject({
            errorCode: "connect_oauth_invalid_grant",
        } satisfies Partial<ConnectedServiceOauthExchangeError>);
    });

    it("returns a dedicated error when Gemini OAuth client is rejected", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 401,
            json: async () => ({ error: "invalid_client", error_description: "Unauthorized" }),
            text: async () => "invalid_client",
        }));

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "gemini",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        })).rejects.toMatchObject({
            errorCode: "connect_oauth_invalid_client",
        } satisfies Partial<ConnectedServiceOauthExchangeError>);
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
            serviceId: "gemini",
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
                serviceId: "gemini",
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
