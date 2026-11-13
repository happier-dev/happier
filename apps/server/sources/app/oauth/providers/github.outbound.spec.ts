import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DNS is the system boundary the canonical outbound owner validates and pins. Counting
// its lookups (and steering its answers) proves the legacy GitHub calls go through it.
const dns = vi.hoisted(() => ({ answers: new Map<string, string[]>(), lookups: [] as string[] }));
vi.mock("node:dns/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:dns/promises")>();
    return {
        ...actual,
        lookup: vi.fn(async (hostname: string) => {
            dns.lookups.push(hostname);
            const answers = dns.answers.get(hostname);
            if (!answers) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
            return answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
        }),
    };
});

import { githubOAuthProvider } from "./github";

type FakeGitHub = Readonly<{ server: Server; port: number; hits: string[] }>;

async function startFakeGitHub(): Promise<FakeGitHub> {
    const hits: string[] = [];
    const server = createServer((req, res) => {
        hits.push(req.url ?? "");
        res.setHeader("content-type", "application/json");
        if (req.url === "/login/oauth/access_token") {
            res.end(JSON.stringify({ access_token: "t" }));
            return;
        }
        if (req.url === "/user") {
            res.end(JSON.stringify({ id: 1, login: "alice" }));
            return;
        }
        res.statusCode = 404;
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, port: (server.address() as AddressInfo).port, hits };
}

const baseEnv = {
    GITHUB_HTTP_TIMEOUT_SECONDS: "7",
    GITHUB_CLIENT_ID: "cid",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
} as const satisfies NodeJS.ProcessEnv;

describe("legacy GitHub OAuth outbound transport", () => {
    let fake: FakeGitHub;

    beforeEach(async () => {
        dns.answers.clear();
        dns.lookups.length = 0;
        fake = await startFakeGitHub();
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        fake.server.close();
        await once(fake.server, "close");
    });

    it("resolves and pins operator-configured token and user endpoints through the outbound owner", async () => {
        dns.answers.set("localhost", ["127.0.0.1"]);
        const env: NodeJS.ProcessEnv = {
            ...baseEnv,
            GITHUB_OAUTH_TOKEN_URL: `http://localhost:${fake.port}/login/oauth/access_token`,
            GITHUB_API_USER_URL: `http://localhost:${fake.port}/user`,
        };

        const [token, profile] = await Promise.allSettled([
            githubOAuthProvider.exchangeCodeForAccessToken({ env, code: "code" }),
            githubOAuthProvider.fetchProfile({ env, accessToken: "t" }),
        ]);

        expect(dns.lookups).toEqual(["localhost", "localhost"]);
        expect(fake.hits.sort()).toEqual(["/login/oauth/access_token", "/user"]);
        expect(token).toEqual({ status: "fulfilled", value: { accessToken: "t" } });
        expect(profile).toMatchObject({ status: "fulfilled", value: { id: 1, login: "alice" } });
    });

    it("connects only to the validated answer, never re-resolving the hostname", async () => {
        // The validated answer has no listener; a second (system) lookup would reach the fake.
        dns.answers.set("localhost", ["::1"]);
        const env: NodeJS.ProcessEnv = { ...baseEnv, GITHUB_API_USER_URL: `http://localhost:${fake.port}/user` };

        await expect(githubOAuthProvider.fetchProfile({ env, accessToken: "t" })).rejects.toThrow();

        expect(dns.lookups).toEqual(["localhost"]);
        expect(fake.hits).toEqual([]);
    });

    it("applies the public-only GitHub policy to the default github.com endpoints", async () => {
        dns.answers.set("api.github.com", ["10.0.0.7"]);
        const globalFetch = vi.fn(async () => new Response("{}"));
        vi.stubGlobal("fetch", globalFetch);

        await expect(githubOAuthProvider.fetchProfile({ env: { ...baseEnv }, accessToken: "t" }))
            .rejects.toMatchObject({ code: "outbound_address_forbidden" });

        expect(dns.lookups).toEqual(["api.github.com"]);
        expect(globalFetch).not.toHaveBeenCalled();
    });
});
