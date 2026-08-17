import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import {
    ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    encodePlainArtifactStoredContent,
} from "@happier-dev/protocol";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { artifactsRoutes } from "./artifactsRoutes";

const { emitUpdate, buildNewArtifactUpdate, buildUpdateArtifactUpdate, buildDeleteArtifactUpdate, randomKeyNaked, markAccountChanged } =
    vi.hoisted(() => ({
        emitUpdate: vi.fn(),
        buildNewArtifactUpdate: vi.fn((_artifact: any, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "new-artifact" },
        })),
        buildUpdateArtifactUpdate: vi.fn((_artifactId: string, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "update-artifact" },
        })),
        buildDeleteArtifactUpdate: vi.fn((_artifactId: string, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "delete-artifact" },
        })),
        randomKeyNaked: vi.fn(() => "upd-id"),
        markAccountChanged: vi.fn(async () => 700),
    }));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewArtifactUpdate,
    buildUpdateArtifactUpdate,
    buildDeleteArtifactUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
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
            },
        );
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
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: account.id, kind: "artifact", entityId: artifactId }),
        );
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    seq: 700,
                    body: expect.objectContaining({ t: "new-artifact" }),
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
        expect(markAccountChanged).not.toHaveBeenCalled();
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

    it("requires the current declaration for marked create/list/detail/idempotent return and stale-current exposure", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const header = encodePlainArtifactStoredContent({ title: "plain" });
        const body = encodePlainArtifactStoredContent({ body: "value" });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const legacyCreate = await app.inject({
                    method: "POST",
                    url: "/v1/artifacts",
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                    },
                    payload: {
                        id: artifactId,
                        header,
                        body,
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    },
                });
                expect(legacyCreate.statusCode).toBe(426);
                expect(legacyCreate.json()).toEqual({
                    error: "client-upgrade-required",
                    requirement: {
                        v: 1,
                        kind: "account-stored-content",
                        minimumProtocolVersion:
                            ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
                    },
                });
                await expect(
                    db.artifact.findUnique({ where: { id: artifactId } }),
                ).resolves.toBeNull();

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

                const legacyList = await app.inject({
                    method: "GET",
                    url: "/v1/artifacts",
                    headers: { "x-test-user-id": account.id },
                });
                expect(legacyList.statusCode).toBe(426);

                const legacyDetail = await app.inject({
                    method: "GET",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: { "x-test-user-id": account.id },
                });
                expect(legacyDetail.statusCode).toBe(426);

                const legacyIdempotentCreate = await app.inject({
                    method: "POST",
                    url: "/v1/artifacts",
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                    },
                    payload: {
                        id: artifactId,
                        header,
                        body,
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    },
                });
                expect(legacyIdempotentCreate.statusCode).toBe(426);

                const legacyStaleUpdate = await app.inject({
                    method: "POST",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                    },
                    payload: {
                        header,
                        expectedHeaderVersion: 0,
                    },
                });
                expect(legacyStaleUpdate.statusCode).toBe(426);
                expect(JSON.stringify(legacyStaleUpdate.json())).not.toContain(header);
            },
        );

        const stored = await db.artifact.findUniqueOrThrow({
            where: { id: artifactId },
            select: {
                headerVersion: true,
                bodyVersion: true,
                seq: true,
            },
        });
        expect(stored).toEqual({
            headerVersion: 1,
            bodyVersion: 1,
            seq: 0,
        });
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
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: account.id, kind: "artifact", entityId: artifactId }),
        );
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    seq: 700,
                    body: expect.objectContaining({ t: "update-artifact" }),
                }),
            }),
        );
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
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: account.id, kind: "artifact", entityId: artifactId }),
        );
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    seq: 700,
                    body: expect.objectContaining({ t: "delete-artifact" }),
                }),
            }),
        );
    });

    it("requires current stored-content support before deleting a marked row", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const artifactId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        await db.artifact.create({
            data: {
                id: artifactId,
                accountId: account.id,
                header: Buffer.from(
                    encodePlainArtifactStoredContent({ title: "plain" }),
                    "base64",
                ),
                headerVersion: 4,
                body: Buffer.from(
                    encodePlainArtifactStoredContent({ body: "value" }),
                    "base64",
                ),
                bodyVersion: 7,
                dataEncryptionKey: Buffer.from(
                    ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    "base64",
                ),
                seq: 9,
            },
        });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const legacyDelete = await app.inject({
                    method: "DELETE",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: { "x-test-user-id": account.id },
                });
                expect(legacyDelete.statusCode).toBe(426);
                expect(legacyDelete.json()).toEqual({
                    error: "client-upgrade-required",
                    requirement: {
                        v: 1,
                        kind: "account-stored-content",
                        minimumProtocolVersion:
                            ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
                    },
                });
                await expect(
                    db.artifact.findUnique({ where: { id: artifactId } }),
                ).resolves.toMatchObject({ id: artifactId });
                expect(markAccountChanged).not.toHaveBeenCalled();
                expect(emitUpdate).not.toHaveBeenCalled();

                const currentDelete = await app.inject({
                    method: "DELETE",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: {
                        "x-test-user-id": account.id,
                        ...currentStoredContentHeaders,
                    },
                });
                expect(currentDelete.statusCode).toBe(200);
                expect(currentDelete.json()).toEqual({ success: true });
            },
        );

        await expect(
            db.artifact.findUnique({ where: { id: artifactId } }),
        ).resolves.toBeNull();
        expect(markAccountChanged).toHaveBeenCalledOnce();
        expect(emitUpdate).toHaveBeenCalledOnce();
    });
});
