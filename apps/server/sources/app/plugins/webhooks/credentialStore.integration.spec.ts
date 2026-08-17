import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    createInitialPluginWebhookCredentialV1,
    readPluginWebhookVerificationCredentialsV1,
    rotatePluginWebhookCredentialV1,
} from "./credentialStore";

describe("plugin webhook credential durable storage", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-webhook-credentials-",
            initAuth: false,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.pluginWebhookCredential.deleteMany(),
            () => db.pluginWebhookRoute.deleteMany(),
        ]);
    });

    async function createRoute(routeId: string) {
        return await db.pluginWebhookRoute.create({
            data: {
                id: routeId,
                opaqueRouteId: `opaque-${routeId}`,
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "accountEndpoint",
            },
        });
    }

    it("persists only encrypted initial secret material and reads it through the exact route identity", async () => {
        await createRoute("route-initial");

        const created = await createInitialPluginWebhookCredentialV1({
            routeId: "route-initial",
            credentialVersionId: "credential-initial",
            secret: "initial-secret",
        });

        expect(created).toEqual({
            credentialVersionId: "credential-initial",
            secret: "initial-secret",
        });
        const row = await db.pluginWebhookCredential.findUniqueOrThrow({
            where: { credentialVersionId: "credential-initial" },
        });
        expect(Buffer.from(row.encryptedSecret).toString("utf8")).not.toContain("initial-secret");
        expect(row.state).toBe("current");
        expect(row.acceptUntil).toBeNull();
        expect(await readPluginWebhookVerificationCredentialsV1({
            routeId: "route-initial",
            now: new Date("2026-08-10T00:00:00.000Z"),
        })).toEqual([{ credentialVersionId: "credential-initial", secret: "initial-secret" }]);
    });

    it("admits only current and unexpired previous credentials and caps overlap at 24 hours", async () => {
        await createRoute("route-rotate");
        await createInitialPluginWebhookCredentialV1({
            routeId: "route-rotate",
            credentialVersionId: "credential-1",
            secret: "secret-1",
        });
        const now = new Date("2026-08-10T01:00:00.000Z");

        await rotatePluginWebhookCredentialV1({
            routeId: "route-rotate",
            credentialVersionId: "credential-2",
            secret: "secret-2",
            requestedPreviousAcceptUntil: new Date("2026-08-12T01:00:00.000Z"),
            now,
        });

        const route = await db.pluginWebhookRoute.findUniqueOrThrow({ where: { id: "route-rotate" } });
        expect(route.currentCredentialId).not.toBe(route.previousCredentialId);
        const rows = await db.pluginWebhookCredential.findMany({
            where: { routeId: "route-rotate" },
            orderBy: { credentialVersionId: "asc" },
        });
        expect(rows.map((row) => ({
            version: row.credentialVersionId,
            state: row.state,
            acceptUntil: row.acceptUntil?.toISOString() ?? null,
        }))).toEqual([
            { version: "credential-1", state: "previous", acceptUntil: "2026-08-11T01:00:00.000Z" },
            { version: "credential-2", state: "current", acceptUntil: null },
        ]);
        expect(await readPluginWebhookVerificationCredentialsV1({ routeId: "route-rotate", now })).toEqual([
            { credentialVersionId: "credential-2", secret: "secret-2" },
            { credentialVersionId: "credential-1", secret: "secret-1" },
        ]);
        expect(await readPluginWebhookVerificationCredentialsV1({
            routeId: "route-rotate",
            now: new Date("2026-08-11T01:00:00.000Z"),
        })).toEqual([{ credentialVersionId: "credential-2", secret: "secret-2" }]);
    });

    it("retires the older previous credential atomically on a third rotation", async () => {
        await createRoute("route-third");
        await createInitialPluginWebhookCredentialV1({
            routeId: "route-third",
            credentialVersionId: "credential-1",
            secret: "secret-1",
        });
        await rotatePluginWebhookCredentialV1({
            routeId: "route-third",
            credentialVersionId: "credential-2",
            secret: "secret-2",
            now: new Date("2026-08-10T00:00:00.000Z"),
        });

        await rotatePluginWebhookCredentialV1({
            routeId: "route-third",
            credentialVersionId: "credential-3",
            secret: "secret-3",
            now: new Date("2026-08-10T01:00:00.000Z"),
        });

        expect((await db.pluginWebhookCredential.findMany({
            where: { routeId: "route-third" },
            orderBy: { credentialVersionId: "asc" },
            select: { credentialVersionId: true, state: true },
        }))).toEqual([
            { credentialVersionId: "credential-2", state: "previous" },
            { credentialVersionId: "credential-3", state: "current" },
        ]);
    });
});
