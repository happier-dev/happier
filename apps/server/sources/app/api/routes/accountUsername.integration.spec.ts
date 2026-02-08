import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

describe("Account username update (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-username-", initAuth: false });
        await auth.init();
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.restoreEnv();
        vi.unstubAllGlobals();
        await harness.resetDbTables([
            () => db.repeatKey.deleteMany(),
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("POST /v1/account/username sets the current user's username", async () => {
        process.env.FRIENDS_ENABLED = "1";
        process.env.FRIENDS_ALLOW_USERNAME = "1";

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-u1" },
                    select: { id: true },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "alice" },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ username: "alice" });

                const dbUser = await db.account.findUnique({ where: { id: u1.id }, select: { username: true } });
                expect(dbUser?.username).toBe("alice");
            },
        );
    });

    it("POST /v1/account/username returns 409 username-taken when the username is already used", async () => {
        process.env.FRIENDS_ENABLED = "1";
        process.env.FRIENDS_ALLOW_USERNAME = "1";

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const taken = "alice_taken";
                await db.account.create({
                    data: { publicKey: "pk-username-taken-u1", username: taken },
                    select: { id: true },
                });
                const u2 = await db.account.create({
                    data: { publicKey: "pk-username-taken-u2" },
                    select: { id: true },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u2.id,
                    },
                    payload: { username: taken },
                });

                expect(res.statusCode).toBe(409);
                expect(res.json()).toEqual({ error: "username-taken" });
            },
        );
    });

    it("POST /v1/account/username returns 400 invalid-username for invalid usernames", async () => {
        process.env.FRIENDS_ENABLED = "1";
        process.env.FRIENDS_ALLOW_USERNAME = "1";

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-invalid-u1" },
                    select: { id: true },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "A!!" },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "invalid-username" });
            },
        );
    });

    it("POST /v1/account/username returns 400 username-disabled when FRIENDS_ALLOW_USERNAME is off", async () => {
        process.env.FRIENDS_ENABLED = "1";
        process.env.FRIENDS_ALLOW_USERNAME = "0";

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-disabled-u1" },
                    select: { id: true },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "someone" },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "username-disabled" });
            },
        );
    });

    it("POST /v1/account/username allows setting a username when Friends requires GitHub and the user has GitHub connected", async () => {
        process.env.FRIENDS_ENABLED = "1";
        process.env.FRIENDS_ALLOW_USERNAME = "0";

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-gh-required-u1" },
                    select: { id: true },
                });
                await db.accountIdentity.create({
                    data: {
                        accountId: u1.id,
                        provider: "github",
                        providerUserId: "1",
                        providerLogin: "taken_login",
                        profile: {
                            id: 1,
                            login: "taken_login",
                            avatar_url: "https://example.test/avatar.png",
                            name: null,
                        } as any,
                    },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "chosen_name" },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ username: "chosen_name" });

                const dbUser = await db.account.findUnique({ where: { id: u1.id }, select: { username: true } });
                expect(dbUser?.username).toBe("chosen_name");
            },
        );
    });

    it("POST /v1/account/username allows setting a username when Friends requires a specific identity provider and the user has that identity connected", async () => {
        process.env.FRIENDS_ENABLED = "1";
        process.env.FRIENDS_ALLOW_USERNAME = "0";
        process.env.FRIENDS_IDENTITY_PROVIDER = "custom";

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-custom-required-u1" },
                    select: { id: true },
                });
                await db.accountIdentity.create({
                    data: {
                        accountId: u1.id,
                        provider: "custom",
                        providerUserId: "1",
                        providerLogin: "someone",
                        profile: { id: 1, login: "someone" } as any,
                    },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "chosen_custom" },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ username: "chosen_custom" });

                const dbUser = await db.account.findUnique({ where: { id: u1.id }, select: { username: true } });
                expect(dbUser?.username).toBe("chosen_custom");
            },
        );
    });

    it("POST /v1/account/username returns 400 friends-disabled when FRIENDS_ENABLED is off", async () => {
        process.env.FRIENDS_ENABLED = "0";
        process.env.FRIENDS_ALLOW_USERNAME = "1";

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-friends-disabled-u1" },
                    select: { id: true },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "someone_else" },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "friends-disabled" });
            },
        );
    });
});
