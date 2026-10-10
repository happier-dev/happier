import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    encodePlainArtifactStoredContent,
    sealEncryptedDataKeyEnvelopeV1,
} from "@happier-dev/protocol";
import tweetnacl from 'tweetnacl';
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { artifactsRoutes } from "./artifactsRoutes";

const { emitUpdate, randomKeyNaked } =
    vi.hoisted(() => ({
        emitUpdate: vi.fn(),
        randomKeyNaked: vi.fn(() => "upd-id"),
    }));

vi.mock("@/app/events/eventRouter", async () => ({
    ...await import("@/app/events/eventPayloadBuilders"),
    eventRouter: { emitUpdate },
}));
vi.mock("@/app/events/connectionEventRouter", () => ({ eventRouter: { emitUpdate } }));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("artifactsRoutes (AccountChange integration)", () => {
    let harness: LightSqliteHarness;
    const currentStoredContentHeaders = {
        "x-happier-account-stored-content-protocol": String(
            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        ),
    };

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-artifacts-changes-",
            initAuth: false,
            initEncrypt: true,
            initFiles: false,
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
            () => db.accountChange.deleteMany(),
            () => db.accountPluginUiArtifact.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.artifact.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedAccount() {
        return await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
    }

    it.each(['plain', 'e2ee'] as const)('batch reads selected %s details with the canonical recipient census and refuses foreign rows', async mode => {
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const outsider = await seedAccount();
        const ids = ['77777777-7777-4777-8777-777777777771', '77777777-7777-4777-8777-777777777772'];
        for (const id of ids) await db.artifact.create({ data: { id, accountId: owner.id,
            header: Buffer.from(mode === 'plain' ? encodePlainArtifactStoredContent({ title: id }) : 'opaque-header', mode === 'plain' ? 'base64' : 'utf8'),
            body: Buffer.from(mode === 'plain' ? encodePlainArtifactStoredContent({ body: id }) : 'opaque-body', mode === 'plain' ? 'base64' : 'utf8'),
            dataEncryptionKey: mode === 'plain' ? Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64')
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                    recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes })),
            headerVersion: 1, bodyVersion: 1, seq: 1 } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const headers = { 'x-test-user-id': owner.id };
            const exact = await app.inject({ method: 'GET', url: `/v1/artifacts/${ids[0]}`, headers });
            expect(exact.statusCode).toBe(200);
            const selected = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers,
                payload: { artifactIds: [ids[0], 'missing'] } });
            expect(selected.statusCode).toBe(200);
            expect(selected.json().items).toEqual([
                { artifactId: ids[0], ok: true, artifact: exact.json(), recipientCensus: mode === 'plain' ? null : expect.any(Object) },
                { artifactId: 'missing', ok: false, error: 'artifact_not_found', status: 404, retryable: false },
            ]);
            if (mode === 'e2ee') {
                const census = await app.inject({ method: 'GET', url: `/v1/artifacts/${ids[0]}/access/recipients`, headers });
                expect(selected.json().items[0].recipientCensus).toEqual(census.json());
            }
            const denied = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers: { 'x-test-user-id': outsider.id },
                payload: { artifactIds: ids } });
            expect(denied.statusCode).toBe(200);
            expect(denied.json().items).toEqual(ids.map(artifactId => ({ artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false })));
            const invalid = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers,
                payload: { artifactIds: [ids[0]], includeBody: true } });
            expect(invalid.statusCode).toBe(400);
        });
    });

    it('preserves exact-read refusal status and retry classification for owners and granted callers', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = '77777777-7777-4777-8777-777777777773';
        await db.artifact.create({ data: { id, accountId: owner.id,
            header: Buffer.from(encodePlainArtifactStoredContent({ title: 'Profile', kind: 'launch-profile.v1' }), 'base64'),
            body: Buffer.from('unreadable stored body'), dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64'),
            headerVersion: 1, bodyVersion: 1, seq: 1 } });
        await db.artifactAccountGrant.create({ data: { artifactId: id, accountId: recipient.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            for (const caller of [owner, recipient]) {
                const headers = { 'x-test-user-id': caller.id };
                const exact = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers });
                expect(exact.statusCode).toBe(caller.id === owner.id ? 500 : 409);
                const batch = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers,
                    payload: { artifactIds: [id] } });
                expect(batch.statusCode).toBe(200);
                expect(batch.json().items).toEqual([{ artifactId: id, ok: false, error: 'artifact_content_unavailable',
                    status: exact.statusCode, retryable: caller.id === owner.id }]);
            }
        });
    });

    async function assertArtifactChange(accountId: string, artifactId: string, deleted = false) {
        const [account, change] = await Promise.all([
            db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }),
            db.accountChange.findUniqueOrThrow({ where: {
                accountId_kind_entityId: { accountId, kind: "artifact", entityId: artifactId },
            } }),
        ]);
        expect(change).toMatchObject({ accountId, kind: "artifact", entityId: artifactId,
            artifactId: deleted ? null : artifactId, cursor: account.seq });
        expect(account.seq).toBeGreaterThan(0);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: accountId,
            payload: expect.objectContaining({ seq: account.seq, body: { t: "account-change" } }),
            recipientFilter: { type: "account-stored-content-v3" },
        }));
        return account.seq;
    }

    it("bounds artifact listing with an explicit limit query", async () => {
        const account = await seedAccount();
        for (const index of [1, 2, 3]) {
            await db.artifact.create({
                data: {
                    id: `44444444-4444-4444-8444-44444444444${index}`,
                    accountId: account.id,
                    header: Buffer.from(`head-${index}`),
                    headerVersion: 1,
                    body: Buffer.from(`body-${index}`),
                    bodyVersion: 1,
                    dataEncryptionKey: Buffer.from(`key-${index}`),
                    seq: index,
                },
            });
        }

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "GET",
                    url: "/v1/artifacts?limit=2",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toHaveLength(2);
                expect(res.json()[0]).not.toHaveProperty('body');
                const full = await app.inject({
                    method: 'GET', url: '/v1/artifacts?limit=2&includeBody=true',
                    headers: { 'x-test-user-id': account.id },
                });
                expect(full.statusCode).toBe(200);
                expect(full.json()).toHaveLength(2);
                expect(full.json()[0]).toMatchObject({ bodyVersion: 1, body: expect.any(String) });
            },
        );
    });

    it("pages Artifact headers with an opaque keyset cursor", async () => {
        const account = await seedAccount();
        for (const index of [1, 2, 3]) {
            await db.artifact.create({ data: {
                id: `66666666-6666-4666-8666-66666666666${index}`, accountId: account.id,
                header: Buffer.from(`head-${index}`), headerVersion: 1, body: Buffer.from(`body-${index}`),
                bodyVersion: 1, dataEncryptionKey: Buffer.from(`key-${index}`), seq: index,
            } });
        }
        await withAuthenticatedTestApp((app) => artifactsRoutes(app as any), async (app) => {
            const first = await app.inject({ method: "GET", url: "/v1/artifacts?limit=2", headers: { "x-test-user-id": account.id } });
            const rows = first.json();
            const cursor = Buffer.from(JSON.stringify({ updatedAt: rows[1].updatedAt, id: rows[1].id })).toString("base64url");
            const second = await app.inject({ method: "GET", url: `/v1/artifacts?limit=2&cursor=${cursor}`, headers: { "x-test-user-id": account.id } });
            expect(second.statusCode).toBe(200);
            expect(second.json()).toHaveLength(1);
            expect(new Set([...rows, ...second.json()].map((row) => row.id)).size).toBe(3);
        });
    });

    it("uses a bounded default when artifact listing omits limit", async () => {
        const account = await seedAccount();
        for (let index = 0; index < 550; index += 1) {
            await db.artifact.create({
                data: {
                    id: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
                    accountId: account.id,
                    header: Buffer.from(`head-${index}`),
                    headerVersion: 1,
                    body: Buffer.from(`body-${index}`),
                    bodyVersion: 1,
                    dataEncryptionKey: Buffer.from(`key-${index}`),
                    seq: index,
                },
            });
        }

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "GET",
                    url: "/v1/artifacts",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toHaveLength(500);
            },
        );
    });

    it("keeps either classified plugin archive out of generic Artifact list and direct-read surfaces", async () => {
        const account = await seedAccount();
        const documentArtifactId = "c1111111-1111-4111-8111-111111111111";
        const pluginUiArtifactId = "c2222222-2222-4222-8222-222222222222";
        const packageAssetArtifactId = "c3333333-3333-4333-8333-333333333333";
        const pluginId = "com.acme.fixture";

        await db.artifact.createMany({
            data: [
                {
                    id: documentArtifactId,
                    accountId: account.id,
                    header: Buffer.from("document-header"),
                    headerVersion: 1,
                    body: Buffer.from("document-body"),
                    bodyVersion: 1,
                    dataEncryptionKey: Buffer.from("document-key"),
                    seq: 0,
                },
                {
                    id: pluginUiArtifactId,
                    accountId: account.id,
                    header: Buffer.from("plugin-ui-header"),
                    headerVersion: 1,
                    body: Buffer.from("plugin-ui-body"),
                    bodyVersion: 1,
                    dataEncryptionKey: Buffer.from("plugin-ui-key"),
                    seq: 0,
                },
                {
                    id: packageAssetArtifactId,
                    accountId: account.id,
                    header: Buffer.from("plugin-package-header"),
                    headerVersion: 1,
                    body: Buffer.from("plugin-package-body"),
                    bodyVersion: 1,
                    dataEncryptionKey: Buffer.from("plugin-package-key"),
                    seq: 0,
                },
            ],
        });
        const release = await db.accountPluginRelease.create({
            data: {
                accountId: account.id,
                pluginId,
                version: "1.2.3",
                archiveDigestSha256: `sha256:${"a".repeat(64)}`,
                normalizedManifest: {},
                collectionContracts: [],
                uiSlots: [],
                // This row intentionally models a pre-package-asset release; the
                // nullable descriptor is retained for legacy classification tests.
                packageAssetArchive: null,
                packageAssetArtifactId,
            },
            select: { id: true },
        });
        await db.accountPluginUiArtifact.create({
            data: {
                releaseId: release.id,
                contributionId: "main",
                tier: "hostedWeb",
                platform: "web",
                artifactId: pluginUiArtifactId,
                artifactDigest: `sha256:${"b".repeat(64)}`,
                compatibility: {},
            },
        });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const listed = await app.inject({
                    method: "GET",
                    url: "/v1/artifacts",
                    headers: { "x-test-user-id": account.id },
                });
                expect(listed.statusCode).toBe(200);
                expect(listed.json().map((artifact: { id: string }) => artifact.id))
                    .toEqual([documentArtifactId]);

                const directRead = await app.inject({
                    method: "GET",
                    url: `/v1/artifacts/${pluginUiArtifactId}`,
                    headers: { "x-test-user-id": account.id },
                });
                expect(directRead.statusCode).toBe(404);
                expect(directRead.json()).toEqual({ error: "Artifact not found" });

                const packageDirectRead = await app.inject({
                    method: "GET",
                    url: `/v1/artifacts/${packageAssetArtifactId}`,
                    headers: { "x-test-user-id": account.id },
                });
                expect(packageDirectRead.statusCode).toBe(404);
                expect(packageDirectRead.json()).toEqual({ error: "Artifact not found" });
            },
        );
    });

    it("marks artifact create and emits new-artifact using returned cursor", async () => {
        const account = await seedAccount();
        const artifactId = "11111111-1111-4111-8111-111111111111";

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v1/artifacts",
                    headers: { "x-test-user-id": account.id, "content-type": "application/json" },
                    payload: {
                        id: artifactId,
                        header: Buffer.from("head").toString("base64"),
                        body: Buffer.from("body").toString("base64"),
                        dataEncryptionKey: Buffer.from("key").toString("base64"),
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual(
                    expect.objectContaining({
                        id: artifactId,
                        headerVersion: 1,
                        bodyVersion: 1,
                    }),
                );
            },
        );

        const stored = await db.artifact.findUnique({
            where: { id: artifactId },
            select: { accountId: true, headerVersion: true, bodyVersion: true },
        });
        expect(stored).toEqual({
            accountId: account.id,
            headerVersion: 1,
            bodyVersion: 1,
        });
        const cursor = await assertArtifactChange(account.id, artifactId);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    seq: cursor,
                    body: expect.objectContaining({ t: "new-artifact", artifactId }),
                }),
            }),
        );
    });

    it("rejects an encrypted Artifact for a plain account before mutation", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const artifactId = "66666666-6666-4666-8666-666666666666";

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v1/artifacts",
                    headers: { "x-test-user-id": account.id, "content-type": "application/json" },
                    payload: {
                        id: artifactId,
                        header: Buffer.from("encrypted-head").toString("base64"),
                        body: Buffer.from("encrypted-body").toString("base64"),
                        dataEncryptionKey: Buffer.from("encrypted-key").toString("base64"),
                    },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "Invalid parameters" });
            },
        );

        await expect(db.artifact.findUnique({ where: { id: artifactId } })).resolves.toBeNull();
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("seals a plain Artifact at rest while preserving the canonical wire representation", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "server_sealed";
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const artifactId = "77777777-7777-4777-8777-777777777777";
        const header = encodePlainArtifactStoredContent({ title: "plain" });
        const updatedHeader = encodePlainArtifactStoredContent({ title: "updated" });
        const body = encodePlainArtifactStoredContent({ body: "value" });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const created = await app.inject({
                    method: "POST",
                    url: "/v1/artifacts",
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                        ...currentStoredContentHeaders,
                    },
                    payload: {
                        id: artifactId,
                        header,
                        body,
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    },
                });
                expect(created.statusCode).toBe(200);
                expect(created.json()).toMatchObject({
                    id: artifactId,
                    header,
                    body,
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                });

                const updated = await app.inject({
                    method: "POST",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                        ...currentStoredContentHeaders,
                    },
                    payload: {
                        header: updatedHeader,
                        expectedHeaderVersion: 1,
                    },
                });
                expect(updated.statusCode).toBe(200);
                expect(updated.json()).toEqual({ success: true, headerVersion: 2 });

                const staleUpdate = await app.inject({
                    method: "POST",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                        ...currentStoredContentHeaders,
                    },
                    payload: {
                        header,
                        expectedHeaderVersion: 1,
                    },
                });
                expect(staleUpdate.statusCode).toBe(200);
                expect(staleUpdate.json()).toEqual({
                    success: false,
                    error: "version-mismatch",
                    currentHeaderVersion: 2,
                    currentHeader: updatedHeader,
                });

                const listed = await app.inject({
                    method: "GET",
                    url: "/v1/artifacts",
                    headers: {
                        "x-test-user-id": account.id,
                        ...currentStoredContentHeaders,
                    },
                });
                expect(listed.statusCode).toBe(200);
                expect(listed.json()).toEqual([
                    expect.objectContaining({
                        id: artifactId,
                        header: updatedHeader,
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    }),
                ]);

                const listedWithBody = await app.inject({ method: 'GET', url: '/v1/artifacts?includeBody=true',
                    headers: { 'x-test-user-id': account.id } });
                expect(listedWithBody.statusCode).toBe(200);
                expect(listedWithBody.json()[0]).toMatchObject({ id: artifactId, header: updatedHeader, body, bodyVersion: 1 });

                const read = await app.inject({
                    method: "GET",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: {
                        "x-test-user-id": account.id,
                        ...currentStoredContentHeaders,
                    },
                });
                expect(read.statusCode).toBe(200);
                expect(read.json()).toMatchObject({
                    id: artifactId,
                    header: updatedHeader,
                    body,
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                });
            },
        );

        const stored = await db.artifact.findUniqueOrThrow({
            where: { id: artifactId },
            select: { header: true, body: true },
        });
        const storedHeader = new TextDecoder().decode(stored.header);
        const storedBody = new TextDecoder().decode(stored.body);
        expect(storedHeader).not.toBe(new TextDecoder().decode(Buffer.from(updatedHeader, "base64")));
        expect(storedBody).not.toBe(new TextDecoder().decode(Buffer.from(body, "base64")));
        expect(JSON.parse(storedHeader)).toMatchObject({ t: "sealed_v1", c: expect.any(String) });
        expect(JSON.parse(storedBody)).toMatchObject({ t: "sealed_v1", c: expect.any(String) });
    });

    it("honors direct-plain Artifact storage policy without changing the wire envelope", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const artifactId = "88888888-8888-4888-8888-888888888888";
        const header = encodePlainArtifactStoredContent({ title: "direct" });
        const body = encodePlainArtifactStoredContent({ body: "direct" });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const created = await app.inject({
                    method: "POST",
                    url: "/v1/artifacts",
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                        ...currentStoredContentHeaders,
                    },
                    payload: {
                        id: artifactId,
                        header,
                        body,
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    },
                });
                expect(created.statusCode).toBe(200);
                expect(created.json()).toMatchObject({ header, body });
            },
        );

        const stored = await db.artifact.findUniqueOrThrow({
            where: { id: artifactId },
            select: { header: true, body: true },
        });
        expect(Buffer.from(stored.header).toString("base64")).toBe(header);
        expect(Buffer.from(stored.body).toString("base64")).toBe(body);
    });

    it("fails closed instead of exposing malformed sealed plain Artifact bytes", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const artifactId = "99999999-9999-4999-8999-999999999999";
        await db.artifact.create({
            data: {
                id: artifactId,
                accountId: account.id,
                header: Buffer.from(JSON.stringify({ t: "sealed_v1", c: "not-valid-ciphertext" })),
                headerVersion: 1,
                body: Buffer.from(encodePlainArtifactStoredContent({ body: "legacy" }), "base64"),
                bodyVersion: 1,
                dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"),
                seq: 0,
            },
        });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const read = await app.inject({
                    method: "GET",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: {
                        "x-test-user-id": account.id,
                        ...currentStoredContentHeaders,
                    },
                });
                expect(read.statusCode).toBe(500);
                expect(read.json()).toEqual({ error: "Failed to get artifact" });
            },
        );
    });

    it("fails closed when persisted plain Artifact content disagrees with the Account mode", async () => {
        const account = await seedAccount();
        const artifactId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const header = encodePlainArtifactStoredContent({ title: "must-not-leak" });
        const body = encodePlainArtifactStoredContent({ body: "must-not-leak" });
        await db.artifact.create({
            data: {
                id: artifactId,
                accountId: account.id,
                header: Buffer.from(header, "base64"),
                headerVersion: 1,
                body: Buffer.from(body, "base64"),
                bodyVersion: 1,
                dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"),
                seq: 0,
            },
        });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const read = await app.inject({
                    method: "GET",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: {
                        "x-test-user-id": account.id,
                        ...currentStoredContentHeaders,
                    },
                });

                expect(read.statusCode).toBe(500);
                expect(read.json()).toEqual({ error: "Failed to get artifact" });
                expect(read.body).not.toContain(header);
                expect(read.body).not.toContain(body);
                expect(read.body).not.toContain("must-not-leak");
                const list = await app.inject({ method: 'GET', url: '/v1/artifacts?includeBody=true',
                    headers: { 'x-test-user-id': account.id } });
                expect(list.statusCode).toBe(500);
                expect(list.body).not.toContain('must-not-leak');
            },
        );
    });

    it("serves the current plain Artifact lifecycle without a component-version declaration", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        const account = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const header = encodePlainArtifactStoredContent({ title: "plain" });
        const body = encodePlainArtifactStoredContent({ body: "value" });
        const headers = { "x-test-user-id": account.id };
        const payload = { id, header, body, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            for (let invocation = 0; invocation < 2; invocation += 1) {
                const created = await app.inject({ method: "POST", url: "/v1/artifacts", headers, payload });
                expect(created.statusCode).toBe(200);
                expect(created.json()).toMatchObject({ id, header, body, ownerAccountId: account.id,
                    access: "owner", encryptionMode: "plain" });
            }
            const list = await app.inject({ method: "GET", url: "/v1/artifacts", headers });
            expect(list.statusCode).toBe(200);
            expect(list.json()).toEqual([expect.objectContaining({ id, header, encryptionMode: "plain" })]);
            const detail = await app.inject({ method: "GET", url: "/v1/artifacts/" + id, headers });
            expect(detail.statusCode).toBe(200);
            expect(detail.json()).toMatchObject({ id, header, body });
            const stale = await app.inject({ method: "POST", url: "/v1/artifacts/" + id, headers,
                payload: { header, expectedHeaderVersion: 0 } });
            expect(stale.statusCode).toBe(200);
            expect(stale.json()).toMatchObject({ success: false, error: "version-mismatch", currentHeaderVersion: 1 });
            const updated = await app.inject({ method: "POST", url: "/v1/artifacts/" + id, headers,
                payload: { header, expectedHeaderVersion: 1 } });
            expect(updated.statusCode).toBe(200);
            const deleted = await app.inject({ method: "DELETE", url: "/v1/artifacts/" + id + "/revision/2/1", headers });
            expect(deleted.statusCode).toBe(200);
        });
        expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
    });

    it("marks artifact update and emits update-artifact using returned cursor", async () => {
        const account = await seedAccount();
        const artifactId = "22222222-2222-4222-8222-222222222222";
        await db.artifact.create({
            data: {
                id: artifactId,
                accountId: account.id,
                header: Buffer.from("head-old"),
                headerVersion: 1,
                body: Buffer.from("body-old"),
                bodyVersion: 1,
                dataEncryptionKey: Buffer.from("key"),
                seq: 7,
            },
        });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: { "x-test-user-id": account.id, "content-type": "application/json" },
                    payload: {
                        header: Buffer.from("head-new").toString("base64"),
                        expectedHeaderVersion: 1,
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ success: true, headerVersion: 2 });
            },
        );

        const stored = await db.artifact.findUnique({
            where: { id: artifactId },
            select: { header: true, headerVersion: true, seq: true },
        });
        expect(stored?.headerVersion).toBe(2);
        expect(stored?.seq).toBe(8);
        expect(stored?.header).toEqual(Uint8Array.from(Buffer.from("head-new")));
        const cursor = await assertArtifactChange(account.id, artifactId);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    seq: cursor,
                    body: expect.objectContaining({ t: "update-artifact", artifactId,
                        header: { value: Buffer.from("head-new").toString("base64"), version: 2 } }),
                }),
            }),
        );
    });

    it("atomically refuses stale deletion revisions and deletes at the matching revision", async () => {
        const account = await seedAccount();
        const id = "77777777-7777-4777-8777-777777777777";
        await db.artifact.create({ data: { id, accountId: account.id, header: Buffer.from("header"), headerVersion: 2,
            body: Buffer.from("body"), bodyVersion: 4, dataEncryptionKey: Buffer.from("key"), seq: 1 } });
        const beforeCursor = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
        await withAuthenticatedTestApp((app) => artifactsRoutes(app as any), async (app) => {
            const stale = await app.inject({ method: "DELETE", url: `/v1/artifacts/${id}/revision/2/3`,
                headers: { "x-test-user-id": account.id } });
            expect(stale.statusCode).toBe(409);
            expect(await db.artifact.findUnique({ where: { id } })).not.toBeNull();
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(beforeCursor);
            expect(emitUpdate).not.toHaveBeenCalled();
            const deleted = await app.inject({ method: "DELETE", url: `/v1/artifacts/${id}/revision/2/4`,
                headers: { "x-test-user-id": account.id } });
            expect(deleted.statusCode).toBe(200);
            expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
            const cursor = await assertArtifactChange(account.id, id, true);
            expect(cursor).toBe(beforeCursor.seq + 1);
        });
    });

    it("marks artifact delete and emits delete-artifact using returned cursor", async () => {
        const account = await seedAccount();
        const artifactId = "33333333-3333-4333-8333-333333333333";
        await db.artifact.create({
            data: {
                id: artifactId,
                accountId: account.id,
                header: Buffer.from("head"),
                headerVersion: 1,
                body: Buffer.from("body"),
                bodyVersion: 1,
                dataEncryptionKey: Buffer.from("key"),
                seq: 3,
            },
        });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "DELETE",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ success: true });
            },
        );

        const stored = await db.artifact.findUnique({
            where: { id: artifactId },
            select: { id: true },
        });
        expect(stored).toBeNull();
        const cursor = await assertArtifactChange(account.id, artifactId, true);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    seq: cursor,
                    body: { t: "delete-artifact", artifactId },
                }),
            }),
        );
    });

    it("preserves a plaintext-marked Artifact when HTTP delete finds an E2EE Account", async () => {
        const account = await seedAccount();
        const artifactId = "99999999-9999-4999-8999-999999999999";
        await db.artifact.create({
            data: {
                id: artifactId,
                accountId: account.id,
                header: Buffer.from(
                    encodePlainArtifactStoredContent({ title: "plain" }),
                    "base64",
                ),
                headerVersion: 1,
                body: Buffer.from(
                    encodePlainArtifactStoredContent({ body: "plain" }),
                    "base64",
                ),
                bodyVersion: 1,
                dataEncryptionKey: Buffer.from(
                    ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    "base64",
                ),
                seq: 3,
            },
        });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "DELETE",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: {
                        "x-test-user-id": account.id,
                        ...currentStoredContentHeaders,
                    },
                });
                expect(response.statusCode).toBe(500);
                expect(response.json()).toEqual({
                    error: "Failed to delete artifact",
                });
            },
        );

        await expect(db.artifact.findUnique({ where: { id: artifactId } }))
            .resolves.toMatchObject({ id: artifactId });
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

});
