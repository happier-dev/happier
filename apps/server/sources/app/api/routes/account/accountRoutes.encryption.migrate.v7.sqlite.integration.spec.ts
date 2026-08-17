import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
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
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
    ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS,
    attachAccountEncryptionMigrateProofSignatureV1,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    createPlainSessionOwnerMetadataEnvelopeV1,
    createAccountEncryptionMigrateProofSigningInputV1,
    createAccountEncryptionMigrateRequestBindingDigestV1,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    encodeSessionOwnerMetadataEnvelopeV1,
    sealSessionOwnerMetadataEnvelopeV1,
    type AccountEncryptionMigrateRequest,
    type AccountEncryptionMigrateUnsignedRequest,
    type SessionOwnerMetadataEnvelopeV1,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";
import {
    captureAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    deriveAccountEncryptionMigrationKeyFingerprints,
} from "@/app/encryption/accountEncryptionTransition";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    updateSessionMetadataEnvelopeTupleInTx,
} from "@/app/session/sessionWriteService";
import { eventRouter } from "@/app/events/eventRouter";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { registerAccountEncryptionMigrateRoutes } from "./registerAccountEncryptionMigrateRoutes";

const SESSION_OWNER_MATERIAL = {
    type: "legacy",
    secret: new Uint8Array(32).fill(41),
} as const;

const EMPTY_AMENDMENT9_DIRECTIVES = {
    reviewComments: { action: "assert_empty" as const },
    sessionOrganization: { action: "assert_empty" as const },
    pets: { action: "assert_empty" as const },
};

function createSignedContentKeyBinding(
    signingSecretKey: Uint8Array,
): Readonly<{
    contentPublicKey: string;
    contentPublicKeySig: string;
}> {
    const contentKey = tweetnacl.box.keyPair();
    const signature = tweetnacl.sign.detached(
        Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(contentKey.publicKey),
        ]),
        signingSecretKey,
    );
    return {
        contentPublicKey: privacyKit.encodeBase64(
            new Uint8Array(contentKey.publicKey),
        ),
        contentPublicKeySig: privacyKit.encodeBase64(
            new Uint8Array(signature),
        ),
    };
}

function signPlainToE2eeRequest(params: Readonly<{
    accountId: string;
    request: AccountEncryptionMigrateUnsignedRequest;
    signingSecretKey: Uint8Array;
}>): AccountEncryptionMigrateRequest {
    const signingInput =
        createAccountEncryptionMigrateProofSigningInputV1({
            request: params.request,
            accountId: params.accountId,
            sourceMode: "plain",
        });
    return attachAccountEncryptionMigrateProofSignatureV1({
        request: params.request,
        signature: privacyKit.encodeBase64(
            new Uint8Array(
                tweetnacl.sign.detached(
                    signingInput,
                    params.signingSecretKey,
                ),
            ),
        ),
    });
}

function createEncryptedOwnerEnvelope(
    marker: number,
): SessionOwnerMetadataEnvelopeV1 {
    return sealSessionOwnerMetadataEnvelopeV1({
        material: SESSION_OWNER_MATERIAL,
        ownerMetadata: { v: 1 },
        randomBytes: (length) =>
            new Uint8Array(length).fill(marker),
    });
}

function createTestApp() {
    const app = Fastify({
        logger: false,
        bodyLimit: 1024 * 1024 * 100,
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || userId.length === 0) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
        captureAccountStoredContentCompatibilityForHttpRequest(request);
    });
    enableErrorHandlers(typed);
    registerAccountEncryptionMigrateRoutes(typed);
    return typed;
}

function currentCompatibilityHeaders() {
    return buildAccountStoredContentCompatibilityHttpHeadersV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    );
}

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function readSessionMigrationState(accountId: string) {
    const [account, sessions, changes, snapshots] = await Promise.all([
        db.account.findUniqueOrThrow({
            where: { id: accountId },
            select: {
                seq: true,
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                updatedAt: true,
                publicKey: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                settings: true,
                settingsVersion: true,
            },
        }),
        db.session.findMany({
            where: { accountId },
            orderBy: { tag: "asc" },
            select: {
                id: true,
                tag: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
                archivedAt: true,
                seq: true,
            },
        }),
        db.accountChange.findMany({
            where: { accountId },
            orderBy: { cursor: "asc" },
            select: {
                cursor: true,
                kind: true,
                entityId: true,
                hint: true,
                changedAt: true,
            },
        }),
        db.accountSettingsSnapshot.findMany({
            where: { accountId },
            orderBy: { version: "asc" },
            select: {
                version: true,
                settingsDbValue: true,
                encryptionMode: true,
                contentKind: true,
            },
        }),
    ]);
    return { account, sessions, changes, snapshots };
}

async function createE2eeSessionInventoryFixture() {
    const account = await db.account.create({
        data: {
            ...createSignedAccountContentBinding(),
            encryptionMode: "e2ee",
            settings: "ciphertext",
            settingsVersion: 0,
        },
        select: {
            id: true,
            seq: true,
            publicKey: true,
            contentPublicKey: true,
        },
    });
    const sourceOwnerMetadata = createEncryptedOwnerEnvelope(23);
    const targetOwnerMetadata =
        createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });
    const sessions = await Promise.all([
        db.session.create({
            data: {
                accountId: account.id,
                tag: "active-layout-1",
                metadata: "active-source-metadata",
                metadataVersion: 3,
                metadataLayoutVersion: 1,
                ownerMetadata:
                    encodeSessionOwnerMetadataEnvelopeV1(
                        sourceOwnerMetadata,
                    ),
                agentState: "active-source-agent",
                agentStateVersion: 4,
                archivedAt: null,
            },
        }),
        db.session.create({
            data: {
                accountId: account.id,
                tag: "archived-layout-1",
                metadata: "archived-source-metadata",
                metadataVersion: 5,
                metadataLayoutVersion: 1,
                ownerMetadata:
                    encodeSessionOwnerMetadataEnvelopeV1(
                        sourceOwnerMetadata,
                    ),
                agentState: "archived-source-agent",
                agentStateVersion: 6,
                archivedAt: new Date(1_700_000_000_000),
            },
        }),
    ]);
    const fingerprints =
        deriveAccountEncryptionMigrationKeyFingerprints(account);
    const request = {
        toMode: "plain" as const,
        expectedAccountVersion: account.seq,
        expectedSigningKeyFingerprint:
            fingerprints.signingKeyFingerprint,
        expectedContentKeyFingerprint:
            fingerprints.contentKeyFingerprint,
        expectedSettingsVersion: 0,
        settingsContent: {
            t: "plain" as const,
            v: { schemaVersion: 2 },
        },
        connectedServices: { action: "assert_empty" as const },
        automations: { action: "assert_empty" as const },
        machines: { action: "assert_empty" as const },
        todos: { action: "assert_empty" as const },
        artifacts: { action: "assert_empty" as const },
        sessions: {
            action: "migrate" as const,
            items: sessions.map((session) => ({
                sessionId: session.id,
                expectedMetadataLayoutVersion: 1 as const,
                expectedMetadataVersion: session.metadataVersion,
                expectedAgentStateVersion:
                    session.agentStateVersion,
                expectedOwnerMetadata: sourceOwnerMetadata,
                ownerMetadata: targetOwnerMetadata,
            })),
        },
        ...EMPTY_AMENDMENT9_DIRECTIVES,
    };
    return {
        account,
        sessions,
        sourceOwnerMetadata,
        targetOwnerMetadata,
        request,
    };
}

function sqliteString(value: string): string {
    return `'${value.split("'").join("''")}'`;
}

async function installSessionBeforeAccountModeTrigger(params: Readonly<{
    accountId: string;
    targetOwnerMetadata: SessionOwnerMetadataEnvelopeV1;
}>): Promise<() => Promise<void>> {
    const triggerName =
        `account_session_before_mode_${randomUUID().split("-").join("")}`;
    const targetOwnerMetadata = sqliteString(
        encodeSessionOwnerMetadataEnvelopeV1(
            params.targetOwnerMetadata,
        ),
    );
    await db.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}"
        BEFORE UPDATE OF "encryptionMode" ON "Account"
        FOR EACH ROW
        WHEN OLD."id" = ${sqliteString(params.accountId)}
            AND OLD."encryptionMode" = 'e2ee'
            AND NEW."encryptionMode" = 'plain'
            AND (
                SELECT COUNT(*)
                FROM "Session"
                WHERE "accountId" = ${sqliteString(params.accountId)}
                    AND "metadataLayoutVersion" = 1
                    AND "ownerMetadata" = ${targetOwnerMetadata}
            ) = 2
        BEGIN
            SELECT RAISE(
                ABORT,
                'intentional final Account mode failure'
            );
        END
    `);
    return async () => {
        await db.$executeRawUnsafe(
            `DROP TRIGGER IF EXISTS "${triggerName}"`,
        );
    };
}

describe("account encryption migration .7 SQLite matrix", () => {
    let harness: LightSqliteHarness;
    let ioTo: ReturnType<typeof vi.fn>;
    let socketEmit: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-encryption-migrate-v7-",
            initEncrypt: true,
            env: { HAPPIER_SQLITE_CONNECTION_LIMIT: "2" },
        });
    }, 120_000);

    beforeEach(() => {
        ioTo = vi.fn();
        socketEmit = vi.fn();
        ioTo.mockReturnValue({ emit: socketEmit });
        // Socket.IO is the genuine process boundary for the real event router.
        eventRouter.setIo(
            { to: ioTo } as unknown as Parameters<
                typeof eventRouter.setIo
            >[0],
        );
    });

    afterEach(async () => {
        eventRouter.clearIo();
        harness.resetEnv();
        await db.accountIdentity.deleteMany().catch(() => {});
        await db.repeatKey.deleteMany().catch(() => {});
        await db.session.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await harness.close();
    });

    it("migrates the complete active and archived layout-1 Session inventory before the Account mode", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 4,
            },
            select: {
                id: true,
                seq: true,
                publicKey: true,
                contentPublicKey: true,
            },
        });
        const sourceOwnerMetadata =
            sealSessionOwnerMetadataEnvelopeV1({
                material: SESSION_OWNER_MATERIAL,
                ownerMetadata: { v: 1 },
                randomBytes: (length) =>
                    new Uint8Array(length).fill(17),
            });
        const targetOwnerMetadata =
            createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });
        const archivedAt = new Date(1_700_000_000_000);
        const sessions = await Promise.all([
            db.session.create({
                data: {
                    accountId: account.id,
                    tag: "active-layout-1",
                    metadata: "active-shared-bytes",
                    metadataVersion: 5,
                    metadataLayoutVersion: 1,
                    ownerMetadata:
                        encodeSessionOwnerMetadataEnvelopeV1(
                            sourceOwnerMetadata,
                        ),
                    agentState: "active-agent-bytes",
                    agentStateVersion: 6,
                    archivedAt: null,
                },
            }),
            db.session.create({
                data: {
                    accountId: account.id,
                    tag: "archived-layout-1",
                    metadata: "archived-shared-bytes",
                    metadataVersion: 7,
                    metadataLayoutVersion: 1,
                    ownerMetadata:
                        encodeSessionOwnerMetadataEnvelopeV1(
                            sourceOwnerMetadata,
                        ),
                    agentState: "archived-agent-bytes",
                    agentStateVersion: 8,
                    archivedAt,
                },
            }),
        ]);
        const sharedRecipient = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        await Promise.all(sessions.map((session) =>
            db.sessionShare.create({
                data: {
                    sessionId: session.id,
                    sharedByUserId: account.id,
                    sharedWithUserId:
                        sharedRecipient.id,
                    accessLevel: "view",
                },
            })
        ));
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    ...buildAccountStoredContentCompatibilityHttpHeadersV1(
                        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                    ),
                },
                payload: {
                    toMode: "plain",
                    expectedAccountVersion: account.seq,
                    expectedSigningKeyFingerprint:
                        deriveAccountEncryptionMigrationKeyFingerprints(
                            account,
                        ).signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        deriveAccountEncryptionMigrationKeyFingerprints(
                            account,
                        ).contentKeyFingerprint,
                    expectedSettingsVersion: 4,
                    settingsContent: {
                        t: "plain",
                        v: { schemaVersion: 2 },
                    },
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                    sessions: {
                        action: "migrate",
                        items: sessions.map((session) => ({
                            sessionId: session.id,
                            expectedMetadataLayoutVersion: 1,
                            expectedMetadataVersion:
                                session.metadataVersion,
                            expectedAgentStateVersion:
                                session.agentStateVersion,
                            expectedOwnerMetadata:
                                sourceOwnerMetadata,
                            ownerMetadata: targetOwnerMetadata,
                        })),
                    },
                    ...EMPTY_AMENDMENT9_DIRECTIVES,
                },
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                success: true,
                mode: "plain",
                settingsVersion: 5,
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "plain",
                settingsVersion: 5,
            });
            await expect(db.session.findMany({
                where: { accountId: account.id },
                orderBy: { tag: "asc" },
                select: {
                    tag: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual([
                {
                    tag: "active-layout-1",
                    metadata: "active-shared-bytes",
                    metadataVersion: 5,
                    metadataLayoutVersion: 1,
                    ownerMetadata:
                        encodeSessionOwnerMetadataEnvelopeV1(
                            targetOwnerMetadata,
                        ),
                    agentState: "active-agent-bytes",
                    agentStateVersion: 6,
                    archivedAt: null,
                },
                {
                    tag: "archived-layout-1",
                    metadata: "archived-shared-bytes",
                    metadataVersion: 7,
                    metadataLayoutVersion: 1,
                    ownerMetadata:
                        encodeSessionOwnerMetadataEnvelopeV1(
                            targetOwnerMetadata,
                        ),
                    agentState: "archived-agent-bytes",
                    agentStateVersion: 8,
                    archivedAt,
                },
            ]);
            await expect(db.accountChange.findMany({
                where: {
                    accountId: account.id,
                    kind: "session",
                },
                orderBy: { entityId: "asc" },
                select: { entityId: true },
            })).resolves.toEqual(
                sessions
                    .map((session) => ({
                        entityId: session.id,
                    }))
                    .sort((left, right) =>
                        left.entityId.localeCompare(
                            right.entityId,
                        )),
            );
            await expect(db.accountChange.count({
                where: {
                    accountId: sharedRecipient.id,
                },
            })).resolves.toBe(0);
            const emissions = socketEmit.mock.calls.map(
                ([eventName, payload], index) => {
                    const body =
                        payload
                        && typeof payload === "object"
                        && "body" in payload
                        && payload.body
                        && typeof payload.body === "object"
                            ? payload.body
                            : null;
                    return {
                        eventName,
                        body,
                        roomTarget: ioTo.mock.calls[index]?.[0],
                    };
                },
            );
            const sessionEmissions = emissions.filter(
                (emission) => emission.body?.t === "update-session",
            );
            expect(sessionEmissions).toHaveLength(sessions.length);
            expect(
                emissions.filter(
                    (emission) =>
                        emission.body?.t === "account-settings-changed",
                ),
            ).toHaveLength(1);
            const accountChangeWakes = emissions.filter(
                (emission) => emission.body?.t === "account-change",
            );
            expect(accountChangeWakes).toHaveLength(sessions.length + 1);
            for (const wake of accountChangeWakes) {
                expect(wake).toMatchObject({
                    eventName: "update",
                    body: { t: "account-change" },
                    roomTarget: `account-stored-content-v3:${account.id}`,
                });
                expect(wake.body).toEqual({ t: "account-change" });
            }
            const roomTargets = sessionEmissions.map(
                ({ roomTarget }) => roomTarget,
            );
            for (const session of sessions) {
                expect(roomTargets).toContainEqual([
                    `session:${session.id}:${account.id}`,
                    `user-scoped:${account.id}`,
                ]);
            }
            expect(
                roomTargets.flatMap((target) =>
                    Array.isArray(target)
                        ? target
                        : [target]),
            ).not.toContain(
                `user-scoped:${sharedRecipient.id}`,
            );
        } finally {
            await app.close();
        }
    });

    it("migrates the complete active and archived layout-1 Session inventory from plain to e2ee", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const signing = tweetnacl.sign.keyPair();
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(
                    new Uint8Array(signing.publicKey),
                ),
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 2,
            },
            select: {
                id: true,
                seq: true,
                publicKey: true,
                contentPublicKey: true,
            },
        });
        const sourceOwnerMetadata =
            createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });
        const targetOwnerMetadata =
            createEncryptedOwnerEnvelope(29);
        const archivedAt = new Date(1_700_000_100_000);
        const sessions = await Promise.all([
            db.session.create({
                data: {
                    accountId: account.id,
                    tag: "active-layout-1",
                    metadata: "active-plain-shared",
                    metadataVersion: 9,
                    metadataLayoutVersion: 1,
                    ownerMetadata:
                        encodeSessionOwnerMetadataEnvelopeV1(
                            sourceOwnerMetadata,
                        ),
                    agentState: "active-plain-agent",
                    agentStateVersion: 10,
                    archivedAt: null,
                },
            }),
            db.session.create({
                data: {
                    accountId: account.id,
                    tag: "archived-layout-1",
                    metadata: "archived-plain-shared",
                    metadataVersion: 11,
                    metadataLayoutVersion: 1,
                    ownerMetadata:
                        encodeSessionOwnerMetadataEnvelopeV1(
                            sourceOwnerMetadata,
                        ),
                    agentState: "archived-plain-agent",
                    agentStateVersion: 12,
                    archivedAt,
                },
            }),
        ]);
        const contentBinding =
            createSignedContentKeyBinding(signing.secretKey);
        const fingerprints =
            deriveAccountEncryptionMigrationKeyFingerprints(account);
        const unsignedRequest = {
            toMode: "e2ee",
            expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint:
                fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint:
                fingerprints.contentKeyFingerprint,
            expectedSettingsVersion: 2,
            settingsContent: null,
            connectedServices: { action: "assert_empty" },
            automations: { action: "assert_empty" },
            machines: { action: "assert_empty" },
            todos: { action: "assert_empty" },
            artifacts: { action: "assert_empty" },
            sessions: {
                action: "migrate",
                items: sessions.map((session) => ({
                    sessionId: session.id,
                    expectedMetadataLayoutVersion: 1 as const,
                    expectedMetadataVersion:
                        session.metadataVersion,
                    expectedAgentStateVersion:
                        session.agentStateVersion,
                    expectedOwnerMetadata:
                        sourceOwnerMetadata,
                    ownerMetadata: targetOwnerMetadata,
                })),
            },
            ...EMPTY_AMENDMENT9_DIRECTIVES,
            keyProof: {
                v: 1,
                publicKey: privacyKit.encodeBase64(
                    new Uint8Array(signing.publicKey),
                ),
                ...contentBinding,
            },
        } satisfies AccountEncryptionMigrateUnsignedRequest;
        const request = signPlainToE2eeRequest({
            accountId: account.id,
            request: unsignedRequest,
            signingSecretKey: signing.secretKey,
        });
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: request,
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                success: true,
                mode: "e2ee",
                settingsVersion: 3,
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settingsVersion: 3,
            });
            await expect(db.session.findMany({
                where: { accountId: account.id },
                orderBy: { tag: "asc" },
                select: {
                    tag: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual([
                {
                    tag: "active-layout-1",
                    metadata: "active-plain-shared",
                    metadataVersion: 9,
                    metadataLayoutVersion: 1,
                    ownerMetadata:
                        encodeSessionOwnerMetadataEnvelopeV1(
                            targetOwnerMetadata,
                        ),
                    agentState: "active-plain-agent",
                    agentStateVersion: 10,
                    archivedAt: null,
                },
                {
                    tag: "archived-layout-1",
                    metadata: "archived-plain-shared",
                    metadataVersion: 11,
                    metadataLayoutVersion: 1,
                    ownerMetadata:
                        encodeSessionOwnerMetadataEnvelopeV1(
                            targetOwnerMetadata,
                        ),
                    agentState: "archived-plain-agent",
                    agentStateVersion: 12,
                    archivedAt,
                },
            ]);
        } finally {
            await app.close();
        }
    });

    it("rolls back Session rewrites and publishes no changes when Settings rejects nullness after the Session directive", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const fixture =
            await createE2eeSessionInventoryFixture();
        const request = {
            ...fixture.request,
            settingsContent: null,
        };
        const before =
            await readSessionMigrationState(fixture.account.id);
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: request,
            });
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            await expect(
                readSessionMigrationState(fixture.account.id),
            ).resolves.toEqual(before);
            expect(ioTo).not.toHaveBeenCalled();
            expect(socketEmit).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("returns the exact lost-response replay result for a committed nonempty Session migration with zero writes or events", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const fixture =
            await createE2eeSessionInventoryFixture();
        const protocolRequestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                accountId: fixture.account.id,
                sourceMode: "e2ee",
                request: fixture.request,
            });
        const app = createTestApp();
        await app.ready();

        try {
            const first = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: fixture.request,
            });
            expect(first.statusCode, first.body).toBe(200);
            const firstBody = first.json();
            const committed =
                await readSessionMigrationState(
                    fixture.account.id,
                );
            const finalChange = committed.changes.find(
                (change) =>
                    change.kind === "account"
                    && change.entityId === "self",
            );
            expect(finalChange?.cursor).toBe(
                committed.account.seq,
            );
            expect(finalChange?.hint).toMatchObject({
                settingsVersion:
                    committed.account.settingsVersion,
                sourceAccountVersion:
                    fixture.account.seq,
                accountEncryptionMigrationReplayBinding:
                    expect.stringMatching(
                        /^aemrsb1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u,
                    ),
            });
            const persistedChangeBytes =
                JSON.stringify(committed.changes);
            expect(persistedChangeBytes).not.toContain(
                protocolRequestDigest,
            );
            expect(persistedChangeBytes).not.toContain(
                "ownerMetadata",
            );
            expect(socketEmit).toHaveBeenCalled();
            ioTo.mockClear();
            socketEmit.mockClear();

            const replay = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: fixture.request,
            });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(firstBody);
            await expect(
                readSessionMigrationState(fixture.account.id),
            ).resolves.toEqual(committed);
            expect(ioTo).not.toHaveBeenCalled();
            expect(socketEmit).not.toHaveBeenCalled();

            const changedRequest = {
                ...fixture.request,
                sessions: {
                    ...fixture.request.sessions,
                    items:
                        fixture.request.sessions.items.map(
                            (item, index) =>
                                index === 0
                                    ? {
                                        ...item,
                                        expectedMetadataVersion:
                                            item.expectedMetadataVersion
                                            + 1,
                                    }
                                    : item,
                        ),
                },
            };
            const changed = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: changedRequest,
            });
            expect(changed.statusCode, changed.body).toBe(400);
            expect(changed.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            await expect(
                readSessionMigrationState(fixture.account.id),
            ).resolves.toEqual(committed);
            expect(ioTo).not.toHaveBeenCalled();
            expect(socketEmit).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("consumes a fresh external-auth proof exactly once for first-key enrollment and recognizes only the exact read-only replay", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true, seq: true },
        });
        const providerUserId = "v7-first-key-provider-user";
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId,
                profile: {},
            },
        });
        const signing = tweetnacl.sign.keyPair();
        const contentBinding =
            createSignedContentKeyBinding(signing.secretKey);
        const unsignedWithoutExternalAuth = {
            toMode: "e2ee",
            expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint: null,
            expectedContentKeyFingerprint: null,
            expectedSettingsVersion: 0,
            settingsContent: null,
            connectedServices: { action: "assert_empty" },
            automations: { action: "assert_empty" },
            machines: { action: "assert_empty" },
            todos: { action: "assert_empty" },
            artifacts: { action: "assert_empty" },
            sessions: { action: "assert_empty" },
            ...EMPTY_AMENDMENT9_DIRECTIVES,
            keyProof: {
                v: 1,
                publicKey: privacyKit.encodeBase64(
                    new Uint8Array(signing.publicKey),
                ),
                ...contentBinding,
            },
        } satisfies AccountEncryptionMigrateUnsignedRequest;
        const requestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                accountId: account.id,
                sourceMode: "plain",
                request: unsignedWithoutExternalAuth,
            });
        const proof = "v7-fresh-browser-proof";
        const pending = "oauth_pending_v7firstkeyproof";
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    v: 3,
                    flow: "auth",
                    purpose:
                        "account_encryption_first_key",
                    provider: "github",
                    userId: account.id,
                    providerUserId,
                    proofHash: createHash("sha256")
                        .update(proof, "utf8")
                        .digest("hex"),
                    requestDigest,
                }),
                expiresAt:
                    new Date(Date.now() + 60_000),
            },
        });
        const unsignedRequest = {
            ...unsignedWithoutExternalAuth,
            externalAuthProof: {
                provider: "github",
                pending,
                proof,
            },
        } satisfies AccountEncryptionMigrateUnsignedRequest;
        const request = signPlainToE2eeRequest({
            accountId: account.id,
            request: unsignedRequest,
            signingSecretKey: signing.secretKey,
        });
        const app = createTestApp();
        await app.ready();

        try {
            const first = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: request,
            });
            expect(first.statusCode, first.body).toBe(200);
            const firstBody = first.json();
            await expect(db.repeatKey.findUnique({
                where: { key: pending },
            })).resolves.toBeNull();
            const committed =
                await readSessionMigrationState(account.id);
            expect(committed.account).toMatchObject({
                encryptionMode: "e2ee",
                settingsVersion: 1,
            });
            expect(
                JSON.stringify(committed.changes),
            ).not.toContain(requestDigest);
            expect(socketEmit).toHaveBeenCalled();
            ioTo.mockClear();
            socketEmit.mockClear();

            const replay = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: request,
            });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(firstBody);
            await expect(db.repeatKey.findUnique({
                where: { key: pending },
            })).resolves.toBeNull();
            await expect(
                readSessionMigrationState(account.id),
            ).resolves.toEqual(committed);
            expect(ioTo).not.toHaveBeenCalled();
            expect(socketEmit).not.toHaveBeenCalled();

            const changedUnsignedRequest = {
                ...unsignedRequest,
                settingsContent: {
                    t: "encrypted",
                    c: "different-bound-settings",
                },
            } satisfies AccountEncryptionMigrateUnsignedRequest;
            const changedRequest =
                signPlainToE2eeRequest({
                    accountId: account.id,
                    request: changedUnsignedRequest,
                    signingSecretKey:
                        signing.secretKey,
                });
            const changed = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: changedRequest,
            });
            expect(changed.statusCode, changed.body).toBe(400);
            expect(changed.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            await expect(db.repeatKey.findUnique({
                where: { key: pending },
            })).resolves.toBeNull();
            await expect(
                readSessionMigrationState(account.id),
            ).resolves.toEqual(committed);
            expect(ioTo).not.toHaveBeenCalled();
            expect(socketEmit).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("applies every Session rewrite before the final Account mode mutation and rolls all bytes back when that database boundary fails", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const fixture =
            await createE2eeSessionInventoryFixture();
        const before =
            await readSessionMigrationState(fixture.account.id);
        const removeTrigger =
            await installSessionBeforeAccountModeTrigger({
                accountId: fixture.account.id,
                targetOwnerMetadata:
                    fixture.targetOwnerMetadata,
            });
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: fixture.request,
            });
            expect(response.statusCode, response.body).toBe(500);
            expect(response.json()).toEqual({
                error: "internal",
            });
        } finally {
            await removeTrigger();
            await app.close();
        }
        await expect(
            readSessionMigrationState(fixture.account.id),
        ).resolves.toEqual(before);
    });

    it("rejects a Session inventory above the canonical bound before any database mutation", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const fixture =
            await createE2eeSessionInventoryFixture();
        const before =
            await readSessionMigrationState(fixture.account.id);
        fixture.request.sessions.items = Array.from(
            {
                length:
                    ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS
                    + 1,
            },
            (_, index) => ({
                ...fixture.request.sessions.items[0]!,
                sessionId: `session-overflow-${index}`,
            }),
        );
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: fixture.request,
            });
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
            });
            await expect(
                readSessionMigrationState(fixture.account.id),
            ).resolves.toEqual(before);
        } finally {
            await app.close();
        }
    });

    it.each([
        "owner",
        "shared_editor",
    ] as const)("serializes a concurrent %s writer and rejects the stale migration inventory without overwriting the writer", async (
        writerMode,
    ) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const fixture =
            await createE2eeSessionInventoryFixture();
        const active = fixture.sessions.find(
            (session) => session.tag === "active-layout-1",
        )!;
        const editor = writerMode === "shared_editor"
            ? await db.account.create({
                data: {
                    ...createSignedAccountContentBinding(),
                    encryptionMode: "e2ee",
                },
                select: { id: true },
            })
            : null;
        if (editor) {
            await db.sessionShare.create({
                data: {
                    sessionId: active.id,
                    sharedByUserId: fixture.account.id,
                    sharedWithUserId: editor.id,
                    accessLevel: "edit",
                },
            });
        }
        const writerAcquired = deferred();
        const releaseWriter = deferred();
        const writerTargetOwner =
            createEncryptedOwnerEnvelope(37);
        const writer = inTx(async (tx) => {
            const result =
                await updateSessionMetadataEnvelopeTupleInTx(
                    tx,
                    writerMode === "owner"
                        ? {
                            mode: "owner",
                            actorUserId: fixture.account.id,
                            sessionId: active.id,
                            metadataLayoutVersion: 1,
                            expectedOwnerMetadata:
                                fixture.sourceOwnerMetadata,
                            sharedMetadata: {
                                ciphertext:
                                    "owner-writer-shared",
                                expectedVersion:
                                    active.metadataVersion,
                            },
                            ownerMetadata:
                                writerTargetOwner,
                            agentState: {
                                ciphertext:
                                    "owner-writer-agent",
                                expectedVersion:
                                    active.agentStateVersion,
                            },
                        }
                        : {
                            mode: "shared_editor",
                            actorUserId: editor!.id,
                            sessionId: active.id,
                            metadataLayoutVersion: 1,
                            sharedMetadata: {
                                ciphertext:
                                    "shared-editor-writer",
                                expectedVersion:
                                    active.metadataVersion,
                            },
                        },
                );
            expect(result).toMatchObject({ ok: true });
            writerAcquired.resolve();
            await releaseWriter.promise;
        });
        await writerAcquired.promise;

        const app = createTestApp();
        await app.ready();
        let migrationSettled = false;
        const migration = app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": fixture.account.id,
                ...currentCompatibilityHeaders(),
            },
            payload: fixture.request,
        }).then((response: Readonly<{
            statusCode: number;
            body: string;
            json: () => unknown;
        }>) => {
            migrationSettled = true;
            return response;
        });

        try {
            await new Promise((resolve) =>
                setTimeout(resolve, 100));
            expect(migrationSettled).toBe(false);
            releaseWriter.resolve();
            await writer;
            const afterWriter =
                await readSessionMigrationState(
                    fixture.account.id,
                );

            const response = await migration;
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            await expect(
                readSessionMigrationState(fixture.account.id),
            ).resolves.toEqual(afterWriter);
            expect(afterWriter.account.encryptionMode).toBe("e2ee");
            expect(
                afterWriter.sessions.find(
                    (session) => session.id === active.id,
                ),
            ).toMatchObject({
                metadata:
                    writerMode === "owner"
                        ? "owner-writer-shared"
                        : "shared-editor-writer",
                metadataVersion: active.metadataVersion + 1,
                ownerMetadata:
                    writerMode === "owner"
                        ? encodeSessionOwnerMetadataEnvelopeV1(
                            writerTargetOwner,
                        )
                        : active.ownerMetadata,
                agentState:
                    writerMode === "owner"
                        ? "owner-writer-agent"
                        : active.agentState,
            });
        } finally {
            releaseWriter.resolve();
            await writer;
            await app.close();
        }
    }, 30_000);

    it.each([
        {
            name: "stale metadata version",
            mutate: (
                fixture: Awaited<
                    ReturnType<typeof createE2eeSessionInventoryFixture>
                >,
            ) => {
                fixture.request.sessions.items[0]!
                    .expectedMetadataVersion += 1;
            },
        },
        {
            name: "stale agent-state version",
            mutate: (
                fixture: Awaited<
                    ReturnType<typeof createE2eeSessionInventoryFixture>
                >,
            ) => {
                fixture.request.sessions.items[0]!
                    .expectedAgentStateVersion += 1;
            },
        },
        {
            name: "stale source owner bytes",
            mutate: (
                fixture: Awaited<
                    ReturnType<typeof createE2eeSessionInventoryFixture>
                >,
            ) => {
                fixture.request.sessions.items[0]!
                    .expectedOwnerMetadata =
                        createEncryptedOwnerEnvelope(31);
            },
        },
        {
            name: "missing inventory item",
            mutate: (
                fixture: Awaited<
                    ReturnType<typeof createE2eeSessionInventoryFixture>
                >,
            ) => {
                fixture.request.sessions.items.pop();
            },
        },
        {
            name: "extra nonexistent inventory item",
            mutate: (
                fixture: Awaited<
                    ReturnType<typeof createE2eeSessionInventoryFixture>
                >,
            ) => {
                fixture.request.sessions.items.push({
                    ...fixture.request.sessions.items[0]!,
                    sessionId:
                        "00000000-0000-4000-8000-000000000001",
                });
            },
        },
        {
            name: "duplicate inventory item",
            mutate: (
                fixture: Awaited<
                    ReturnType<typeof createE2eeSessionInventoryFixture>
                >,
            ) => {
                fixture.request.sessions.items.push({
                    ...fixture.request.sessions.items[0]!,
                });
            },
        },
    ])("rejects $name without changing any Account or Session bytes", async ({
        mutate,
    }) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const fixture =
            await createE2eeSessionInventoryFixture();
        const before =
            await readSessionMigrationState(fixture.account.id);
        mutate(fixture);
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                    ...currentCompatibilityHeaders(),
                },
                payload: fixture.request,
            });
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            await expect(
                readSessionMigrationState(fixture.account.id),
            ).resolves.toEqual(before);
        } finally {
            await app.close();
        }
    });
});
