import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "crypto";
import type { FastifyRequest } from "fastify";
import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    projectSessionDisplayV1,
    sealSessionOwnerDisplayEnvelopeV1,
    sealSessionOwnerMetadataEnvelopeV1,
    sealSessionSharedDisplayEnvelopeV1Sync,
    SessionDisplayProjectionV1Schema,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { publicShareRoutes } from "./publicShareRoutes";
import { resolveApiTrustProxy } from "../../utils/apiRateLimitPolicy";

const OWNER_METADATA_CIPHERTEXT_V1 =
    "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==";
const STORED_OWNER_METADATA_ENVELOPE_V1 = JSON.stringify({
    t: "encrypted",
    c: OWNER_METADATA_CIPHERTEXT_V1,
});
const STORED_SHARED_METADATA_V1 = JSON.stringify({ v: 1 });
const CURRENT_ACCOUNT_STORED_CONTENT_HEADERS =
    buildAccountStoredContentCompatibilityHttpHeadersV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    );

function createCurrentClientTestApp(options: Parameters<typeof createAuthenticatedTestApp>[0] = {}) {
    const app = createAuthenticatedTestApp(options);
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
            env: {
                HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.example.test',
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: '1',
            },
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    it("logs public-share client IPs through the configured proxy trust policy and preserves consent", async () => {
        const owner = await createCurrentE2eeAccount();
        await db.account.update({ where: { id: owner.id }, data: { supporterRing: true } });
        await db.supporterRecord.create({ data: { accountId: owner.id, code: "public-share-supporter", number: 927,
            grantedAt: new Date("2024-06-02T00:00:00Z") } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: "s_proxy_log", encryptionMode: "plain", metadata: STORED_SHARED_METADATA_V1, metadataLayoutVersion: 1, ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1 },
            select: { id: true },
        });
        const token = "tok_proxy_log";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                isConsentRequired: true,
            },
            select: { id: true },
        });
        const app = createCurrentClientTestApp({
            trustProxy: resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "10.0.0.0/8" }),
        });
        publicShareRoutes(app);
        await app.ready();
        try {
            const withoutConsent = await app.inject({ method: "GET", url: `/v1/public-share/${token}` });
            expect(withoutConsent.statusCode).toBe(403);
            await expect(db.publicShareAccessLog.count({ where: { publicShareId: share.id } })).resolves.toBe(0);

            for (const scenario of [
                { userAgent: "direct", remoteAddress: "203.0.113.9", forwarded: "198.51.100.7", expected: "203.0.113.9" },
                { userAgent: "proxy", remoteAddress: "10.1.2.3", forwarded: "198.51.100.7", expected: "198.51.100.7" },
                { userAgent: "chain", remoteAddress: "10.1.2.3", forwarded: "198.51.100.7, 203.0.113.9", expected: "203.0.113.9" },
                { userAgent: "real-ip-only", remoteAddress: "10.1.2.3", forwarded: undefined, expected: "10.1.2.3" },
            ]) {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/public-share/${token}?consent=true`,
                    remoteAddress: scenario.remoteAddress,
                    headers: {
                        "user-agent": scenario.userAgent,
                        "x-real-ip": "192.0.2.1",
                        ...(scenario.forwarded ? { "x-forwarded-for": scenario.forwarded } : {}),
                    },
                });
                expect(response.statusCode).toBe(200);
                await expect(db.publicShareAccessLog.findFirst({
                    where: { publicShareId: share.id, userAgent: scenario.userAgent },
                    select: { ipAddress: true },
                })).resolves.toEqual({ ipAddress: scenario.expected });
            }

            await db.publicSessionShare.update({ where: { id: share.id }, data: { isConsentRequired: false } });
            const anonymous = await app.inject({
                method: "GET",
                url: `/v1/public-share/${token}`,
                remoteAddress: "203.0.113.9",
                headers: { "user-agent": "no-consent-recording", "x-forwarded-for": "198.51.100.7" },
            });
            expect(anonymous.statusCode).toBe(200);
            expect(anonymous.json().owner).toMatchObject({ id: owner.id });
            expect(anonymous.json().owner).not.toHaveProperty("supporter");
            expect(anonymous.json().owner).not.toHaveProperty("badges");
            await expect(db.publicShareAccessLog.count({
                where: { publicShareId: share.id, ipAddress: null, userAgent: null },
            })).resolves.toBe(1);
        } finally {
            await app.close();
        }
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

    it("keeps public display shared-only with the owner credential and preserves full content when display purpose is invalid", async () => {
        const owner = await createCurrentE2eeAccount();
        const sessionId = crypto.randomUUID();
        const material = { type: "dataKey" as const, machineKey: new Uint8Array(32).fill(7) };
        const randomBytes = (length: number) => new Uint8Array(length).fill(4);
        const sharedMetadata = { v: 1 as const, summary: { text: "Public display summary", updatedAt: 1 } };
        const ownerMetadata = { v: 1 as const, workspace: {
            name: "owner-private-display-name", path: "/owner/private/display-path", machineId: "owner-private-machine",
        } };
        const semantic = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
        if (!semantic.owner) throw new Error("Expected owner display fixture");
        const sharedDisplay = sealSessionSharedDisplayEnvelopeV1Sync({
            sessionMode: "plain", display: semantic.shared,
        });
        const ownerDisplay = sealSessionOwnerDisplayEnvelopeV1({
            accountMode: "e2ee", display: semantic.owner, material, randomBytes,
        });
        if (!sharedDisplay.ok || sharedDisplay.envelope.t !== "plain" || !ownerDisplay.ok || ownerDisplay.envelope.t !== "encrypted") {
            throw new Error("Expected mode-correct public display fixture");
        }
        const displayProjectionV1 = SessionDisplayProjectionV1Schema.parse({
            v: 1, metadataLayoutVersion: 1, sourceMetadataVersion: 0,
            shared: sharedDisplay.envelope, owner: ownerDisplay.envelope,
        });
        await db.session.create({ data: {
            id: sessionId, accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain",
            metadata: JSON.stringify(sharedMetadata), metadataVersion: 0, metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify(sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata, material, randomBytes })),
            agentState: "owner-private-agent-state", agentStateVersion: 9,
            displayProjectionV1: JSON.stringify(displayProjectionV1),
        } });
        const token = crypto.randomUUID();
        const share = await db.publicSessionShare.create({ data: {
            sessionId, createdByUserId: owner.id, keyDerivation: "legacy_token_v1",
            tokenHash: createHash("sha256").update(token, "utf8").digest(),
            encryptedDataKey: null, isConsentRequired: false,
        } });
        await auth.init();
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: "account", authority: "present_user" });
        const app = createCurrentClientTestApp({ authentication: "real" });
        publicShareRoutes(app);
        await app.ready();
        try {
            const request = { method: "GET" as const, url: `/v1/public-share/${encodeURIComponent(token)}`,
                headers: { authorization: `Bearer ${ownerToken}` } };
            const response = await app.inject(request);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().session).toMatchObject({
                id: sessionId, metadata: JSON.stringify(sharedMetadata), metadataVersion: 0,
                metadataLayoutVersion: 1, agentState: null, agentStateVersion: 9,
            });
            expect.soft(response.json().session.displayProjectionV1).toEqual({
                v: 1, metadataLayoutVersion: 1, sourceMetadataVersion: 0, shared: sharedDisplay.envelope,
            });
            expect(response.json().session).not.toHaveProperty("ownerMetadata");
            for (const privateValue of [ownerDisplay.envelope.c, ownerMetadata.workspace.name,
                ownerMetadata.workspace.path, ownerMetadata.workspace.machineId, "owner-private-agent-state"]) {
                expect(response.body).not.toContain(privateValue);
            }
            await expect(db.publicShareAccessLog.findFirst({ where: { publicShareId: share.id }, select: { userId: true } }))
                .resolves.toEqual({ userId: owner.id });

            await db.session.update({ where: { id: sessionId }, data: {
                displayProjectionV1: JSON.stringify({
                    ...displayProjectionV1,
                    shared: {
                        ...sharedDisplay.envelope,
                        v: { ...sharedDisplay.envelope.v, purpose: "session_owner_display" },
                    },
                }),
            } });
            const fallback = await app.inject(request);
            expect(fallback.statusCode, fallback.body).toBe(200);
            expect(fallback.json().session).toMatchObject({
                id: sessionId, metadata: JSON.stringify(sharedMetadata), metadataVersion: 0,
                metadataLayoutVersion: 1, agentState: null, agentStateVersion: 9,
            });
            expect(fallback.json().session).not.toHaveProperty("displayProjectionV1");
            expect(fallback.json().session).not.toHaveProperty("ownerMetadata");
            expect(fallback.body).not.toContain(ownerDisplay.envelope.c);
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
                payload: JSON.stringify({ lookupId: token, keyDerivation: 'fragment_v1', isConsentRequired: false }),
            });
            expect(createRes.statusCode).toBe(200);

            const accessRes = await app.inject({
                method: "GET",
                url: `/v1/public-shares/${encodeURIComponent(token)}/content`,
                headers: { host: new URL(createRes.json().viewerOrigin).host },
            });
            expect(accessRes.statusCode).toBe(200);
            const json = accessRes.json();
            expect(json.content.kind).toBe('session');
            expect(json.encryptionMode).toBe("plain");
            const publicMetadata = JSON.parse(json.content.metadata);
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
                    payload: JSON.stringify({ lookupId: token, keyDerivation: 'fragment_v1', isConsentRequired: false }),
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

    it("walks a capped plaintext public share past one page on the already-authorized grant", async () => {
        // A share longer than one page used to be served as a single descending read with no
        // cursor, so the viewer silently began MID-CONVERSATION. Paging must reach the oldest
        // row, and every page must ride the ONE grant the viewer already consumed.
        const owner = await createCurrentE2eeAccount();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_paged_share",
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadata: STORED_SHARED_METADATA_V1,
                agentState: null,
            },
            select: { id: true },
        });
        const totalMessages = 5;
        for (let seq = 1; seq <= totalMessages; seq += 1) {
            await db.sessionMessage.create({
                data: {
                    sessionId: session.id,
                    seq,
                    content: {
                        t: "plain",
                        v: { role: "user", content: { type: "text", text: `m${seq}` } },
                    },
                },
            });
        }

        const token = "tok_plain_paged_share";
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
            expect(metadata.statusCode).toBe(200);
            const grant = metadata.json().messagesAccessToken;

            const collected: number[] = [];
            let beforeSeq: number | null = null;
            let pages = 0;
            let sawHasMore = false;
            for (;;) {
                const page: Awaited<ReturnType<typeof app.inject>> = await app.inject({
                    method: "GET",
                    url: `/v1/public-share/${encodeURIComponent(token)}/messages?limit=2`
                        + (beforeSeq === null ? "" : `&beforeSeq=${beforeSeq}`),
                    headers: { "x-public-share-messages-access-token": grant },
                });
                expect(page.statusCode).toBe(200);
                const body = page.json();
                collected.push(...body.messages.map((m: { seq: number }) => m.seq));
                pages += 1;
                if (body.hasMore !== true) {
                    expect(body.nextBeforeSeq).toBeNull();
                    break;
                }
                sawHasMore = true;
                expect(body.nextBeforeSeq).toBe(
                    body.messages[body.messages.length - 1].seq,
                );
                beforeSeq = body.nextBeforeSeq;
                expect(pages).toBeLessThan(10);
            }

            expect(sawHasMore).toBe(true);
            expect(pages).toBeGreaterThan(1);
            // The FULL history, oldest row included — the truncation this walk exists to refute.
            expect([...collected].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
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

    it("projects a signed account_directory bearer as anonymous on the public share read route", async () => {
        await auth.init();
        const owner = await createCurrentE2eeAccount();
        const viewer = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const [ordinaryToken, directoryToken] = await Promise.all([
            auth.createToken(viewer.id, undefined, { kind: "account", authority: "present_user" }),
            auth.createToken(viewer.id, undefined, { kind: "account_directory", authority: "present_user" }),
        ]);
        const [viewerSession, anonymousSession] = await Promise.all([
            db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `s_public_share_directory_viewer_${crypto.randomUUID()}`,
                    encryptionMode: "plain",
                    metadata: STORED_SHARED_METADATA_V1,
                    metadataVersion: 4,
                    metadataLayoutVersion: 1,
                    ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                    agentState: null,
                    agentStateVersion: 0,
                },
                select: { id: true },
            }),
            db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `s_public_share_directory_anon_${crypto.randomUUID()}`,
                    encryptionMode: "plain",
                    metadata: STORED_SHARED_METADATA_V1,
                    metadataVersion: 4,
                    metadataLayoutVersion: 1,
                    ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                    agentState: null,
                    agentStateVersion: 0,
                },
                select: { id: true },
            }),
        ]);
        const token = `tok_public_share_directory_bearer_${crypto.randomUUID()}`;
        const anonymousToken = `tok_public_share_directory_anon_${crypto.randomUUID()}`;
        const viewerShare = await db.publicSessionShare.create({
            data: {
                sessionId: viewerSession.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });
        const anonymousShare = await db.publicSessionShare.create({
            data: {
                sessionId: anonymousSession.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(anonymousToken, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createCurrentClientTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const ordinaryResponse = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
                headers: { authorization: `Bearer ${ordinaryToken}` },
            });
            expect(ordinaryResponse.statusCode, ordinaryResponse.body).toBe(200);
            expect(ordinaryResponse.json()).toMatchObject({ accessLevel: "view" });

            const directoryResponse = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(anonymousToken)}`,
                headers: { authorization: `Bearer ${directoryToken}` },
            });
            expect(directoryResponse.statusCode, directoryResponse.body).toBe(200);
            expect(directoryResponse.json()).toMatchObject({ accessLevel: "view" });
        } finally {
            await app.close();
        }

        // The ordinary signed bearer is logged as its account; the restricted
        // Directory credential is logged as anonymous on the identical route:
        // it was never projected as the optional authenticated user.
        const viewerShareLogs = await db.publicShareAccessLog.findMany({
            where: { publicShareId: viewerShare.id },
            select: { userId: true },
        });
        expect(viewerShareLogs.map((entry) => entry.userId)).toEqual([viewer.id]);
        const anonymousShareLogs = await db.publicShareAccessLog.findMany({
            where: { publicShareId: anonymousShare.id },
            select: { userId: true },
        });
        expect(anonymousShareLogs.map((entry) => entry.userId)).toEqual([null]);
    });
});
