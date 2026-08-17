import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

const OWNER_METADATA_ENVELOPE_V1 = {
    t: "encrypted",
    c: "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
} as const;
const STORED_OWNER_METADATA_ENVELOPE_V1 =
    JSON.stringify(OWNER_METADATA_ENVELOPE_V1);

describe("sessionRoutes lookup by tags (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-lookup-by-tags-",
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

    it("returns every matching active or archived account-owned session without mutating it", async () => {
        const owner = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const otherAccount = await db.account.create({
            data: {
                publicKey: "pk-session-lookup-other",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const archivedAt = new Date("2026-07-25T10:00:00.000Z");
        const matchingActive = await db.session.create({
            data: {
                tag: "direct:v1:current-collision-candidate",
                accountId: owner.id,
                metadata: "encrypted-active-metadata",
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadataLayoutVersion: 1,
                agentState: "encrypted-active-agent-state",
                active: true,
            },
        });
        const matchingArchived = await db.session.create({
            data: {
                tag: "direct:v1:released-collision-candidate",
                accountId: owner.id,
                metadata: "encrypted-archived-metadata",
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadataLayoutVersion: 1,
                agentState: "encrypted-archived-agent-state",
                archivedAt,
            },
        });
        await db.session.create({
            data: {
                tag: matchingActive.tag,
                accountId: otherAccount.id,
                metadata: "other-account-metadata",
            },
        });
        await db.session.create({
            data: {
                tag: "not-requested",
                accountId: owner.id,
                metadata: "not-requested-metadata",
            },
        });

        const before = await db.session.findMany({
            where: { accountId: owner.id },
            orderBy: { id: "asc" },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/lookup-by-tags",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                        "x-happier-account-stored-content-protocol": "2",
                    },
                    payload: {
                        tags: [matchingActive.tag, matchingArchived.tag],
                    },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.sessions.map((session: { id: string }) => session.id).sort()).toEqual(
                    [matchingActive.id, matchingArchived.id].sort(),
                );
                expect(body.sessions).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        id: matchingActive.id,
                        active: true,
                        archivedAt: null,
                        metadata: "encrypted-active-metadata",
                        ownerMetadata: OWNER_METADATA_ENVELOPE_V1,
                        metadataLayoutVersion: 1,
                        agentState: "encrypted-active-agent-state",
                    }),
                    expect.objectContaining({
                        id: matchingArchived.id,
                        active: false,
                        archivedAt: archivedAt.getTime(),
                        metadata: "encrypted-archived-metadata",
                        ownerMetadata: OWNER_METADATA_ENVELOPE_V1,
                        metadataLayoutVersion: 1,
                        agentState: "encrypted-archived-agent-state",
                    }),
                ]));
                expect(body.sessions.every((session: object) => !("rollbackEligibleTurnStarts" in session))).toBe(true);
            },
        );

        const after = await db.session.findMany({
            where: { accountId: owner.id },
            orderBy: { id: "asc" },
        });
        expect(after).toEqual(before);
    });

    it("refuses a legacy caller before returning a layout-one owner row", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-lookup-legacy-caller",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: "direct:v1:current-only",
                accountId: owner.id,
                metadata: "shared-safe",
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadataLayoutVersion: 1,
            },
            select: { tag: true },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/lookup-by-tags",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                    },
                    payload: { tags: [session.tag] },
                });

                expect(response.statusCode).toBe(426);
                expect(response.json()).toMatchObject({
                    error: "client-upgrade-required",
                });
            },
        );
    });

    it("fails closed for future layouts and malformed owner ciphertext", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-lookup-privacy",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: "direct:v1:privacy-invalid",
                accountId: owner.id,
                metadata: "shared-safe",
                ownerMetadata: "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
                metadataLayoutVersion: 2,
            },
            select: { id: true, tag: true },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const lookup = async () => app.inject({
                    method: "POST",
                    url: "/v2/sessions/lookup-by-tags",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                        "x-happier-account-stored-content-protocol": "2",
                    },
                    payload: { tags: [session.tag] },
                });

                const futureLayout = await lookup();
                expect(futureLayout.statusCode).toBe(409);
                expect(futureLayout.json()).toEqual({
                    error: "Session metadata privacy upgrade required",
                    code: "metadata_privacy_upgrade_required",
                });

                await db.session.update({
                    where: { id: session.id },
                    data: {
                        metadataLayoutVersion: 1,
                        ownerMetadata: "encrypted-with-the-wrong-domain",
                    },
                });

                const malformedOwner = await lookup();
                expect(malformedOwner.statusCode).toBe(409);
                expect(malformedOwner.json()).toEqual({
                    error: "Session metadata privacy upgrade required",
                    code: "metadata_privacy_upgrade_required",
                });
            },
        );
    });

    it("requires authentication and returns zero rows for no account-owned match", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-lookup-auth",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const unauthenticated = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/lookup-by-tags",
                    headers: { "content-type": "application/json" },
                    payload: { tags: ["missing"] },
                });
                expect(unauthenticated.statusCode).toBe(401);

                const empty = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/lookup-by-tags",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                    },
                    payload: { tags: ["missing"] },
                });
                expect(empty.statusCode).toBe(200);
                expect(empty.json()).toEqual({ sessions: [] });
            },
        );
    });

    it("accepts at most four distinct bounded tags and returns all four indexed matches", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-lookup-bounds",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const tags = [
            "direct:v1:one",
            "direct:v1:two",
            "direct:v1:three",
            "x".repeat(SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2),
        ];
        const sessions = await Promise.all(tags.map((tag, index) => db.session.create({
            data: {
                tag,
                accountId: owner.id,
                metadata: `metadata-${index}`,
            },
            select: { id: true },
        })));
        const queryPlan = await db.$queryRawUnsafe<Array<{ detail: string }>>(
            'EXPLAIN QUERY PLAN SELECT "id" FROM "Session" WHERE "accountId" = ? AND "tag" IN (?, ?, ?, ?)',
            owner.id,
            ...tags,
        );
        expect(queryPlan.some((row) => /accountId.*tag|Session_accountId_tag_key|sqlite_autoindex_Session/i.test(row.detail)))
            .toBe(true);

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/lookup-by-tags",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                    },
                    payload: { tags },
                });

                expect(response.statusCode).toBe(200);
                expect(response.json().sessions.map((session: { id: string }) => session.id).sort()).toEqual(
                    sessions.map((session) => session.id).sort(),
                );
            },
        );
    });

    it.each([
        ["empty", { tags: [] }],
        ["duplicate", { tags: ["same", "same"] }],
        ["too many", { tags: ["one", "two", "three", "four", "five"] }],
        ["empty tag", { tags: [""] }],
        ["oversized tag", { tags: ["x".repeat(SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2 + 1)] }],
        ["extra selector", { tags: ["one"], machineId: "must-not-be-accepted" }],
    ])("rejects %s lookup input", async (_caseName, payload) => {
        const owner = await db.account.create({
            data: {
                publicKey: `pk-session-lookup-invalid-${_caseName}`,
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/lookup-by-tags",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                    },
                    payload,
                });
                expect(response.statusCode).toBe(400);
            },
        );
    });
});
