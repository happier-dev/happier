import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import tweetnacl from "tweetnacl";
import {
    signAccountContentKeyBindingV1,
    sealEncryptedDataKeyEnvelopeV1,
    V2SessionByIdResponseSchema,
} from "@happier-dev/protocol";

import { eventRouter } from "@/app/events/eventRouter";
import { buildAccountStoredContentUpgradeRequired } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

const PLAIN_OWNER_METADATA = { t: "plain", v: { v: 1 } } as const;
const STORED_PLAIN_OWNER_METADATA = JSON.stringify(PLAIN_OWNER_METADATA);
const ENCRYPTED_OWNER_METADATA = {
    t: "encrypted",
    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
} as const;

function createSessionDataKeyEnvelope() {
    return Buffer.from(sealEncryptedDataKeyEnvelopeV1({
        dataKey: tweetnacl.randomBytes(32),
        recipientPublicKey: tweetnacl.box.keyPair().publicKey,
        randomBytes: (length) => tweetnacl.randomBytes(length),
    })).toString("base64");
}

const layoutOneBody = {
    tag: "layout-one-create",
    metadataLayoutVersion: 1,
    sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) },
    ownerMetadata: PLAIN_OWNER_METADATA,
    agentState: JSON.stringify({ privateAgentState: "owner-only" }),
    dataEncryptionKey: null,
    encryptionMode: "plain",
} as const;

describe("session create-or-load metadata envelope (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-create-envelope-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createAccount(publicKey: string) {
        return db.account.create({
            data: { publicKey, encryptionMode: "plain" },
            select: { id: true },
        });
    }

    async function createE2eeAccount() {
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        const contentPublicKeySig = signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey: content.publicKey,
        });
        return db.account.create({
            data: {
                publicKey: Buffer.from(signing.publicKey).toString("hex"),
                encryptionMode: "e2ee",
                contentPublicKey: new Uint8Array(content.publicKey),
                contentPublicKeySig: new Uint8Array(contentPublicKeySig),
            },
            select: { id: true },
        });
    }

    async function withApp(run: (app: FastifyInstance) => Promise<void>) {
        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            run,
        );
    }

    it("creates a fresh plain layout-v1 session behind the current-client activation fence", async () => {
        const owner = await createAccount("pk-layout-one-owner");

        await withApp(async (app) => {
            const created = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: layoutOneBody,
            });

            expect(created.statusCode, created.body).toBe(200);
            expect(created.json()).toMatchObject({
                created: true,
                session: {
                    metadataLayoutVersion: 1,
                    ownerMetadata: PLAIN_OWNER_METADATA,
                    pendingCount: 0,
                    pendingVersion: 0,
                },
            });
            expect(
                V2SessionByIdResponseSchema.parse(created.json()).session.share,
            ).toBeNull();
            await expect(db.session.findFirstOrThrow({
                where: { accountId: owner.id },
                select: {
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    dataKeyEnvelopes: { select: { encryptedDataKey: true } },
                },
            })).resolves.toEqual({
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_PLAIN_OWNER_METADATA,
                dataKeyEnvelopes: [],
            });
        });
    });

    it("returns the stored origin and current reports-to relation for a role-less fresh child and rejoin", async () => {
        const owner = await createAccount("pk-create-worker-organization");
        const createLead = (tag: string) => db.session.create({ data: {
            accountId: owner.id, tag, encryptionMode: "plain", metadataLayoutVersion: 1,
            metadata: JSON.stringify({ v: 1 }), ownerMetadata: STORED_PLAIN_OWNER_METADATA,
        } });
        const [originalLead, currentLead] = await Promise.all([
            createLead("original-lead"), createLead("current-lead"),
        ]);
        await withApp(async (app) => {
            const headers = {
                "content-type": "application/json", "x-test-user-id": owner.id,
                "x-happier-account-stored-content-protocol": "2",
            };
            const payload = {
                ...layoutOneBody, tag: "role-less-worker", reportsTo: { sessionId: originalLead.id },
                originKind: "session", originSessionId: originalLead.id, workDepth: 1,
            };
            const fresh = await app.inject({ method: "POST", url: "/v1/sessions", headers, payload });
            expect(fresh.statusCode, fresh.body).toBe(200);
            const child = V2SessionByIdResponseSchema.parse(fresh.json()).session;
            expect(child).toMatchObject({ reportsTo: { sessionId: originalLead.id }, origin: { kind: "session" } });
            expect(child.ownerMetadata).toEqual(PLAIN_OWNER_METADATA);

            const reattach = await app.inject({
                method: "POST", url: `/v1/sessions/${child.id}/reports-to`, headers,
                payload: { leadSessionId: currentLead.id, expectedLeadSessionId: originalLead.id },
            });
            expect(reattach.statusCode, reattach.body).toBe(200);
            const rejoined = await app.inject({ method: "POST", url: "/v1/sessions", headers,
                payload: { ...payload, originKind: "execution_run", originSessionId: currentLead.id },
            });
            expect(rejoined.statusCode, rejoined.body).toBe(200);
            expect(rejoined.json().created).toBe(false);
            expect(V2SessionByIdResponseSchema.parse(rejoined.json()).session).toMatchObject({
                id: child.id, reportsTo: { sessionId: currentLead.id }, origin: { kind: "session" },
            });
        });
    });

    it("rejects every Team credential binding intent before Session creation when the capability is disabled", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "0",
        });
        const owner = await createAccount("pk-disabled-team-credential-binding");

        await withApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: {
                    ...layoutOneBody,
                    tag: "disabled-team-credential-binding",
                    teamCredentialBindings: [{
                        v: 1,
                        slot: { kind: "provider_model" },
                        resourceId: null,
                    }],
                },
            });

            expect({ status: response.statusCode, body: response.json() }).toEqual({
                status: 409,
                body: {
                    error: "update_required",
                    kind: "update_required",
                    operation: "session.spawn_new",
                    component: "server",
                    reason: "session_team_credential_binding_update_required",
                },
            });
            await expect(db.session.count({ where: { accountId: owner.id } })).resolves.toBe(0);
        });
    });

    it.each([
        {
            name: "plain Account with E2EE Session storage",
            createOwner: () => createAccount("pk-cross-mode-plain-account"),
            payload: {
                ...layoutOneBody,
                tag: "plain-account-e2ee-session",
                encryptionMode: "e2ee" as const,
                sharedMetadata: {
                    ciphertext: "encrypted-shared-metadata",
                },
                ownerMetadata: PLAIN_OWNER_METADATA,
                agentState: "encrypted-agent-state",
                dataEncryptionKey:
                    createSessionDataKeyEnvelope(),
            },
        },
        {
            name: "E2EE Account with plain Session storage",
            createOwner: createE2eeAccount,
            payload: {
                ...layoutOneBody,
                tag: "e2ee-account-plain-session",
                encryptionMode: "plain" as const,
                ownerMetadata: ENCRYPTED_OWNER_METADATA,
            },
        },
    ])("creates and discloses owner metadata for $name from Account mode", async ({
        createOwner,
        payload,
    }) => {
        const owner = await createOwner();

        await withApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload,
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                created: true,
                session: {
                    encryptionMode: payload.encryptionMode,
                    ownerMetadata: payload.ownerMetadata,
                    dataEncryptionKey: payload.dataEncryptionKey,
                },
            });
            const envelopes = await db.sessionDataKeyEnvelope.findMany({
                where: { sessionId: response.json().session.id },
                select: { recipientAccountId: true, encryptedDataKey: true },
            });
            expect(envelopes.map((envelope) => ({
                recipientAccountId: envelope.recipientAccountId,
                encryptedDataKey: Buffer.from(envelope.encryptedDataKey).toString("base64"),
            }))).toEqual(payload.dataEncryptionKey === null ? [] : [{
                recipientAccountId: owner.id,
                encryptedDataKey: payload.dataEncryptionKey,
            }]);
        });
    });

    it.each([
        {
            name: "plain Account with encrypted owner metadata",
            createOwner: () => createAccount("pk-swapped-plain-account"),
            payload: {
                ...layoutOneBody,
                tag: "plain-account-encrypted-owner",
                ownerMetadata: ENCRYPTED_OWNER_METADATA,
            },
        },
        {
            name: "E2EE Account with plain owner metadata",
            createOwner: createE2eeAccount,
            payload: {
                ...layoutOneBody,
                tag: "e2ee-account-plain-owner",
                ownerMetadata: PLAIN_OWNER_METADATA,
            },
        },
    ])("rejects $name before Session/change/event effects", async ({
        createOwner,
        payload,
    }) => {
        const owner = await createOwner();
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");

        await withApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload,
            });
            expect(response.statusCode, response.body).toBe(400);
        });

        await expect(db.session.count({
            where: { accountId: owner.id },
        })).resolves.toBe(0);
        await expect(db.accountChange.count({
            where: { accountId: owner.id },
        })).resolves.toBe(0);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("keeps fresh layout-v1 creation closed for a non-current caller", async () => {
        const owner = await createAccount("pk-layout-one-old-client");
        await withApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                },
                payload: {
                    ...layoutOneBody,
                    tag: "layout-one-old-client",
                },
            });
            expect(response.statusCode, response.body).toBe(426);
        });
        await expect(db.session.count({
            where: { accountId: owner.id },
        })).resolves.toBe(0);
    });

    it("loads an already-layout-v1 same-tag session without overwriting the tuple", async () => {
        const owner = await createAccount("pk-layout-one-retry");
        const before = await db.session.create({
            data: {
                accountId: owner.id,
                tag: layoutOneBody.tag,
                encryptionMode: "plain",
                metadata: layoutOneBody.sharedMetadata.ciphertext,
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_PLAIN_OWNER_METADATA,
                agentState: layoutOneBody.agentState,
                pendingCount: 3,
                pendingVersion: 4,
                active: false,
            },
        });

        await withApp(async (app) => {
            const request = () => app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: layoutOneBody,
            });
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const loaded = await request();
                expect(loaded.statusCode).toBe(200);
                expect(loaded.json()).toMatchObject({
                    created: false,
                    session: expect.objectContaining({
                        id: before.id,
                        metadata: before.metadata,
                        ownerMetadata: PLAIN_OWNER_METADATA,
                        agentState: before.agentState,
                        metadataLayoutVersion: 1,
                        pendingCount: 3,
                        pendingVersion: 4,
                        active: false,
                    }),
                });
                expect(
                    V2SessionByIdResponseSchema.parse(loaded.json()).session.share,
                ).toBeNull();
            }
            const after = await db.session.findUniqueOrThrow({
                where: { id: before.id },
            });
            expect({
                ...after,
                meaningfulActivityAt: before.meaningfulActivityAt,
                updatedAt: before.updatedAt,
            }).toEqual(before);
            expect(after.meaningfulActivityAt).not.toBeNull();
            expect(after.meaningfulActivityAt?.getTime())
                .toBeGreaterThanOrEqual(before.createdAt.getTime());
        });
    });

    it("restores an archived legacy same-tag Session through the released create-or-load route", async () => {
        const owner = await createE2eeAccount();
        const oldActivityAt = new Date(1_000);
        const before = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "archived-legacy-rejoin",
                encryptionMode: "e2ee",
                metadata: "encrypted-legacy-whole-bag",
                metadataLayoutVersion: 0,
                active: false,
                archivedAt: new Date(2_000),
                meaningfulActivityAt: oldActivityAt,
                pendingCount: 5,
                pendingVersion: 6,
            },
        });

        await withApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                },
                payload: {
                    tag: before.tag,
                    metadata: "replacement-must-not-win",
                    agentState: "replacement-must-not-win",
                    dataEncryptionKey: null,
                    encryptionMode: "e2ee",
                },
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                created: false,
                session: {
                    id: before.id,
                    metadata: before.metadata,
                    active: false,
                    pendingCount: 5,
                    pendingVersion: 6,
                },
            });
        });

        const restored = await db.session.findUniqueOrThrow({ where: { id: before.id } });
        expect(restored.archivedAt).toBeNull();
        if (!restored.meaningfulActivityAt) {
            throw new Error("Restored Session must have a meaningful activity timestamp");
        }
        expect(restored.meaningfulActivityAt.getTime()).toBeGreaterThan(oldActivityAt.getTime());
        expect(restored.agentState).toBe(before.agentState);
    });

    it.each([
        {
            storageState: "machine_only" as const,
            progress: {},
        },
        {
            storageState: "server_partial" as const,
            progress: { acceptedThroughServerSeq: 0 },
        },
        {
            storageState: "snapshot_complete" as const,
            progress: {
                materializationPublicationId: "layout-one-open-publication",
                materializedThroughSourceAt: 1n,
                publishedThroughServerSeq: 0,
            },
        },
    ])("loads an external layout-v1 row after materialization preparation advances it to $storageState", async ({
        storageState,
        progress,
    }) => {
        const owner = await createAccount(`pk-layout-one-${storageState}`);
        const before = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `layout-one-${storageState}`,
                encryptionMode: "plain",
                metadata: layoutOneBody.sharedMetadata.ciphertext,
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_PLAIN_OWNER_METADATA,
                agentState: layoutOneBody.agentState,
                currentStorageState: "machine_only",
            },
        });
        if (storageState !== "machine_only") {
            await db.session.update({
                where: { id: before.id },
                data: {
                    currentStorageState: storageState,
                    ...progress,
                },
            });
        }

        await withApp(async (app) => {
            const loaded = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: {
                    ...layoutOneBody,
                    tag: before.tag,
                    currentStorageState: "machine_only",
                },
            });

            expect(loaded.statusCode, loaded.body).toBe(200);
            expect(loaded.json()).toMatchObject({
                created: false,
                session: { id: before.id },
            });
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: before.id },
            select: {
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                materializedThroughSourceAt: true,
                publishedThroughServerSeq: true,
            },
        })).resolves.toMatchObject({
            currentStorageState: storageState,
            ...progress,
        });
    });

    it.each(["hosted", "legacy_external_unknown"] as const)(
        "does not load a layout-v1 external request from %s storage authority",
        async (currentStorageState) => {
            const owner = await createAccount(`pk-layout-one-${currentStorageState}`);
            const existing = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `layout-one-${currentStorageState}`,
                    encryptionMode: "plain",
                    metadata: layoutOneBody.sharedMetadata.ciphertext,
                    metadataLayoutVersion: 1,
                    ownerMetadata: STORED_PLAIN_OWNER_METADATA,
                    agentState: layoutOneBody.agentState,
                    currentStorageState,
                },
            });

            await withApp(async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v1/sessions",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                        "x-happier-account-stored-content-protocol": "2",
                    },
                    payload: {
                        ...layoutOneBody,
                        tag: existing.tag,
                        currentStorageState: "machine_only",
                    },
                });

                expect(response.statusCode, response.body).toBe(409);
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: existing.id },
                select: { currentStorageState: true },
            })).resolves.toEqual({ currentStorageState });
        },
    );

    it("does not bypass Account currentness when an external layout-v1 row is already materialized", async () => {
        const owner = await createE2eeAccount();
        const existing = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "layout-one-invalid-account",
                encryptionMode: "e2ee",
                metadata: "encrypted-shared-metadata",
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify(ENCRYPTED_OWNER_METADATA),
                agentState: "encrypted-agent-state",
                currentStorageState: "snapshot_complete",
                materializationPublicationId: "invalid-account-publication",
                materializedThroughSourceAt: 1n,
                publishedThroughServerSeq: 0,
            },
        });
        await db.account.update({
            where: { id: owner.id },
            data: { contentPublicKeySig: null },
        });

        await withApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: {
                    ...layoutOneBody,
                    tag: existing.tag,
                    sharedMetadata: { ciphertext: "encrypted-shared-metadata" },
                    ownerMetadata: ENCRYPTED_OWNER_METADATA,
                    agentState: "encrypted-agent-state",
                    encryptionMode: "e2ee",
                    currentStorageState: "machine_only",
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: "invalid-params" });
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: existing.id },
            select: { currentStorageState: true },
        })).resolves.toEqual({ currentStorageState: "snapshot_complete" });
    });

    it("loads the canonical same-layout tuple without overwriting divergent request fields and returns typed upgrade for a legacy same-tag request", async () => {
        const owner = await createAccount("pk-layout-skew");
        const before = await db.session.create({
            data: {
                accountId: owner.id,
                tag: layoutOneBody.tag,
                encryptionMode: "plain",
                metadata: layoutOneBody.sharedMetadata.ciphertext,
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_PLAIN_OWNER_METADATA,
                agentState: layoutOneBody.agentState,
            },
        });

        await withApp(async (app) => {
            const inject = (
                payload: Record<string, unknown>,
                current = true,
            ) => app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    ...(current
                        ? {
                            "x-happier-account-stored-content-protocol":
                                "2",
                        }
                        : {}),
                },
                payload,
            });

            const divergentRequest = await inject({
                ...layoutOneBody,
                sharedMetadata: {
                    ciphertext: JSON.stringify({
                        v: 1,
                        summary: {
                            text: "divergent but valid",
                            updatedAt: 1,
                        },
                    }),
                },
            });
            expect(divergentRequest.statusCode).toBe(200);
            expect(divergentRequest.json()).toMatchObject({
                created: false,
                session: {
                    id: before.id,
                    metadata: before.metadata,
                    ownerMetadata: PLAIN_OWNER_METADATA,
                    agentState: before.agentState,
                    metadataLayoutVersion: 1,
                },
            });
            const oldClientAgainstCurrent = await inject(
                {
                    tag: layoutOneBody.tag,
                    metadata: "legacy-whole-bag",
                    agentState: null,
                    dataEncryptionKey: null,
                    encryptionMode: "plain",
                },
                false,
            );
            expect(
                oldClientAgainstCurrent.statusCode,
                oldClientAgainstCurrent.body,
            ).toBe(426);
            const after = await db.session.findUniqueOrThrow({
                where: { id: before.id },
            });
            expect({
                ...after,
                meaningfulActivityAt: before.meaningfulActivityAt,
                updatedAt: before.updatedAt,
            }).toEqual(before);
            expect(after.meaningfulActivityAt).not.toBeNull();
            expect(after.meaningfulActivityAt?.getTime())
                .toBeGreaterThanOrEqual(before.createdAt.getTime());
        });
    });

    it("returns the canonical privacy-upgrade response for malformed persisted plaintext shared metadata without mutating the row", async () => {
        const owner = await createAccount("pk-layout-malformed-persisted-shared");
        const existing = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "layout-one-malformed-persisted-shared",
                encryptionMode: "plain",
                metadata: "not-valid-shared-metadata-json",
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_PLAIN_OWNER_METADATA,
                agentState: layoutOneBody.agentState,
            },
            select: {
                id: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            },
        });
        const changesBefore = await db.accountChange.count({
            where: { accountId: owner.id },
        });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");

        await withApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: {
                    ...layoutOneBody,
                    tag: "layout-one-malformed-persisted-shared",
                },
            });

            expect(response.statusCode, response.body).toBe(409);
            expect(response.json()).toEqual({
                error: "Session metadata privacy upgrade required",
                code: "metadata_privacy_upgrade_required",
            });
        });

        await expect(db.session.findUniqueOrThrow({
            where: { id: existing.id },
            select: {
                id: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            },
        })).resolves.toEqual(existing);
        await expect(db.accountChange.count({
            where: { accountId: owner.id },
        })).resolves.toBe(changesBefore);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: "no declaration",
            declaration: undefined,
            expectedStatus: 426,
        },
        {
            name: "a malformed declaration",
            declaration: "malformed",
            expectedStatus: 426,
        },
        {
            name: "a V1 declaration",
            declaration: "1",
            expectedStatus: 426,
        },
        {
            name: "the current V2 declaration",
            declaration: "2",
            expectedStatus: 409,
        },
    ])("rejects a fresh keyless plain layout-zero create before persistence under $name", async ({
        declaration,
        expectedStatus,
    }) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });
        const owner = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const changesBefore = await db.accountChange.count({
            where: { accountId: owner.id },
        });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");

        await withApp(async (app) => {
            const payload = {
                tag: "unsafe-plain-layout-zero",
                metadata: "legacy-whole-bag",
                agentState: "legacy-agent-state",
                dataEncryptionKey: null,
                encryptionMode: "plain",
            } as const;
            const legacyResponse = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    ...(declaration === undefined
                        ? {}
                        : {
                            "x-happier-account-stored-content-protocol":
                                declaration,
                        }),
                },
                payload,
            });
            expect(
                legacyResponse.statusCode,
                legacyResponse.body,
            ).toBe(expectedStatus);
            expect(legacyResponse.json()).toEqual(
                expectedStatus === 426
                    ? buildAccountStoredContentUpgradeRequired()
                    : {
                        error: "Session metadata privacy upgrade required",
                        code: "metadata_privacy_upgrade_required",
                    },
            );
        });
        await expect(db.session.count({
            where: { accountId: owner.id },
        })).resolves.toBe(0);
        await expect(db.accountChange.count({
            where: { accountId: owner.id },
        })).resolves.toBe(changesBefore);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("keeps a valid legacy E2EE layout-zero fresh create supported", async () => {
        const owner = await createE2eeAccount();

        await withApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                },
                payload: {
                    tag: "legacy-e2ee-layout-zero",
                    metadata: "encrypted-legacy-whole-bag",
                    agentState: "encrypted-legacy-agent-state",
                    dataEncryptionKey:
                        createSessionDataKeyEnvelope(),
                    encryptionMode: "e2ee",
                    currentStorageState: "machine_only",
                },
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                created: true,
                session: {
                    metadataLayoutVersion: 0,
                    encryptionMode: "e2ee",
                },
            });
            expect(response.json()).not.toHaveProperty("session.share");
        });
        await expect(db.session.count({
            where: { accountId: owner.id },
        })).resolves.toBe(1);
        await expect(db.session.findFirstOrThrow({
            where: { accountId: owner.id },
            select: { currentStorageState: true },
        })).resolves.toEqual({ currentStorageState: "machine_only" });
    });

    it.each(["hosted", "legacy_external_unknown"] as const)(
        "repairs a safe legacy %s predecessor when its owner machine relinks it",
        async (currentStorageState) => {
            const owner = await createE2eeAccount();
            const existing = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `safe-predecessor-${currentStorageState}`,
                    encryptionMode: "e2ee",
                    metadata: "encrypted-legacy-whole-bag",
                    metadataLayoutVersion: 0,
                    currentStorageState,
                    seq: 0,
                },
            });

            await withApp(async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v1/sessions",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                    },
                    payload: {
                        tag: existing.tag,
                        metadata: "encrypted-legacy-whole-bag",
                        agentState: null,
                        dataEncryptionKey: null,
                        encryptionMode: "e2ee",
                        currentStorageState: "machine_only",
                    },
                });

                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({
                    created: false,
                    session: {
                        id: existing.id,
                    },
                });
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: existing.id },
                select: { currentStorageState: true },
            })).resolves.toEqual({ currentStorageState: "machine_only" });
        },
    );

    it.each(["hosted", "legacy_external_unknown"] as const)(
        "rejects unsafe legacy %s predecessor repair after server transcript ownership begins",
        async (currentStorageState) => {
            const owner = await createE2eeAccount();
            const existing = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `unsafe-predecessor-${currentStorageState}`,
                    encryptionMode: "e2ee",
                    metadata: "encrypted-legacy-whole-bag",
                    metadataLayoutVersion: 0,
                    currentStorageState,
                    seq: 1,
                },
            });

            await withApp(async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v1/sessions",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                    },
                    payload: {
                        tag: existing.tag,
                        metadata: "encrypted-legacy-whole-bag",
                        agentState: null,
                        dataEncryptionKey: null,
                        encryptionMode: "e2ee",
                        currentStorageState: "machine_only",
                    },
                });

                expect(response.statusCode, response.body).toBe(409);
                expect(response.json()).toEqual({
                    error: "storage-state-conflict",
                    code: "session_storage_state_conflict",
                });
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: existing.id },
                select: { currentStorageState: true },
            })).resolves.toEqual({ currentStorageState });
        },
    );

    it("rejects an effectively plain legacy create from an E2EE Account before persistence", async () => {
        const owner = await createE2eeAccount();
        const changesBefore = await db.accountChange.count({
            where: { accountId: owner.id },
        });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");
        const payload = {
            tag: "legacy-e2ee-account-requested-plain",
            metadata: "legacy-plain-whole-bag",
            agentState: "legacy-plain-agent-state",
            dataEncryptionKey: null,
            encryptionMode: "plain",
        } as const;

        await withApp(async (app) => {
            const legacyResponse = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                },
                payload,
            });
            expect(
                legacyResponse.statusCode,
                legacyResponse.body,
            ).toBe(426);

            const currentResponse = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload,
            });
            expect(
                currentResponse.statusCode,
                currentResponse.body,
            ).toBe(409);
            expect(currentResponse.json()).toEqual({
                error: "Session metadata privacy upgrade required",
                code: "metadata_privacy_upgrade_required",
            });
        });

        await expect(db.session.count({
            where: { accountId: owner.id },
        })).resolves.toBe(0);
        await expect(db.accountChange.count({
            where: { accountId: owner.id },
        })).resolves.toBe(changesBefore);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("keeps released layout-zero metadata and Agent-state PATCH writes live while fencing layout one", async () => {
        const owner = await createAccount("pk-layout-zero-writer");
        const legacy = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "legacy-writer",
                encryptionMode: "plain",
                metadata: "legacy-before",
                agentState: "state-before",
            },
        });
        const split = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "split-writer",
                encryptionMode: "plain",
                metadata: layoutOneBody.sharedMetadata.ciphertext,
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_PLAIN_OWNER_METADATA,
                agentState: layoutOneBody.agentState,
            },
        });

        await withApp(async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": owner.id,
                "x-happier-account-stored-content-protocol": "2",
            };
            const updated = await app.inject({
                method: "PATCH",
                url: `/v2/sessions/${legacy.id}`,
                headers,
                payload: {
                    metadata: {
                        ciphertext: "legacy-after",
                        expectedVersion: 0,
                    },
                    agentState: {
                        ciphertext: "state-after",
                        expectedVersion: 0,
                    },
                },
            });
            expect(updated.statusCode).toBe(200);
            expect(updated.json()).toEqual({
                success: true,
                metadata: { version: 1 },
                agentState: { version: 1 },
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: legacy.id },
                select: {
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    metadata: true,
                    metadataVersion: true,
                    agentState: true,
                    agentStateVersion: true,
                },
            })).resolves.toEqual({
                metadataLayoutVersion: 0,
                ownerMetadata: null,
                metadata: "legacy-after",
                metadataVersion: 1,
                agentState: "state-after",
                agentStateVersion: 1,
            });

            const fenced = await app.inject({
                method: "PATCH",
                url: `/v2/sessions/${split.id}`,
                headers,
                payload: {
                    metadata: {
                        ciphertext: "unsafe-legacy-write",
                        expectedVersion: 0,
                    },
                },
            });
            expect(fenced.statusCode).toBe(409);
            expect(fenced.json()).toMatchObject({
                code: "metadata_privacy_upgrade_required",
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: split.id },
                select: {
                    metadata: true,
                    metadataVersion: true,
                    ownerMetadata: true,
                    metadataLayoutVersion: true,
                },
            })).resolves.toEqual({
                metadata: layoutOneBody.sharedMetadata.ciphertext,
                metadataVersion: 0,
                ownerMetadata: STORED_PLAIN_OWNER_METADATA,
                metadataLayoutVersion: 1,
            });
        });
    });

    it("rejects malformed, mixed, storage-policy, and plaintext/data-key mismatches before persistence", async () => {
        const owner = await createAccount("pk-layout-one-invalid");

        await withApp(async (app) => {
            const inject = (payload: Record<string, unknown>) => app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload,
            });
            for (const payload of [
                { ...layoutOneBody, metadata: "mixed-whole-bag" },
                {
                    ...layoutOneBody,
                    ownerMetadata: { ciphertext: "wrong-domain-ciphertext" },
                },
                {
                    ...layoutOneBody,
                    dataEncryptionKey: "AQID",
                },
            ]) {
                expect((await inject(payload)).statusCode).toBe(400);
            }

            harness.resetEnv({
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            });
            const policyMismatch = await inject(layoutOneBody);
            expect(policyMismatch.statusCode).toBe(400);
            expect(policyMismatch.json()).toMatchObject({
                code: "storage_policy_requires_e2ee",
            });
            await expect(db.session.count({
                where: { accountId: owner.id },
            })).resolves.toBe(0);
        });
    });
});
