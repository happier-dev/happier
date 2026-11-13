import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Context } from "@/context";
import { db } from "@/storage/db";
import { logger } from "@/utils/logging/log";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

// DNS is the system boundary the canonical outbound owner validates and pins; counting its
// lookups proves the avatar import goes through it rather than an unpinned global fetch.
const dns = vi.hoisted(() => ({ lookups: [] as string[] }));
vi.mock("node:dns/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:dns/promises")>();
    return {
        ...actual,
        lookup: vi.fn(async (hostname: string, options?: object) => {
            if (hostname !== "localhost") return actual.lookup(hostname, options as never);
            dns.lookups.push(hostname);
            return [{ address: "127.0.0.1", family: 4 }];
        }),
    };
});

import { githubConnect } from "./githubConnect";

describe("githubConnect avatar import (integration)", () => {
    let harness: LightSqliteHarness;
    let server: Server;
    let port = 0;
    const hits: string[] = [];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-gh-avatar-",
            initEncrypt: true,
            initAuth: false,
            initFiles: true,
        });
        const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#336699" } }).png().toBuffer();
        server = createServer((req, res) => {
            hits.push(req.url ?? "");
            if (req.url?.startsWith("/redirected.png")) {
                res.writeHead(302, { location: "/avatar.png" }).end();
                return;
            }
            res.setHeader("content-type", "image/png");
            res.end(png);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        port = (server.address() as AddressInfo).port;
    }, 120_000);

    afterAll(async () => {
        server.close();
        await harness.close();
    });

    beforeEach(() => {
        hits.length = 0;
        dns.lookups.length = 0;
        harness.resetEnv({ GITHUB_API_USER_URL: undefined });
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
            () => db.uploadedFile.deleteMany(),
        ]);
    });

    async function connect(avatarUrl: string, id: number) {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-avatar-${id}` }, select: { id: true } });
        await githubConnect(Context.create(account.id), { id, login: `user${id}`, name: "User", avatar_url: avatarUrl } as never, "access-token");
        return db.account.findUnique({ where: { id: account.id }, select: { avatar: true } });
    }

    it("imports an operator-configured GitHub avatar through the pinned outbound owner", async () => {
        harness.resetEnv({ GITHUB_API_USER_URL: `http://localhost:${port}/user` });

        const account = await connect(`http://localhost:${port}/avatar.png`, 901);

        expect(dns.lookups).toEqual(["localhost"]);
        expect(hits).toEqual(["/avatar.png"]);
        expect(account?.avatar).not.toBeNull();
    });

    it("applies the public-only GitHub policy to avatars named by the default github.com profile", async () => {
        const account = await connect(`http://localhost:${port}/avatar.png`, 902);

        expect(hits).toEqual([]);
        expect(account?.avatar).toBeNull();
    });

    it("reports a failed avatar import on the server log and still connects without an avatar", async () => {
        harness.resetEnv({ GITHUB_API_USER_URL: `http://localhost:${port}/user` });
        const warn = vi.spyOn(logger, "warn");
        try {
            const account = await connect(`http://localhost:${port}/redirected.png?token=secret`, 903);

            expect(hits).toEqual(["/redirected.png?token=secret"]);
            expect(account?.avatar).toBeNull();
            const reports = warn.mock.calls.filter(([entry]) => (entry as { module?: string })?.module === "github-avatar");
            expect(reports).toHaveLength(1);
            expect(reports[0]?.[0]).toMatchObject({ reason: "outbound_unexpected_redirect" });
            expect(JSON.stringify(reports[0])).not.toMatch(/localhost|secret|redirected/);
            const identity = await db.accountIdentity.findFirst({ where: { provider: "github", providerUserId: "903" }, select: { id: true } });
            expect(identity).not.toBeNull();
        } finally {
            warn.mockRestore();
        }
    });
});
