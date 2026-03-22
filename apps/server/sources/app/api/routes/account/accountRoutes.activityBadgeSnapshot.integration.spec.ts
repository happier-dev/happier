import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { accountRoutes } from "./accountRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    accountRoutes(typed);
    return trackApp(typed);
}

describe("accountRoutes (activity badge snapshot) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-activity-badges-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("returns an unread-derived badgeCount when lastViewedSessionSeq is behind session.seq", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_activity_badges_1" } });
        const token = await auth.createToken(account.id);

        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "sess-1",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 3,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        // Intentionally use raw SQL so this test is valid before the schema is implemented.
        // Once the column exists, this becomes the simplest way to set it without expanding test fixtures.
        await db.$executeRawUnsafe(
            `UPDATE "Session" SET "lastViewedSessionSeq" = 1 WHERE "id" = '${session.id}'`,
        );

        const res = await app.inject({
            method: "GET",
            url: "/v1/account/activity/badge-snapshot",
            headers: { authorization: `Bearer ${token}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(body).toMatchObject({
            badgeCount: 1,
        });
    });

    it("counts a session once when multiple activity reasons are active", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_activity_badges_2" } });
        const token = await auth.createToken(account.id);

        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "sess-2",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 5,
                pendingVersion: 0,
                pendingCount: 2,
                active: true,
            },
            select: { id: true },
        });

        await db.$executeRawUnsafe(
            `UPDATE "Session" SET "lastViewedSessionSeq" = 1, "pendingPermissionRequestCount" = 2, "pendingUserActionRequestCount" = 1 WHERE "id" = '${session.id}'`,
        );

        const res = await app.inject({
            method: "GET",
            url: "/v1/account/activity/badge-snapshot",
            headers: { authorization: `Bearer ${token}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(body).toMatchObject({
            badgeCount: 1,
        });
    });
});
