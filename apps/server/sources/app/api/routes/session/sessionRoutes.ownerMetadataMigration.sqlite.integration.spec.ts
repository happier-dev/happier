import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

const PLAIN_OWNER_METADATA = { t: "plain", v: { v: 1 } } as const;
const ENCRYPTED_OWNER_METADATA = {
    t: "encrypted",
    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
} as const;
const LEGACY_METADATA = JSON.stringify({});
const LEGACY_AGENT_STATE = JSON.stringify({});
const SHARED_METADATA = JSON.stringify({ v: 1 });

describe("session owner metadata migration route (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-owner-migration-",
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

    it("atomically migrates the exact plain layout-zero tuple to canonical layout one", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `legacy-frozen-${Math.random()}`,
                encryptionMode: "plain",
                metadataLayoutVersion: 0,
                metadata: LEGACY_METADATA,
                metadataVersion: 4,
                ownerMetadata: null,
                agentState: LEGACY_AGENT_STATE,
                agentStateVersion: 7,
            },
            select: { id: true },
        });
        const changesBefore = await db.accountChange.count({
            where: { accountId: owner.id },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app: FastifyInstance) => {
                const payload = {
                    mode: "owner_migration",
                    expectedAccountEncryptionMode: "plain",
                    expectedAccountContentPublicKeyFingerprint: null,
                    source: {
                        metadataLayoutVersion: 0,
                        metadata: {
                            version: 4,
                            ciphertext: LEGACY_METADATA,
                        },
                        ownerMetadata: null,
                        agentState: {
                            version: 7,
                            ciphertext: LEGACY_AGENT_STATE,
                        },
                    },
                    target: {
                        metadataLayoutVersion: 1,
                        sharedMetadata: {
                            ciphertext: SHARED_METADATA,
                        },
                        ownerMetadata: PLAIN_OWNER_METADATA,
                        agentState: {
                            ciphertext: LEGACY_AGENT_STATE,
                        },
                    },
                } as const;
                const inject = (requestPayload: object) => app.inject({
                    method: "PATCH",
                    url: `/v2/sessions/${session.id}`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                        "x-happier-account-stored-content-protocol": "2",
                    },
                    payload: requestPayload,
                });

                const response = await inject(payload);
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toEqual({
                    success: true,
                    metadataLayoutVersion: 1,
                    sharedMetadata: { version: 5 },
                    agentState: { version: 8 },
                });

                const afterFirstWrite =
                    await db.session.findUniqueOrThrow({
                        where: { id: session.id },
                    });
                const changesAfterFirst =
                    await db.accountChange.count({
                        where: { accountId: owner.id },
                    });
                expect(changesAfterFirst).toBeGreaterThan(
                    changesBefore,
                );

                const emitUpdate = vi.spyOn(
                    eventRouter,
                    "emitUpdate",
                );
                const replay = await inject(payload);
                expect(replay.statusCode, replay.body).toBe(200);
                expect(replay.json()).toEqual(response.json());
                await expect(db.session.findUniqueOrThrow({
                    where: { id: session.id },
                })).resolves.toEqual(afterFirstWrite);
                await expect(db.accountChange.count({
                    where: { accountId: owner.id },
                })).resolves.toBe(changesAfterFirst);
                expect(emitUpdate).not.toHaveBeenCalled();

                const conflict = await inject({
                    ...payload,
                    source: {
                        ...payload.source,
                        metadata: {
                            ...payload.source.metadata,
                            version:
                                payload.source.metadata.version + 1,
                        },
                    },
                });
                expect(conflict.statusCode, conflict.body).toBe(409);
                expect(conflict.json()).toMatchObject({
                    code: "session_metadata_version_conflict",
                });
                await expect(db.session.findUniqueOrThrow({
                    where: { id: session.id },
                })).resolves.toEqual(afterFirstWrite);
                await expect(db.accountChange.count({
                    where: { accountId: owner.id },
                })).resolves.toBe(changesAfterFirst);
                expect(emitUpdate).not.toHaveBeenCalled();
            },
        );

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadataLayoutVersion: true,
                metadata: true,
                metadataVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            },
        })).resolves.toEqual({
            metadataLayoutVersion: 1,
            metadata: SHARED_METADATA,
            metadataVersion: 5,
            ownerMetadata: JSON.stringify(PLAIN_OWNER_METADATA),
            agentState: LEGACY_AGENT_STATE,
            agentStateVersion: 8,
        });
    });

    it("normalizes the retained encrypted layout-one owner value and contracts it through the canonical tuple CAS", async () => {
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
                tag: `legacy-layout-one-owner-${Math.random()}`,
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                metadata: SHARED_METADATA,
                metadataVersion: 4,
                ownerMetadata: ENCRYPTED_OWNER_METADATA.c,
                agentState: LEGACY_AGENT_STATE,
                agentStateVersion: 7,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app: FastifyInstance) => {
                const headers = {
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                } as const;
                const listed = await app.inject({
                    method: "GET",
                    url: "/v2/sessions?limit=10",
                    headers,
                });
                expect(listed.statusCode, listed.body).toBe(200);
                expect(listed.json().sessions).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            id: session.id,
                            metadataLayoutVersion: 1,
                            ownerMetadata: ENCRYPTED_OWNER_METADATA,
                        }),
                    ]),
                );

                const updated = await app.inject({
                    method: "PATCH",
                    url: `/v2/sessions/${session.id}`,
                    headers: {
                        ...headers,
                        "content-type": "application/json",
                    },
                    payload: {
                        mode: "owner",
                        metadataLayoutVersion: 1,
                        expectedOwnerMetadata:
                            ENCRYPTED_OWNER_METADATA,
                        sharedMetadata: {
                            ciphertext: SHARED_METADATA,
                            expectedVersion: 4,
                        },
                        ownerMetadata: ENCRYPTED_OWNER_METADATA,
                        agentState: {
                            ciphertext: LEGACY_AGENT_STATE,
                            expectedVersion: 7,
                        },
                    },
                });
                expect(updated.statusCode, updated.body).toBe(200);
            },
        );

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadataVersion: true,
                ownerMetadata: true,
                agentStateVersion: true,
            },
        })).resolves.toEqual({
            metadataVersion: 5,
            ownerMetadata:
                JSON.stringify(ENCRYPTED_OWNER_METADATA),
            agentStateVersion: 8,
        });
    });

    it("rejects unsupported legacy owner fields without mutating the layout-zero tuple", async () => {
        const owner = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const legacyMetadata = JSON.stringify({
            unsupportedPrivateField: "secret",
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `legacy-unsupported-${Math.random()}`,
                encryptionMode: "plain",
                metadataLayoutVersion: 0,
                metadata: legacyMetadata,
                metadataVersion: 2,
                ownerMetadata: null,
                agentState: null,
                agentStateVersion: 3,
            },
        });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app: FastifyInstance) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: `/v2/sessions/${session.id}`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                        "x-happier-account-stored-content-protocol": "2",
                    },
                    payload: {
                        mode: "owner_migration",
                        expectedAccountEncryptionMode: "plain",
                        expectedAccountContentPublicKeyFingerprint: null,
                        source: {
                            metadataLayoutVersion: 0,
                            metadata: {
                                version: 2,
                                ciphertext: legacyMetadata,
                            },
                            ownerMetadata: null,
                            agentState: {
                                version: 3,
                                ciphertext: null,
                            },
                        },
                        target: {
                            metadataLayoutVersion: 1,
                            sharedMetadata: {
                                ciphertext: SHARED_METADATA,
                            },
                            ownerMetadata: PLAIN_OWNER_METADATA,
                            agentState: { ciphertext: null },
                        },
                    },
                });
                expect(response.statusCode, response.body).toBe(400);
            },
        );
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
        })).resolves.toEqual(before);
    });

    it("returns the typed privacy refusal when Account currentness no longer matches", async () => {
        const owner = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `legacy-account-race-${Math.random()}`,
                encryptionMode: "plain",
                metadataLayoutVersion: 0,
                metadata: LEGACY_METADATA,
                metadataVersion: 4,
                ownerMetadata: null,
                agentState: LEGACY_AGENT_STATE,
                agentStateVersion: 7,
            },
        });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
        });
        const changesBefore = await db.accountChange.count({
            where: { accountId: owner.id },
        });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app: FastifyInstance) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: `/v2/sessions/${session.id}`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                        "x-happier-account-stored-content-protocol": "2",
                    },
                    payload: {
                        mode: "owner_migration",
                        expectedAccountEncryptionMode: "e2ee",
                        expectedAccountContentPublicKeyFingerprint:
                            `content-public-key-sha256:${"a".repeat(64)}`,
                        source: {
                            metadataLayoutVersion: 0,
                            metadata: {
                                version: 4,
                                ciphertext: LEGACY_METADATA,
                            },
                            ownerMetadata: null,
                            agentState: {
                                version: 7,
                                ciphertext: LEGACY_AGENT_STATE,
                            },
                        },
                        target: {
                            metadataLayoutVersion: 1,
                            sharedMetadata: {
                                ciphertext: "encrypted-shared",
                            },
                            ownerMetadata:
                                ENCRYPTED_OWNER_METADATA,
                            agentState: {
                                ciphertext: "encrypted-agent",
                            },
                        },
                    },
                });

                expect(response.statusCode, response.body).toBe(409);
                expect(response.json()).toEqual({
                    error:
                        "Session metadata privacy upgrade required",
                    code: "metadata_privacy_upgrade_required",
                });
            },
        );

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
        })).resolves.toEqual(before);
        await expect(db.accountChange.count({
            where: { accountId: owner.id },
        })).resolves.toBe(changesBefore);
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
