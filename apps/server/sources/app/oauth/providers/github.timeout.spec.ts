import { afterEach, describe, expect, it, vi } from "vitest";

import { githubOAuthProvider } from "./github";

describe("githubOAuthProvider timeouts", () => {
    const envBackup = { ...process.env };

    afterEach(() => {
        for (const k of Object.keys(process.env)) {
            if (!(k in envBackup)) delete process.env[k];
        }
        for (const [k, v] of Object.entries(envBackup)) {
            if (typeof v === "undefined") delete process.env[k];
            else process.env[k] = v;
        }
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("uses GITHUB_HTTP_TIMEOUT_SECONDS for the token exchange request", async () => {
        const env: NodeJS.ProcessEnv = {
            GITHUB_HTTP_TIMEOUT_SECONDS: "7",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        };

        const setTimeoutSpy = vi
            .spyOn(globalThis, "setTimeout")
            .mockImplementation(((fn: (...args: any[]) => void, _ms?: number) => 0) as any);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                json: async () => ({ access_token: "t" }),
            })) as any,
        );

        await githubOAuthProvider.exchangeCodeForAccessToken({ env, code: "code" });
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 7_000);
    });

    it("includes redirect_uri in the token exchange body when configured", async () => {
        const env: NodeJS.ProcessEnv = {
            GITHUB_HTTP_TIMEOUT_SECONDS: "7",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        };

        const fetchSpy = vi.fn(async () => ({
            ok: true,
            json: async () => ({ access_token: "t" }),
        }));
        vi.stubGlobal("fetch", fetchSpy as any);

        await githubOAuthProvider.exchangeCodeForAccessToken({ env, code: "code" });
        const opts = (fetchSpy as any).mock.calls[0]?.[1] as any;
        const body = JSON.parse(String(opts?.body ?? "{}"));
        expect(body.redirect_uri).toBe(env.GITHUB_REDIRECT_URL);
    });

    it("uses GITHUB_HTTP_TIMEOUT_SECONDS for the profile fetch request", async () => {
        process.env.GITHUB_HTTP_TIMEOUT_SECONDS = "5";
        const env: NodeJS.ProcessEnv = { GITHUB_HTTP_TIMEOUT_SECONDS: "7" };

        const setTimeoutSpy = vi
            .spyOn(globalThis, "setTimeout")
            .mockImplementation(((fn: (...args: any[]) => void, _ms?: number) => 0) as any);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                json: async () => ({ id: 1, login: "alice" }),
            })) as any,
        );

        await githubOAuthProvider.fetchProfile({ env, accessToken: "t" });
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 7_000);
    });

    it("throws a descriptive error when token exchange returns malformed JSON", async () => {
        const env: NodeJS.ProcessEnv = {
            GITHUB_HTTP_TIMEOUT_SECONDS: "7",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        };

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => {
                    throw new Error("bad json");
                },
                text: async () => "<html>not json</html>",
            })) as any,
        );

        await expect(githubOAuthProvider.exchangeCodeForAccessToken({ env, code: "code" })).rejects.toThrow(
            /token_response_parse_failed/i,
        );
    });

    it("retains token response body details when JSON parsing fails after body consumption", async () => {
        const env: NodeJS.ProcessEnv = {
            GITHUB_HTTP_TIMEOUT_SECONDS: "7",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        };

        let consumed = false;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => {
                    consumed = true;
                    throw new Error("bad json");
                },
                text: async () => (consumed ? "" : "<html>not json</html>"),
            })) as any,
        );

        await expect(githubOAuthProvider.exchangeCodeForAccessToken({ env, code: "code" })).rejects.toThrow(
            /body=<html>not json<\/html>/i,
        );
    });

    it("throws a descriptive error when profile fetch returns malformed JSON", async () => {
        const env: NodeJS.ProcessEnv = { GITHUB_HTTP_TIMEOUT_SECONDS: "7" };

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => {
                    throw new Error("bad json");
                },
                text: async () => "not json",
            })) as any,
        );

        await expect(githubOAuthProvider.fetchProfile({ env, accessToken: "t" })).rejects.toThrow(/profile_parse_failed/i);
    });

    it("retains profile response body details when JSON parsing fails after body consumption", async () => {
        const env: NodeJS.ProcessEnv = { GITHUB_HTTP_TIMEOUT_SECONDS: "7" };

        let consumed = false;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => {
                    consumed = true;
                    throw new Error("bad json");
                },
                text: async () => (consumed ? "" : "<html>profile not json</html>"),
            })) as any,
        );

        await expect(githubOAuthProvider.fetchProfile({ env, accessToken: "t" })).rejects.toThrow(
            /body=<html>profile not json<\/html>/i,
        );
    });

    it("parses token exchange JSON from text when clone is unavailable", async () => {
        const env: NodeJS.ProcessEnv = {
            GITHUB_HTTP_TIMEOUT_SECONDS: "7",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        };

        let consumed = false;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                text: async () => {
                    consumed = true;
                    return JSON.stringify({ access_token: "t" });
                },
                json: async () => {
                    if (consumed) throw new Error("body stream already consumed");
                    return { access_token: "t" };
                },
            })) as any,
        );

        await expect(githubOAuthProvider.exchangeCodeForAccessToken({ env, code: "code" })).resolves.toEqual({
            accessToken: "t",
        });
    });

    it("parses profile JSON from text when clone is unavailable", async () => {
        const env: NodeJS.ProcessEnv = { GITHUB_HTTP_TIMEOUT_SECONDS: "7" };

        let consumed = false;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                text: async () => {
                    consumed = true;
                    return JSON.stringify({ id: 1, login: "alice" });
                },
                json: async () => {
                    if (consumed) throw new Error("body stream already consumed");
                    return { id: 1, login: "alice" };
                },
            })) as any,
        );

        await expect(githubOAuthProvider.fetchProfile({ env, accessToken: "t" })).resolves.toMatchObject({
            id: 1,
            login: "alice",
        });
    });
});
