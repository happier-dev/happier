import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { githubConnect } from "./githubConnect";

describe("githubConnect (AccountChange integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-githubConnect-changes-",
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
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("marks an account change with a linked providers hint", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-gh-changes-u1" },
            select: { id: true },
        });

        await githubConnect(
            { uid: account.id } as any,
            { id: 123, login: "octocat", name: "Octo Cat", avatar_url: "" } as any,
            "token",
        );

        const change = await db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "account",
                    entityId: "self",
                },
            },
            select: { cursor: true, hint: true },
        });

        expect(change).toEqual({
            cursor: expect.any(Number),
            hint: { linkedProviders: true },
        });
    });

    it("does not overwrite an existing custom username when connecting GitHub", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-gh-custom-u1", username: "custom" },
            select: { id: true },
        });

        await githubConnect(
            { uid: account.id } as any,
            { id: 123, login: "octocat", name: "Octo Cat", avatar_url: "" } as any,
            "token",
        );

        const updated = await db.account.findUnique({ where: { id: account.id }, select: { username: true } });
        expect(updated?.username).toBe("custom");
    });

    it("sets the username from GitHub login when the user has no username", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-gh-empty-u1" },
            select: { id: true },
        });

        await githubConnect(
            { uid: account.id } as any,
            { id: 123, login: "octocat", name: "Octo Cat", avatar_url: "" } as any,
            "token",
        );

        const updated = await db.account.findUnique({ where: { id: account.id }, select: { username: true } });
        expect(updated?.username).toBe("octocat");
    });
});
