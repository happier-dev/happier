import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

const IDENTITY_X = `direct:v1:${"1".repeat(64)}`;
const IDENTITY_Y = `direct:v1:${"2".repeat(64)}`;
const IDENTITY_TAGGED = `direct:v1:${"3".repeat(64)}`;

describe("sessionRoutes external identity claim (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-external-identity-claim-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (harness) {
            await harness.close();
        }
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("records an identity, lets only the same Session replace it, refuses takeovers, and stays Account-scoped", async () => {
        const owner = await db.account.create({
            data: { publicKey: "pk-external-identity-owner", encryptionMode: "e2ee" },
            select: { id: true },
        });
        const otherAccount = await db.account.create({
            data: { publicKey: "pk-external-identity-other", encryptionMode: "e2ee" },
            select: { id: true },
        });
        const createSession = async (accountId: string, tag: string) => db.session.create({
            data: { tag, accountId, metadata: `metadata-${tag}` },
            select: { id: true },
        });
        const first = await createSession(owner.id, "hosted-first");
        const second = await createSession(owner.id, "hosted-second");
        await createSession(owner.id, IDENTITY_TAGGED);
        const foreign = await createSession(otherAccount.id, "hosted-foreign");

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const claim = async (accountId: string, sessionId: string, externalIdentityTag: string) => {
                    const response = await app.inject({
                        method: "PATCH",
                        url: `/v2/sessions/${sessionId}`,
                        headers: { "content-type": "application/json", "x-test-user-id": accountId },
                        payload: { externalIdentityTag },
                    });
                    return { status: response.statusCode, body: response.json() };
                };

                expect(await claim(owner.id, first.id, IDENTITY_X))
                    .toEqual({ status: 200, body: { externalIdentity: "claimed" } });
                expect(await claim(owner.id, first.id, IDENTITY_X))
                    .toEqual({ status: 200, body: { externalIdentity: "already_claimed" } });
                expect(await claim(owner.id, second.id, IDENTITY_X)).toEqual({
                    status: 409,
                    body: { code: "session_external_identity_conflict", reason: "taken" },
                });
                expect(await claim(owner.id, second.id, IDENTITY_TAGGED)).toEqual({
                    status: 409,
                    body: { code: "session_external_identity_conflict", reason: "taken" },
                });
                // The Session moved to another conversation: it replaces its own claim
                // and the old identity stops resolving to it.
                expect(await claim(owner.id, first.id, IDENTITY_Y))
                    .toEqual({ status: 200, body: { externalIdentity: "replaced" } });
                expect(await claim(owner.id, second.id, IDENTITY_X))
                    .toEqual({ status: 200, body: { externalIdentity: "claimed" } });
                expect(await claim(owner.id, first.id, IDENTITY_X)).toEqual({
                    status: 409,
                    body: { code: "session_external_identity_conflict", reason: "taken" },
                });
                expect(await claim(owner.id, first.id, IDENTITY_TAGGED)).toEqual({
                    status: 409,
                    body: { code: "session_external_identity_conflict", reason: "taken" },
                });
                expect(await claim(otherAccount.id, foreign.id, IDENTITY_X))
                    .toEqual({ status: 200, body: { externalIdentity: "claimed" } });
                expect((await claim(otherAccount.id, first.id, IDENTITY_Y)).status).toBe(403);
                expect((await claim(owner.id, "missing-session", IDENTITY_Y)).status).not.toBe(200);
                expect((await claim(owner.id, second.id, "direct:v1:not-a-hash")).status).toBe(400);
            },
        );

        const rows = await db.session.findMany({
            select: { id: true, externalIdentityTag: true },
            orderBy: { id: "asc" },
        });
        expect(Object.fromEntries(rows.map((row) => [row.id, row.externalIdentityTag]))).toMatchObject({
            [first.id]: IDENTITY_Y,
            [second.id]: IDENTITY_X,
            [foreign.id]: IDENTITY_X,
        });
    });
});
