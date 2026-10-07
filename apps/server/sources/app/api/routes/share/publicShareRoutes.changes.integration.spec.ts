import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    encodeBase64,
    stringifySerializedJsonValue,
} from "@happier-dev/protocol";
import { createHash } from "node:crypto";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { publicShareRoutes } from "./publicShareRoutes";

const { emitUpdate, buildPublicShareCreatedUpdate, buildPublicShareUpdatedUpdate, buildPublicShareDeletedUpdate, randomKeyNaked, markAccountChanged } =
    vi.hoisted(() => ({
        emitUpdate: vi.fn(),
        buildPublicShareCreatedUpdate: vi.fn((_ps: any, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "public-share-created" },
        })),
        buildPublicShareUpdatedUpdate: vi.fn((_ps: any, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "public-share-updated" },
        })),
        buildPublicShareDeletedUpdate: vi.fn((_sessionId: string, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "public-share-deleted" },
        })),
        randomKeyNaked: vi.fn(() => "upd-id"),
        markAccountChanged: vi.fn(async (_tx: any, params: any) => {
            if (params.kind === "share") return 50;
            if (params.kind === "session") return 51;
            return 99;
        }),
    }));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildPublicShareCreatedUpdate,
    buildPublicShareUpdatedUpdate,
    buildPublicShareDeletedUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

const VALID_ENCRYPTED_DATA_KEY = encodeBase64(
    new Uint8Array(
        24 + 16 + new TextEncoder().encode(
            stringifySerializedJsonValue({ v: 0, keyB64: "A".repeat(44) }),
        ).byteLength,
    ).fill(1),
    "base64",
);
const MALFORMED_ENCRYPTED_DATA_KEY = encodeBase64(Uint8Array.from([0, ...new Array(73).fill(1)]), "base64");
const CURRENT_ACCOUNT_STORED_CONTENT_HEADERS =
    buildAccountStoredContentCompatibilityHttpHeadersV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    );
const STORED_OWNER_METADATA_ENVELOPE_V1 = JSON.stringify({
    t: "encrypted",
    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
});

describe("publicShareRoutes (AccountChange integration)", () => {
    let harness: LightSqliteHarness;
    let seedCounter = 0;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-public-share-changes-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
            env: {
                HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.example.test',
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: '1',
            },
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.publicShareAccessLog.deleteMany(),
            () => db.publicSessionShare.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.teamMembership.deleteMany(),
            () => db.team.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedOwnerSession(encryptionMode: "e2ee" | "plain" = "e2ee") {
        seedCounter += 1;
        const seedId = `${encryptionMode}-${seedCounter}`;
        const owner = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });

        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${seedId}`,
                encryptionMode,
                metadata: JSON.stringify({ v: 1 }),
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                agentState: null,
            },
            select: { id: true },
        });

        return { owner, session };
    }

    it("fails every public-share route closed when sharing.public is disabled", async () => {
        vi.stubEnv("HAPPIER_BUILD_FEATURES_DENY", "sharing.public");

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                for (const request of [
                    {
                        method: "GET" as const,
                        url: "/v1/sessions/unavailable/public-share",
                        headers: { "x-test-user-id": "unavailable-account" },
                    },
                    {
                        method: "POST" as const,
                        url: "/v1/sessions/unavailable/public-share",
                        headers: {
                            "x-test-user-id": "unavailable-account",
                            "content-type": "application/json",
                        },
                        payload: { lookupId: "must-not-reach-handler", keyDerivation: "fragment_v1" },
                    },
                    {
                        method: "DELETE" as const,
                        url: "/v1/sessions/unavailable/public-share",
                        headers: { "x-test-user-id": "unavailable-account" },
                    },
                    {
                        method: "GET" as const,
                        url: "/v1/sessions/unavailable/public-share/access-logs",
                        headers: { "x-test-user-id": "unavailable-account" },
                    },
                    {
                        method: "GET" as const,
                        url: "/v1/public-share/unavailable-token",
                    },
                    // The anonymous transcript page is the only remaining route
                    // in this family. Registering it on the ungated app instead
                    // of the gated one would leave published content readable
                    // after the build denied `sharing.public`.
                    {
                        method: "GET" as const,
                        url: "/v1/public-share/unavailable-token/messages",
                    },
                ]) {
                    const response = await app.inject(request);
                    expect(response.statusCode, response.body).toBe(404);
                    expect(response.json()).toEqual({ error: "not_found" });
                }
            },
        );
    });

    it("returns the canonical typed capability denial for every public-link owner operation", async () => {
        const { session } = await seedOwnerSession("plain");
        const stranger = await db.account.create({
            data: {
                publicKey: crypto.randomUUID(),
                encryptionMode: "plain",
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                for (const request of [
                    { method: "GET" as const },
                    {
                        method: "POST" as const,
                        headers: { "content-type": "application/json" },
                        payload: { lookupId: "forbidden-public-link", keyDerivation: "fragment_v1" },
                    },
                    { method: "DELETE" as const },
                ]) {
                    const response = await app.inject({
                        ...request,
                        url: `/v1/sessions/${session.id}/public-share`,
                        headers: {
                            "x-test-user-id": stranger.id,
                            ...request.headers,
                        },
                    });

                    expect(response.statusCode, response.body).toBe(403);
                    expect(response.json()).toEqual({ error: "session_access_forbidden" });
                }

                const accessLogs = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${session.id}/public-share/access-logs`,
                    headers: { "x-test-user-id": stranger.id },
                });
                expect(accessLogs.statusCode, accessLogs.body).toBe(403);
                expect(accessLogs.json()).toEqual({ error: "session_access_forbidden" });
            },
        );
    });

    it("preserves an explicit epoch expiry through POST, persistence, and GET", async () => {
        const { owner, session } = await seedOwnerSession("plain");

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const create = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: { lookupId: "epoch-expiry-token", keyDerivation: "fragment_v1", expiresAt: 0 },
                });
                expect(create.statusCode, create.body).toBe(200);
                expect(create.json().publicShare.expiresAt).toBe(0);

                const read = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: { "x-test-user-id": owner.id },
                });
                expect(read.statusCode, read.body).toBe(200);
                expect(read.json().publicShare.expiresAt).toBe(0);
            },
        );

        const stored = await db.publicSessionShare.findUniqueOrThrow({
            where: { sessionId: session.id },
            select: { expiresAt: true },
        });
        expect(stored.expiresAt?.getTime()).toBe(0);
    });

    it("treats an exact public-link desired-state replay as a no-op without resetting usage or publishing again", async () => {
        const { owner, session } = await seedOwnerSession("plain");
        const token = "exact-replay-token";
        const expiresAt = 1_800_000_000_000;

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const initial = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: { lookupId: token, keyDerivation: "fragment_v1", expiresAt, maxUses: 5, isConsentRequired: true },
                });
                expect(initial.statusCode, initial.body).toBe(200);

                const beforeReplay = await db.publicSessionShare.update({
                    where: { sessionId: session.id },
                    data: { useCount: 2 },
                });
                vi.clearAllMocks();

                const replay = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: { lookupId: token, keyDerivation: "fragment_v1", expiresAt, maxUses: 5, isConsentRequired: true },
                });
                expect(replay.statusCode, replay.body).toBe(200);
                expect(replay.json().publicShare).toMatchObject({
                    token,
                    expiresAt,
                    maxUses: 5,
                    useCount: 2,
                    isConsentRequired: true,
                    updatedAt: beforeReplay.updatedAt.getTime(),
                });

                const afterReplay = await db.publicSessionShare.findUniqueOrThrow({
                    where: { sessionId: session.id },
                });
                expect(afterReplay).toMatchObject({
                    id: beforeReplay.id,
                    useCount: 2,
                    expiresAt: new Date(expiresAt),
                    maxUses: 5,
                    isConsentRequired: true,
                    updatedAt: beforeReplay.updatedAt,
                });
                expect(Buffer.from(afterReplay.tokenHash)).toEqual(
                    Buffer.from(beforeReplay.tokenHash),
                );
                expect(markAccountChanged).not.toHaveBeenCalled();
                expect(emitUpdate).not.toHaveBeenCalled();

                const changed = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: {
                        lookupId: "genuinely-changed-token",
                        keyDerivation: "fragment_v1",
                        expiresAt,
                        maxUses: 5,
                        isConsentRequired: true,
                    },
                });
                expect(changed.statusCode, changed.body).toBe(200);
                expect(changed.json().publicShare.useCount).toBe(0);
            },
        );

        const afterChangedToken = await db.publicSessionShare.findUniqueOrThrow({
            where: { sessionId: session.id },
            select: { tokenHash: true, useCount: true },
        });
        expect(afterChangedToken.useCount).toBe(0);
        expect(Buffer.from(afterChangedToken.tokenHash)).toEqual(
            createHash("sha256").update("genuinely-changed-token", "utf8").digest(),
        );
        expect(markAccountChanged).toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalled();
    });

    it("POST create rejects malformed E2EE encryptedDataKey envelopes", async () => {
        const { owner, session } = await seedOwnerSession();

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: {
                        lookupId: "tok-invalid-dek",
                        keyDerivation: "fragment_v1",
                        encryptedDataKey: MALFORMED_ENCRYPTED_DATA_KEY,
                    },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "Invalid encryptedDataKey" });
            },
        );

        await expect(db.publicSessionShare.findUnique({
            where: { sessionId: session.id },
            select: { id: true },
        })).resolves.toBeNull();
    });

    it("POST create preserves the primary Team's typed external-sharing denial", async () => {
        const { owner, session } = await seedOwnerSession("plain");
        const team = await db.team.create({
            data: { name: `No external links ${crypto.randomUUID()}`, externalSharingPolicy: "disabled" },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        await db.session.update({ where: { id: session.id }, data: { primaryTeamId: team.id } });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: { lookupId: "disabled-public-link", keyDerivation: "fragment_v1" },
                });
                expect(res.statusCode).toBe(403);
                expect(res.json()).toEqual({ error: "session_access_external_sharing_disabled" });
            },
        );
        await expect(db.publicSessionShare.findUnique({ where: { sessionId: session.id } })).resolves.toBeNull();
    });

    it("POST create removes only Follow edges made unsafe by the newly public destination", async () => {
        const { owner, session } = await seedOwnerSession("plain");
        const [source, destination] = await Promise.all([
            db.session.create({ data: {
                accountId: owner.id,
                tag: `follow-source-${crypto.randomUUID()}`,
                encryptionMode: "plain",
                metadata: "{}",
            } }),
            db.session.create({ data: {
                accountId: owner.id,
                tag: `follow-destination-${crypto.randomUUID()}`,
                encryptionMode: "plain",
                metadata: "{}",
            } }),
        ]);
        await db.sessionFollowEdge.createMany({ data: [
            { sourceSessionId: source.id, destinationSessionId: session.id },
            { sourceSessionId: session.id, destinationSessionId: destination.id },
        ] });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: { lookupId: "follow-public-link", keyDerivation: "fragment_v1" },
                });
                expect(res.statusCode, res.body).toBe(200);
            },
        );

        await expect(db.sessionFollowEdge.findMany({
            orderBy: [{ destinationSessionId: "asc" }, { sourceSessionId: "asc" }],
            select: { sourceSessionId: true, destinationSessionId: true },
        })).resolves.toEqual([{
            sourceSessionId: session.id,
            destinationSessionId: destination.id,
        }]);
    });

    it("POST create reports unavailable when the primary Team's accepted authentication method is disabled", async () => {
        const { owner, session } = await seedOwnerSession("plain");
        const team = await db.team.create({
            data: {
                name: `Unavailable external-link authentication ${crypto.randomUUID()}`,
                externalSharingPolicy: "team_admins_only",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        await db.session.update({ where: { id: session.id }, data: { primaryTeamId: team.id } });
        vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "0");

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: { lookupId: "unavailable-public-link", keyDerivation: "fragment_v1" },
                });
                expect(res.statusCode, res.body).toBe(503);
                expect(res.json()).toEqual({ error: "session_access_authentication_unavailable" });
            },
        );
        await expect(db.publicSessionShare.findUnique({ where: { sessionId: session.id } })).resolves.toBeNull();
    });

    it("POST cannot reactivate an expired public link after the primary Team disables external sharing", async () => {
        const { owner, session } = await seedOwnerSession("plain");
        const team = await db.team.create({
            data: { name: `No external renewals ${crypto.randomUUID()}`, externalSharingPolicy: "disabled" },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        await db.session.update({ where: { id: session.id }, data: { primaryTeamId: team.id } });
        const expired = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update("expired-token", "utf8").digest(),
                expiresAt: new Date(0),
            },
        });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: {},
                });
                expect(res.statusCode).toBe(403);
                expect(res.json()).toEqual({ error: "session_access_external_sharing_disabled" });
            },
        );
        await expect(db.publicSessionShare.findUnique({ where: { sessionId: session.id } }))
            .resolves.toMatchObject({ id: expired.id, expiresAt: new Date(0) });
    });

    it("POST cannot rotate an active public link after the primary Team disables external sharing", async () => {
        const { owner, session } = await seedOwnerSession("plain");
        const team = await db.team.create({
            data: { name: `No external link rotation ${crypto.randomUUID()}`, externalSharingPolicy: "disabled" },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        await db.session.update({ where: { id: session.id }, data: { primaryTeamId: team.id } });
        const originalTokenHash = createHash("sha256").update("original-active-token", "utf8").digest();
        const existing = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: originalTokenHash,
                expiresAt: new Date(Date.now() + 60_000),
                maxUses: 1,
                useCount: 1,
            },
        });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const exactReplay = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: {
                        expiresAt: existing.expiresAt?.getTime(),
                        maxUses: 1,
                        isConsentRequired: false,
                    },
                });
                expect(exactReplay.statusCode, exactReplay.body).toBe(200);
                expect(exactReplay.json().publicShare).toMatchObject({
                    token: null,
                    useCount: 1,
                });
                expect(markAccountChanged).not.toHaveBeenCalled();
                expect(emitUpdate).not.toHaveBeenCalled();

                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: { lookupId: "replacement-active-token", keyDerivation: "fragment_v1", maxUses: 1 },
                });
                expect(res.statusCode).toBe(403);
                expect(res.json()).toEqual({ error: "session_access_external_sharing_disabled" });
            },
        );
        const afterDeniedRotation = await db.publicSessionShare.findUniqueOrThrow({
            where: { sessionId: session.id },
        });
        expect(afterDeniedRotation).toMatchObject({ id: existing.id, maxUses: 1, useCount: 1 });
        expect(Buffer.from(afterDeniedRotation.tokenHash)).toEqual(originalTokenHash);
    });

    it("POST still permits reducing an active public link after the primary Team disables external sharing", async () => {
        const { owner, session } = await seedOwnerSession("plain");
        const team = await db.team.create({
            data: { name: `Reduce external link ${crypto.randomUUID()}`, externalSharingPolicy: "disabled" },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        await db.session.update({ where: { id: session.id }, data: { primaryTeamId: team.id } });
        const originalExpiresAt = new Date(Date.now() + 120_000);
        const reducedExpiresAt = new Date(Date.now() + 60_000);
        const existing = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update("reduced-active-token", "utf8").digest(),
                expiresAt: originalExpiresAt,
                maxUses: 10,
                useCount: 2,
            },
        });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: { expiresAt: reducedExpiresAt.getTime(), maxUses: 5 },
                });
                expect(res.statusCode, res.body).toBe(200);
            },
        );
        await expect(db.publicSessionShare.findUnique({ where: { sessionId: session.id } }))
            .resolves.toMatchObject({ id: existing.id, expiresAt: reducedExpiresAt, maxUses: 5, useCount: 2 });
    });

    it("POST create refuses released layout-zero public sharing until owner migration", async () => {
        const { owner, session } = await seedOwnerSession();
        await db.session.update({
            where: { id: session.id },
            data: {
                metadataLayoutVersion: 0,
                ownerMetadata: null,
            },
        });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: {
                        lookupId: "tok-unsplit",
                        keyDerivation: "fragment_v1",
                        encryptedDataKey: VALID_ENCRYPTED_DATA_KEY,
                    },
                });

                expect(res.statusCode, res.body).toBe(409);
                expect(res.json()).toEqual({
                    error: "Session metadata privacy upgrade required",
                    code: "metadata_privacy_upgrade_required",
                });
            },
        );

        const stored = await db.publicSessionShare.findUnique({
            where: { sessionId: session.id },
            select: { sessionId: true, encryptedDataKey: true },
        });
        expect(stored).toBeNull();
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("POST create marks share+session and emits created update using latest cursor", async () => {
        const { owner, session } = await seedOwnerSession();

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: {
                        lookupId: "tok-create",
                        keyDerivation: "fragment_v1",
                        encryptedDataKey: VALID_ENCRYPTED_DATA_KEY,
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({
                    isolatedOrigin: expect.any(String),
                    publicShare: expect.objectContaining({
                        token: "tok-create",
                        useCount: 0,
                        isConsentRequired: false,
                    }),
                });
            },
        );

        const stored = await db.publicSessionShare.findUnique({
            where: { sessionId: session.id },
            select: { sessionId: true, encryptedDataKey: true },
        });
        expect(stored?.sessionId).toBe(session.id);
        expect(stored?.encryptedDataKey).toBeInstanceOf(Uint8Array);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: owner.id, kind: "share", entityId: session.id }),
        );
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: owner.id, kind: "session", entityId: session.id }),
        );
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: owner.id,
                payload: expect.objectContaining({
                    seq: 51,
                    body: expect.objectContaining({ t: "public-share-created" }),
                }),
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
            }),
        );
    });

    it("POST update marks share+session and emits updated update using latest cursor", async () => {
        const { owner, session } = await seedOwnerSession();
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update("tok-existing", "utf8").digest(),
                encryptedDataKey: Buffer.from([1, 2, 3]),
                maxUses: 2,
                isConsentRequired: false,
            },
        });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: {
                        "x-test-user-id": owner.id,
                        "content-type": "application/json",
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: {
                        expiresAt: 1_800_000_000_000,
                        isConsentRequired: true,
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({
                    publicShare: expect.objectContaining({
                        token: null,
                        isConsentRequired: true,
                    }),
                });
            },
        );

        const stored = await db.publicSessionShare.findUnique({
            where: { sessionId: session.id },
            select: { isConsentRequired: true, expiresAt: true },
        });
        expect(stored?.isConsentRequired).toBe(true);
        expect(stored?.expiresAt?.getTime()).toBe(1_800_000_000_000);

        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: owner.id,
                payload: expect.objectContaining({
                    seq: 51,
                    body: expect.objectContaining({ t: "public-share-updated" }),
                }),
            }),
        );
    });

    it("DELETE marks share+session and emits deleted update using latest cursor", async () => {
        const { owner, session } = await seedOwnerSession();
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update("tok-delete", "utf8").digest(),
                encryptedDataKey: Buffer.from([1, 2, 3]),
                isConsentRequired: false,
            },
        });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "DELETE",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: { "x-test-user-id": owner.id },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ success: true });
            },
        );

        const stored = await db.publicSessionShare.findUnique({
            where: { sessionId: session.id },
            select: { id: true },
        });
        expect(stored).toBeNull();
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: owner.id,
                payload: expect.objectContaining({
                    seq: 51,
                    body: expect.objectContaining({ t: "public-share-deleted" }),
                }),
            }),
        );
    });

    it("DELETE returns 404 when no public share exists", async () => {
        const { owner, session } = await seedOwnerSession();

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "DELETE",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: { "x-test-user-id": owner.id },
                });

                expect(res.statusCode).toBe(404);
                expect(res.json()).toEqual({ error: "Share not found" });
            },
        );

        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
