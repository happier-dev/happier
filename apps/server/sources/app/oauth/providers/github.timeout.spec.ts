import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { restoreEnv, snapshotEnv } from "@/testkit/env";
import { githubOAuthProvider } from "./github";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

/** A real loopback GitHub stand-in, reached through the operator override URLs. */
async function startFakeGitHub(handler: Handler) {
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => handler(req, body, res));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        env: (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
            GITHUB_HTTP_TIMEOUT_SECONDS: "7",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
            GITHUB_OAUTH_TOKEN_URL: `${base}/login/oauth/access_token`,
            GITHUB_API_USER_URL: `${base}/user`,
            ...extra,
        }),
        close: async () => {
            server.closeAllConnections();
            server.close();
            await once(server, "close");
        },
    };
}

function json(res: ServerResponse, value: unknown): void {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
}

describe("githubOAuthProvider timeouts", () => {
    const envBackup = snapshotEnv();
    let fake: Awaited<ReturnType<typeof startFakeGitHub>> | null = null;

    afterEach(async () => {
        restoreEnv(envBackup);
        await fake?.close();
        fake = null;
    });

    it("bounds the token exchange by GITHUB_HTTP_TIMEOUT_SECONDS", async () => {
        fake = await startFakeGitHub(() => { /* never answers */ });
        await expect(githubOAuthProvider.exchangeCodeForAccessToken({ env: fake.env({ GITHUB_HTTP_TIMEOUT_SECONDS: "1" }), code: "code" }))
            .rejects.toMatchObject({ code: "outbound_timeout" });
    });

    it("bounds the profile fetch by GITHUB_HTTP_TIMEOUT_SECONDS", async () => {
        fake = await startFakeGitHub(() => { /* never answers */ });
        await expect(githubOAuthProvider.fetchProfile({ env: fake.env({ GITHUB_HTTP_TIMEOUT_SECONDS: "1" }), accessToken: "t" }))
            .rejects.toMatchObject({ code: "outbound_timeout" });
    });

    it("includes redirect_uri in the token exchange body when configured", async () => {
        let received: Record<string, unknown> = {};
        fake = await startFakeGitHub((_req, body, res) => {
            received = JSON.parse(body);
            json(res, { access_token: "t" });
        });
        const env = fake.env();

        await expect(githubOAuthProvider.exchangeCodeForAccessToken({ env, code: "code" })).resolves.toEqual({ accessToken: "t" });
        expect(received.redirect_uri).toBe(env.GITHUB_REDIRECT_URL);
    });

    it("throws a descriptive error with the body when token exchange returns malformed JSON", async () => {
        fake = await startFakeGitHub((_req, _body, res) => res.end("<html>not json</html>"));
        await expect(githubOAuthProvider.exchangeCodeForAccessToken({ env: fake.env(), code: "code" })).rejects.toThrow(
            /token_response_parse_failed \(status=200\) body=<html>not json<\/html>/i,
        );
    });

    it("throws a descriptive error with the body when profile fetch returns malformed JSON", async () => {
        fake = await startFakeGitHub((_req, _body, res) => res.end("<html>profile not json</html>"));
        await expect(githubOAuthProvider.fetchProfile({ env: fake.env(), accessToken: "t" })).rejects.toThrow(
            /profile_parse_failed \(status=200\) body=<html>profile not json<\/html>/i,
        );
    });

    it("uses GITHUB_OAUTH_AUTHORIZE_URL when provided", async () => {
        const env: NodeJS.ProcessEnv = {
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
            GITHUB_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:7777/login/oauth/authorize",
        };

        const url = await githubOAuthProvider.resolveAuthorizeUrl({
            env,
            state: "state",
            scope: "read:user",
            codeChallenge: "challenge",
            codeChallengeMethod: "S256",
        });

        expect(url.startsWith("http://127.0.0.1:7777/login/oauth/authorize?")).toBe(true);
        const parsed = new URL(url);
        expect(parsed.searchParams.get("client_id")).toBe("cid");
        expect(parsed.searchParams.get("state")).toBe("state");
        expect(parsed.searchParams.get("code_challenge")).toBe("challenge");
    });

    it("uses GITHUB_OAUTH_TOKEN_URL and GITHUB_API_USER_URL when provided", async () => {
        const paths: string[] = [];
        fake = await startFakeGitHub((req, _body, res) => {
            paths.push(req.url ?? "");
            json(res, req.url === "/user" ? { id: 1, login: "alice" } : { access_token: "t" });
        });
        const env = fake.env();

        await expect(githubOAuthProvider.exchangeCodeForAccessToken({ env, code: "code" })).resolves.toEqual({ accessToken: "t" });
        await expect(githubOAuthProvider.fetchProfile({ env, accessToken: "t" })).resolves.toMatchObject({ id: 1, login: "alice" });
        expect(paths).toEqual(["/login/oauth/access_token", "/user"]);
    });
});
