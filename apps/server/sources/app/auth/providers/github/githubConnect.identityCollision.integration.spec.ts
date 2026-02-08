import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { Context } from "@/context";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("githubConnect identity collisions (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-gh-collision-",
            initEncrypt: true,
            initAuth: false,
            initFiles: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(async () => {
        harness.restoreEnv();
        vi.unstubAllGlobals();
        delete process.env.GITHUB_STORE_ACCESS_TOKEN;
        await harness.resetDbTables([
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
            () => db.uploadedFile.deleteMany(),
        ]);
    });

    it("fails closed when the GitHub identity is already linked to another account", async () => {
        const { githubConnect } = await import("./githubConnect");

        const a1 = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-a1` },
            select: { id: true },
        });
        const a2 = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-a2` },
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
            id: 999,
            login: "alice",
            name: "Alice Example",
            avatar_url: "https://avatars.example.test/a.png",
        };

        // Connect a1 first.
        await githubConnect(Context.create(a1.id), githubProfile as any, "access-token");

        // Attempt to connect the same GitHub identity to a2.
        await expect(
            githubConnect(Context.create(a2.id), githubProfile as any, "access-token"),
        ).rejects.toThrow(/provider-already-linked/);

        const stillLinked = await db.accountIdentity.findFirst({
            where: { accountId: a1.id, provider: "github" },
            select: { providerUserId: true },
        });
        expect(stillLinked?.providerUserId).toBe("999");
    });
});
