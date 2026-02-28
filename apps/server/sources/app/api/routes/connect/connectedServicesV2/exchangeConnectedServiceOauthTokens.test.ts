import { describe, expect, it, vi } from "vitest";

import { encodeBase64, BOX_BUNDLE_PUBLIC_KEY_BYTES } from "@happier-dev/protocol";

import { ConnectedServiceOauthStateMismatchError, ConnectedServiceOauthTimeoutError, exchangeConnectedServiceOauthTokens } from "./exchangeConnectedServiceOauthTokens";

function buildRecipientPublicKeyB64Url(): string {
    const bytes = new Uint8Array(BOX_BUNDLE_PUBLIC_KEY_BYTES).fill(7);
    return encodeBase64(bytes, "base64url");
}

describe("exchangeConnectedServiceOauthTokens", () => {
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
        const fetchMock = vi.fn(async (_url: any, init: any) => {
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
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
            state: "s",
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(typeof res.bundleB64Url).toBe("string");
        expect(res.bundleB64Url.length).toBeGreaterThan(0);
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

    it("exchanges gemini tokens without sending client_secret", async () => {
        const fetchMock = vi.fn(async (_url: any, init: any) => {
            const body = String(init?.body?.toString?.() ?? init?.body ?? "");
            expect(body).not.toContain("client_secret=");
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

    it("passes an AbortSignal to token exchange fetch requests", async () => {
        const envBackup = process.env.HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS;
        process.env.HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS = "5000";
        try {
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
        } finally {
            if (typeof envBackup === "string") {
                process.env.HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS = envBackup;
            } else {
                delete (process.env as any).HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS;
            }
        }
    });

    it("aborts token exchange when the timeout elapses", async () => {
        const envBackup = process.env.HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS;
        process.env.HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS = "1000";
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
            if (typeof envBackup === "string") {
                process.env.HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS = envBackup;
            } else {
                delete (process.env as any).HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS;
            }
        }
    });
});
