import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "crypto";
import type { FastifyRequest } from "fastify";
import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { publicShareRoutes } from "./publicShareRoutes";

const OWNER_METADATA_CIPHERTEXT_V1 =
    "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==";
const STORED_OWNER_METADATA_ENVELOPE_V1 = JSON.stringify({
    t: "encrypted",
    c: OWNER_METADATA_CIPHERTEXT_V1,
});
const STORED_SHARED_METADATA_V1 = JSON.stringify({ v: 1 });
const CURRENT_ACCOUNT_STORED_CONTENT_HEADERS =
    buildAccountStoredContentCompatibilityHttpHeadersV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    );

function createCurrentClientTestApp() {
    const app = createAuthenticatedTestApp();
    app.addHook("onRequest", async (request: FastifyRequest) => {
        Object.assign(
            request.headers,
            CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
        );
    });
    return app;
}

async function createCurrentE2eeAccount() {
    return db.account.create({
        data: {
            ...createSignedAccountContentBinding(),
            encryptionMode: "e2ee",
        },
        select: { id: true },
    });
}

describe("publicShareRoutes plaintext sessions (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-public-share-plain-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    it("publishes a layout-one Agent-state tombstone without owner ciphertext", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_layout_one_public_recipient",
                encryptionMode: "plain",
                metadata: STORED_SHARED_METADATA_V1,
                metadataVersion: 4,
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                agentState: "owner-private-agent-state",
                agentStateVersion: 9,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        const token = "tok_layout_one_public_recipient";
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().session).toMatchObject({
                id: session.id,
                metadata: STORED_SHARED_METADATA_V1,
                metadataVersion: 4,
                metadataLayoutVersion: 1,
                agentState: null,
                agentStateVersion: 9,
            });
            expect(response.json().session).not.toHaveProperty(
                "ownerMetadata",
            );
            expect(response.body).not.toContain(
                "owner-private-agent-state",
            );
            expect(response.body).not.toContain(
                OWNER_METADATA_CIPHERTEXT_V1,
            );
        } finally {
            await app.close();
        }
    });

    it("projects finite public-share activity through the snapshot publication boundary", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `s_public_share_finite_activity_${crypto.randomUUID()}`,
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: STORED_SHARED_METADATA_V1,
                agentState: null,
                dataEncryptionKey: null,
                seq: 9,
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 4,
                materializationPublicationId: "public-share-activity-publication-v1",
                materializedThroughSourceAt: 42_000n,
                publishedThroughServerSeq: 4,
                createdAt: new Date(10_000),
                updatedAt: new Date(100_000),
                active: true,
                lastActiveAt: new Date(110_000),
            },
            select: { id: true },
        });
        const token = `tok_public_share_finite_activity_${crypto.randomUUID()}`;
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().session).toMatchObject({
                id: session.id,
                seq: 4,
                updatedAt: 42_000,
                active: false,
                activeAt: 42_000,
            });
        } finally {
            await app.close();
        }
    });

    it.each([
        {
            name: "malformed JSON",
            metadata: "owner-private-path=/Users/alice/secret-project",
            sentinel: "/Users/alice/secret-project",
        },
        {
            name: "strict-unknown owner fields",
            metadata: JSON.stringify({
                v: 1,
                path: "/Users/alice/secret-project",
                machineId: "owner-private-machine",
                operationClaimId: "owner-private-claim",
            }),
            sentinel: "owner-private-claim",
        },
    ])("fails public disclosure closed for $name plaintext layout-one metadata", async ({
        metadata,
        sentinel,
    }) => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `s_invalid_plain_shared_${sentinel.length}`,
                encryptionMode: "plain",
                metadata,
                metadataVersion: 4,
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                agentState: "owner-private-agent-state",
                agentStateVersion: 9,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        const token = `tok_invalid_plain_shared_${sentinel.length}`;
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });

            expect(response.statusCode, response.body).toBe(409);
            expect(response.json()).toMatchObject({
                code: "metadata_privacy_upgrade_required",
            });
            expect(response.body).not.toContain(sentinel);
            expect(response.body).not.toContain("owner-private-agent-state");
        } finally {
            await app.close();
        }
    });

    it("creates and accesses a public share for a plaintext session without encryptedDataKey", async () => {
        const owner = await createCurrentE2eeAccount();
        const externalSessionOperationPresentationV1 = {
            v: 1,
            operationId: "operation-public-safe-1",
            revision: 4,
            kind: "materialize",
            status: "running",
            phase: "validating",
        };
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain",
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: JSON.stringify({
                    v: 1,
                    externalSessionOperationPresentationV1,
                }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const token = "tok_plain_1";
            const createRes = await app.inject({
                method: "POST",
                url: `/v1/sessions/${session.id}/public-share`,
                headers: { "x-test-user-id": owner.id, "content-type": "application/json" },
                payload: JSON.stringify({ token, isConsentRequired: false }),
            });
            expect(createRes.statusCode).toBe(200);

            const accessRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            expect(accessRes.statusCode).toBe(200);
            const json = accessRes.json();
            expect(json.session?.id).toBe(session.id);
            expect(json.session?.encryptionMode).toBe("plain");
            const publicMetadata = JSON.parse(json.session?.metadata);
            expect(publicMetadata.externalSessionOperationPresentationV1).toEqual(
                externalSessionOperationPresentationV1,
            );
            expect(publicMetadata).not.toHaveProperty("externalSessionOperationV1");
            const serializedPublicMetadata = JSON.stringify(publicMetadata);
            expect(serializedPublicMetadata).toContain("operation-public-safe-1");
            expect(serializedPublicMetadata).not.toContain("operationClaimId");
            expect(serializedPublicMetadata).not.toContain("canonicalOwnerEvidence");
            expect(serializedPublicMetadata).not.toContain("privateStagingId");
            expect(json.encryptedDataKey).toBe(null);
        } finally {
            await app.close();
        }
    });

    it.each(["machine_only", "server_partial", "legacy_external_unknown"] as const)(
        "rejects public-share creation and reads while transcript storage is %s",
        async (currentStorageState) => {
            const owner = await createCurrentE2eeAccount();
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `s_${currentStorageState}`,
                    encryptionMode: "plain",
                    metadataLayoutVersion: 1,
                    ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                    metadata: STORED_SHARED_METADATA_V1,
                    agentState: null,
                    dataEncryptionKey: null,
                    currentStorageState,
                    acceptedThroughServerSeq: currentStorageState === "server_partial" ? 0 : null,
                },
                select: { id: true },
            });
            const token = `tok_${currentStorageState}`;
            const tokenHash = createHash("sha256").update(token, "utf8").digest();

            const app = createCurrentClientTestApp();
            publicShareRoutes(app as any);
            await app.ready();
            try {
                const createRes = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: { "x-test-user-id": owner.id, "content-type": "application/json" },
                    payload: JSON.stringify({ token, isConsentRequired: false }),
                });
                expect(createRes.statusCode).toBe(409);
                expect(createRes.json()).toMatchObject({ code: "session_transcript_not_shareable" });

                await db.publicSessionShare.create({
                    data: {
                        sessionId: session.id,
                        createdByUserId: owner.id,
                        tokenHash,
                        encryptedDataKey: null,
                        isConsentRequired: true,
                    },
                });
                const accessRes = await app.inject({
                    method: "GET",
                    url: `/v1/public-share/${encodeURIComponent(token)}`,
                });
                expect(accessRes.statusCode).toBe(404);
                expect(accessRes.json()).toMatchObject({ code: "session_transcript_unavailable" });
            } finally {
                await app.close();
            }
        },
    );

    it("returns 404 for message reads when an E2EE session public share is missing encryptedDataKey", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_e2ee",
                encryptionMode: "e2ee",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: "ciphertext",
                agentState: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
            },
            select: { id: true },
        });

        const token = "tok_e2ee_missing_dek";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const messagesRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });
            expect(messagesRes.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it("returns 404 for root reads without consuming maxUses when an E2EE public share is missing encryptedDataKey", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_e2ee_missing_key_root",
                encryptionMode: "e2ee",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: "ciphertext",
                agentState: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
            },
            select: { id: true },
        });

        const token = "tok_e2ee_missing_dek_root";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const accessRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            expect(accessRes.statusCode).toBe(404);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("returns 404 for root reads without consuming maxUses when an E2EE public share has a malformed encryptedDataKey", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_e2ee_malformed_key_root",
                encryptionMode: "e2ee",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: "ciphertext",
                agentState: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
            },
            select: { id: true },
        });

        const token = "tok_e2ee_malformed_dek_root";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: Buffer.from([1, 2, 3]),
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const accessRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            expect(accessRes.statusCode).toBe(404);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("returns 404 for message reads without consuming maxUses when an E2EE public share has a malformed encryptedDataKey", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_e2ee_malformed_key_messages",
                encryptionMode: "e2ee",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: "ciphertext",
                agentState: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                content: { t: "encrypted", c: "ciphertext" },
            },
        });

        const token = "tok_e2ee_malformed_dek_messages";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: Buffer.from([1, 2, 3]),
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const messagesRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });
            expect(messagesRes.statusCode).toBe(404);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("counts a plaintext public share viewer open only once across metadata and messages reads", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_viewer_open_max_uses",
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: STORED_SHARED_METADATA_V1,
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
            },
        });

        const token = "tok_plain_viewer_open_max_uses";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const metadata = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            const metadataBody = metadata.json();
            const messages = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
                headers: { "x-public-share-messages-access-token": metadataBody.messagesAccessToken },
            });

            expect(metadata.statusCode).toBe(200);
            expect(metadataBody.messagesAccessToken).toEqual(expect.any(String));
            expect(messages.statusCode).toBe(200);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 1 });
    });

    it("rejects capped plaintext public share message reads without a metadata access grant", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_message_max_uses",
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: STORED_SHARED_METADATA_V1,
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
            },
        });

        const token = "tok_plain_messages_max_uses";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const first = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });
            const second = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });

            expect(first.statusCode).toBe(404);
            expect(second.statusCode).toBe(404);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("rolls back the final capped use when transactional access logging fails", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_log_rollback",
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: STORED_SHARED_METADATA_V1,
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        const token = "tok_plain_log_rollback";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });
        await db.$executeRawUnsafe(`
            CREATE TRIGGER "force_public_share_access_log_failure"
            BEFORE INSERT ON "PublicShareAccessLog"
            BEGIN
                SELECT RAISE(ABORT, 'forced public share access-log failure');
            END
        `);

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const metadata = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            expect(metadata.statusCode).toBe(500);
        } finally {
            await app.close();
            await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "force_public_share_access_log_failure"');
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("allows only one concurrent root read for a maxUses=1 plaintext public share", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_root_max_uses",
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: STORED_SHARED_METADATA_V1,
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });

        const token = "tok_plain_root_max_uses";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const results = await Promise.all([
                app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` }),
                app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` }),
            ]);

            expect(results.map((result) => result.statusCode).sort()).toEqual([200, 404]);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 1 });
    });

    it("returns messageRole metadata for public share message reads", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_message_role",
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: STORED_SHARED_METADATA_V1,
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                messageRole: "event",
                content: {
                    t: "plain",
                    v: {
                        role: "agent",
                        content: {
                            type: "output",
                            data: {
                                type: "assistant",
                                uuid: "event-uuid",
                                message: {
                                    role: "assistant",
                                    content: [{ type: "text", text: "Transport status" }],
                                },
                            },
                        },
                    },
                },
            },
        });

        const token = "tok_plain_message_role";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const root = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            const messagesRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });

            expect(root.statusCode).toBe(200);
            expect(messagesRes.statusCode).toBe(200);
            expect(messagesRes.json().messages).toEqual([
                expect.objectContaining({
                    seq: 1,
                    messageRole: "event",
                }),
            ]);
        } finally {
            await app.close();
        }
    });

    it("returns the newest public share messages by transcript seq instead of createdAt", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_message_seq_order",
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: STORED_SHARED_METADATA_V1,
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        const now = new Date("2026-06-18T10:00:00.000Z");
        await db.sessionMessage.createMany({
            data: [
                {
                    sessionId: session.id,
                    seq: 1,
                    content: { t: "plain", v: { role: "user", content: { type: "text", text: "old transcript" } } },
                    createdAt: new Date(now.getTime() + 1_000),
                    updatedAt: new Date(now.getTime() + 1_000),
                },
                {
                    sessionId: session.id,
                    seq: 2,
                    content: { t: "plain", v: { role: "user", content: { type: "text", text: "new transcript" } } },
                    createdAt: now,
                    updatedAt: now,
                },
            ],
        });

        const token = "tok_plain_message_seq_order";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const root = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            const messagesRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });

            expect(root.statusCode).toBe(200);
            expect(messagesRes.statusCode).toBe(200);
            expect(messagesRes.json().messages.map((message: { seq: number }) => message.seq)).toEqual([2, 1]);
        } finally {
            await app.close();
        }
    });

    it("treats literal false consent as false and supports the exact released unlimited-share viewer request", async () => {
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_strict_consent",
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: STORED_SHARED_METADATA_V1,
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "main" } } },
            },
        });
        const token = "tok_plain_strict_consent";
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: true,
            },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const deniedRoot = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}?consent=false`,
            });
            const deniedMessages = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages?consent=0`,
            });
            expect(deniedRoot.statusCode).toBe(403);
            expect(deniedMessages.statusCode).toBe(403);

            const root = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}?consent=true`,
            });
            const grant = root.json().messagesAccessToken;
            const direct = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages?consent=true`,
            });
            expect(root.statusCode).toBe(200);
            expect(grant).toBeUndefined();
            // Exact cli-v0.2.1 viewer request shape at
            // b1d15a8a9c241737d1ca9b167459901e6259173a: no messages grant header.
            expect(direct.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });

    it.each(["plain", "e2ee"] as const)(
        "returns only canonical main rows for a %s public transcript",
        async (encryptionMode) => {
            const owner = await createCurrentE2eeAccount();
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `s_main_scope_${encryptionMode}`,
                    encryptionMode,
                    metadataLayoutVersion: 1,
                    ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                    metadata: encryptionMode === "plain"
                        ? STORED_SHARED_METADATA_V1
                        : "ciphertext",
                    agentState: null,
                    dataEncryptionKey: encryptionMode === "plain" ? null : Buffer.from([1, 2, 3]),
                },
                select: { id: true },
            });
            await db.sessionMessage.createMany({
                data: [
                    {
                        sessionId: session.id,
                        seq: 1,
                        sidechainId: null,
                        content: encryptionMode === "plain"
                            ? { t: "plain", v: { role: "user", content: { type: "text", text: "main" } } }
                            : { t: "encrypted", c: "main-ciphertext" },
                    },
                    {
                        sessionId: session.id,
                        seq: 2,
                        sidechainId: "sidechain-1",
                        content: encryptionMode === "plain"
                            ? { t: "plain", v: { role: "agent", content: { type: "text", text: "sidechain" } } }
                            : { t: "encrypted", c: "sidechain-ciphertext" },
                    },
                ],
            });
            const token = `tok_main_scope_${encryptionMode}`;
            await db.publicSessionShare.create({
                data: {
                    sessionId: session.id,
                    createdByUserId: owner.id,
                    tokenHash: createHash("sha256").update(token, "utf8").digest(),
                    encryptedDataKey: encryptionMode === "plain"
                        ? null
                        : Buffer.alloc(PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES, 1),
                    isConsentRequired: false,
                },
            });

        const app = createCurrentClientTestApp();
            publicShareRoutes(app as any);
            await app.ready();
            try {
                const root = await app.inject({
                    method: "GET",
                    url: `/v1/public-share/${encodeURIComponent(token)}`,
                });
                const messages = await app.inject({
                    method: "GET",
                    url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
                });
                expect(root.statusCode).toBe(200);
                expect(messages.statusCode).toBe(200);
                expect(messages.json().messages).toEqual([
                    expect.objectContaining({ seq: 1 }),
                ]);
            } finally {
                await app.close();
            }
        },
    );
});
