import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { Context } from "@/context";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("githubConnect token storage (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-gh-token-",
            initEncrypt: true,
            initAuth: false,
            initFiles: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.restoreEnv();
        vi.unstubAllGlobals();
        delete process.env.GITHUB_STORE_ACCESS_TOKEN;
        delete process.env.AUTH_GITHUB_ALLOWED_ORGS;
        delete process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE;
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
            () => db.uploadedFile.deleteMany(),
        ]);
    });

    it("does not persist GitHub access tokens by default", async () => {
        const { githubConnect } = await import("./githubConnect");

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-a` },
            select: { id: true },
        });

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                arrayBuffer: async () => new ArrayBuffer(1),
            })) as any,
        );

        const githubProfile = {
            id: 123,
            login: "alice",
            name: "Alice Example",
            avatar_url: "https://avatars.example.test/a.png",
        };

        await githubConnect(Context.create(account.id), githubProfile as any, "access-token");

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account.id, provider: "github" },
            select: { token: true },
        });
        expect(identity).toBeTruthy();
        expect(identity!.token).toBeNull();
    });

    it("does not throw when the avatar fetch fails", async () => {
        const { githubConnect } = await import("./githubConnect");

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-avatar-fail` },
            select: { id: true },
        });

        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("network down");
        }) as any);

        const githubProfile = {
            id: 457,
            login: "alice",
            name: "Alice Example",
            avatar_url: "https://avatars.example.test/a.png",
        };

        await expect(githubConnect(Context.create(account.id), githubProfile as any, "access-token")).resolves.toBeUndefined();

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account.id, provider: "github" },
            select: { providerUserId: true },
        });
        expect(identity?.providerUserId).toBe("457");

        const dbUser = await db.account.findUnique({ where: { id: account.id }, select: { avatar: true } });
        expect(dbUser?.avatar).toBeNull();
    });

    it("creates an AccountIdentity row for the GitHub profile", async () => {
        const { githubConnect } = await import("./githubConnect");

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-id` },
            select: { id: true },
        });

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                arrayBuffer: async () => new ArrayBuffer(1),
            })) as any,
        );

        const githubProfile = {
            id: 124,
            login: "alice_2",
            name: "Alice Example",
            avatar_url: "https://avatars.example.test/a.png",
        };

        await githubConnect(Context.create(account.id), githubProfile as any, "access-token");

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account.id, provider: "github" },
        });
        expect(identity).toBeTruthy();
        expect(identity?.providerUserId).toBe("124");
        expect(identity?.providerLogin).toBe("alice_2");
    });

    it("persists GitHub access tokens when GITHUB_STORE_ACCESS_TOKEN=true", async () => {
        process.env.GITHUB_STORE_ACCESS_TOKEN = "true";
        const { githubConnect } = await import("./githubConnect");

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-b` },
            select: { id: true },
        });

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                arrayBuffer: async () => new ArrayBuffer(1),
            })) as any,
        );

        const githubProfile = {
            id: 456,
            login: "bob",
            name: "Bob Example",
            avatar_url: "https://avatars.example.test/b.png",
        };

        await githubConnect(Context.create(account.id), githubProfile as any, "access-token");

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account.id, provider: "github" },
            select: { token: true },
        });
        expect(identity?.token).not.toBeNull();
    });

    it("persists GitHub access tokens by default when org membership checks rely on user tokens", async () => {
        // When using oauth_user_token org membership enforcement, token storage must be enabled
        // (otherwise eligibility checks fail-closed).
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE = "oauth_user_token";
        delete process.env.GITHUB_STORE_ACCESS_TOKEN;

        const { githubConnect } = await import("./githubConnect");

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-org-token-default` },
            select: { id: true },
        });

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                arrayBuffer: async () => new ArrayBuffer(1),
            })) as any,
        );

        const githubProfile = {
            id: 789,
            login: "orguser",
            name: "Org User",
            avatar_url: "https://avatars.example.test/c.png",
        };

        await githubConnect(Context.create(account.id), githubProfile as any, "access-token");

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account.id, provider: "github" },
            select: { token: true },
        });
        expect(identity?.token).not.toBeNull();
    });
});
