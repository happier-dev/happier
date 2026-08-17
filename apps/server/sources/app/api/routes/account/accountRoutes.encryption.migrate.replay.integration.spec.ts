import Fastify from "fastify";
import { createHash } from "node:crypto";
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
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    attachAccountEncryptionMigrateProofSignatureV1,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    createAccountEncryptionMigrateProofSigningInputV1,
    createAccountEncryptionMigrateRequestBindingDigestV1,
    type AccountEncryptionMigrateRequest,
    type AccountEncryptionMigrateUnsignedRequest,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";
import {
    captureAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    createAccountEncryptionMigrationReplayBindingV1,
} from "@/app/encryption/accountEncryptionMigrationReplayBindingV1";
import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { registerAccountEncryptionMigrateRoutes } from "./registerAccountEncryptionMigrateRoutes";

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function createSignedContentKeyBinding(
    signingSecretKey: Uint8Array,
) {
    const contentKeyPair = tweetnacl.box.keyPair();
    const contentPublicKeySig = tweetnacl.sign.detached(
        Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(contentKeyPair.publicKey),
        ]),
        signingSecretKey,
    );
    return {
        contentPublicKey:
            privacyKit.encodeBase64(
                copyBytes(contentKeyPair.publicKey),
            ),
        contentPublicKeySig:
            privacyKit.encodeBase64(
                copyBytes(contentPublicKeySig),
            ),
        contentPublicKeyBytes:
            new Uint8Array(contentKeyPair.publicKey),
        contentPublicKeySigBytes:
            new Uint8Array(contentPublicKeySig),
    };
}

function signPlainToE2eeRequest(params: Readonly<{
    accountId: string;
    signingSecretKey: Uint8Array;
    request: AccountEncryptionMigrateUnsignedRequest;
}>): AccountEncryptionMigrateRequest {
    const signingInput =
        createAccountEncryptionMigrateProofSigningInputV1({
            accountId: params.accountId,
            sourceMode: "plain",
            request: params.request,
        });
    return attachAccountEncryptionMigrateProofSignatureV1({
        request: params.request,
        signature: privacyKit.encodeBase64(
            copyBytes(
                tweetnacl.sign.detached(
                    signingInput,
                    params.signingSecretKey,
                ),
            ),
        ),
    });
}

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = (
        app.withTypeProvider<ZodTypeProvider>() as unknown
    ) as Parameters<
        typeof registerAccountEncryptionMigrateRoutes
    >[0];
    typed.decorate("authenticate", async (
        request: { headers: Record<string, unknown>; userId?: string },
        reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    ) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });
    typed.addHook("preValidation", async (request) => {
        captureAccountStoredContentCompatibilityForHttpRequest(request);
    });
    enableErrorHandlers(typed);
    registerAccountEncryptionMigrateRoutes(typed);
    return typed;
}

describe("Account encryption migration exact replay", () => {
    let harness: LightSqliteHarness;
    let ioTo: ReturnType<typeof vi.fn>;
    let socketEmit: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix:
                "happier-account-encryption-migrate-replay-",
        });
    }, 120_000);

    beforeEach(() => {
        ioTo = vi.fn();
        socketEmit = vi.fn();
        ioTo.mockReturnValue({ emit: socketEmit });
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
        await db.accountSettingsSnapshot.deleteMany().catch(() => {});
        await db.accountChange.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.automation.deleteMany().catch(() => {});
        await db.artifact.deleteMany().catch(() => {});
        await db.userKVStore.deleteMany().catch(() => {});
        await db.session.deleteMany().catch(() => {});
        await db.machine.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await harness.close();
    });

    it("returns exact e2ee-to-plain lost-response replay success without writes or events", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const signingKeyPair = tweetnacl.sign.keyPair();
        const publicKeyHex =
            Buffer.from(signingKeyPair.publicKey).toString("hex");
        const expectedSigningKeyFingerprint =
            computeAccountEncryptionMigrateKeyFingerprintV1(
                signingKeyPair.publicKey,
            );
        const targetSettings = {
            t: "plain" as const,
            v: { replayed: true },
        };
        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex,
                encryptionMode: "plain",
                // Intermediate domain publications may allocate any positive
                // number of cursors before the final account/self hint.
                seq: 7,
                settings: JSON.stringify(targetSettings),
                settingsVersion: 1,
            },
            select: { id: true },
        });
        const request = {
            toMode: "plain",
            expectedAccountVersion: 0,
            expectedSigningKeyFingerprint,
            expectedContentKeyFingerprint: null,
            expectedSettingsVersion: 0,
            settingsContent: targetSettings,
            connectedServices: { action: "assert_empty" },
            automations: { action: "assert_empty" },
            machines: { action: "assert_empty" },
            todos: { action: "assert_empty" },
            artifacts: { action: "assert_empty" },
            sessions: { action: "assert_empty" },
            reviewComments: { action: "assert_empty" },
            sessionOrganization: { action: "assert_empty" },
            pets: { action: "assert_empty" },
        } satisfies AccountEncryptionMigrateRequest;
        const protocolRequestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                accountId: account.id,
                sourceMode: "e2ee",
                request,
            });
        const accountEncryptionMigrationReplayBinding =
            createAccountEncryptionMigrationReplayBindingV1({
                accountId: account.id,
                protocolRequestDigest,
            });
        await db.accountChange.create({
            data: {
                accountId: account.id,
                kind: "account",
                entityId: "self",
                cursor: 7,
                hint: {
                    settingsVersion: 1,
                    sourceAccountVersion: 0,
                    accountEncryptionMigrationReplayBinding,
                },
            },
        });

        const before = await Promise.all([
            db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    seq: true,
                    publicKey: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                    encryptionMode: true,
                    encryptionModeUpdatedAt: true,
                    settings: true,
                    settingsVersion: true,
                    updatedAt: true,
                },
            }),
            db.accountChange.findMany({
                where: { accountId: account.id },
                select: {
                    cursor: true,
                    kind: true,
                    entityId: true,
                    hint: true,
                    changedAt: true,
                },
            }),
            db.accountSettingsSnapshot.findMany({
                where: { accountId: account.id },
            }),
        ]);
        const app = createTestApp();
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]:
                        String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: request,
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({
                success: true,
                mode: "plain",
                accountVersion: 7,
                settingsVersion: 1,
            });
            const after = await Promise.all([
                db.account.findUniqueOrThrow({
                    where: { id: account.id },
                    select: {
                        seq: true,
                        publicKey: true,
                        contentPublicKey: true,
                        contentPublicKeySig: true,
                        encryptionMode: true,
                        encryptionModeUpdatedAt: true,
                        settings: true,
                        settingsVersion: true,
                        updatedAt: true,
                    },
                }),
                db.accountChange.findMany({
                    where: { accountId: account.id },
                    select: {
                        cursor: true,
                        kind: true,
                        entityId: true,
                        hint: true,
                        changedAt: true,
                    },
                }),
                db.accountSettingsSnapshot.findMany({
                    where: { accountId: account.id },
                }),
            ]);
            expect(after).toEqual(before);
            expect(ioTo).not.toHaveBeenCalled();
            expect(socketEmit).not.toHaveBeenCalled();

            const readReplayState = async () =>
                await Promise.all([
                    db.account.findUniqueOrThrow({
                        where: { id: account.id },
                    }),
                    db.accountChange.findMany({
                        where: { accountId: account.id },
                    }),
                    db.accountSettingsSnapshot.findMany({
                        where: { accountId: account.id },
                    }),
                    db.userKVStore.findMany({
                        where: { accountId: account.id },
                    }),
                ]);
            const expectRejectedWithoutMutation = async (
                payload: AccountEncryptionMigrateRequest = request,
            ) => {
                const beforeRejectedReplay =
                    await readReplayState();
                const rejected = await app.inject({
                    method: "POST",
                    url: "/v1/account/encryption/migrate",
                    headers: {
                        [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]:
                            String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload,
                });
                expect(
                    rejected.statusCode,
                    rejected.body,
                ).toBe(400);
                expect(rejected.json()).toEqual({
                    error: "invalid-params",
                    reason: "migration_inventory_changed",
                });
                expect(await readReplayState())
                    .toEqual(beforeRejectedReplay);
                expect(ioTo).not.toHaveBeenCalled();
                expect(socketEmit).not.toHaveBeenCalled();
            };
            const canonicalHint = {
                settingsVersion: 1,
                sourceAccountVersion: 0,
                accountEncryptionMigrationReplayBinding,
            };
            const writeAccountChange = async (
                hint: object,
                cursor = 7,
            ) => {
                await db.accountChange.upsert({
                    where: {
                        accountId_kind_entityId: {
                            accountId: account.id,
                            kind: "account",
                            entityId: "self",
                        },
                    },
                    create: {
                        accountId: account.id,
                        kind: "account",
                        entityId: "self",
                        cursor,
                        hint,
                    },
                    update: { cursor, hint },
                });
            };

            await expectRejectedWithoutMutation({
                ...request,
                settingsContent: {
                    t: "plain",
                    v: { replayed: false },
                },
            });
            for (const invalidHint of [
                {
                    settingsVersion: 1,
                    sourceAccountVersion: 0,
                },
                {
                    ...canonicalHint,
                    accountEncryptionMigrationReplayBinding:
                        "aemrsb1_malformed",
                },
                {
                    ...canonicalHint,
                    accountEncryptionMigrationReplayBinding:
                        protocolRequestDigest,
                },
                {
                    ...canonicalHint,
                    sourceAccountVersion: 9,
                },
                {
                    settingsVersion: 1,
                    overwritten: true,
                },
            ]) {
                await writeAccountChange(invalidHint);
                await expectRejectedWithoutMutation();
            }
            await writeAccountChange(canonicalHint, 0);
            await expectRejectedWithoutMutation();

            await db.accountChange.delete({
                where: {
                    accountId_kind_entityId: {
                        accountId: account.id,
                        kind: "account",
                        entityId: "self",
                    },
                },
            });
            await expectRejectedWithoutMutation();
            await writeAccountChange(canonicalHint);

            await db.account.update({
                where: { id: account.id },
                data: {
                    settings: JSON.stringify({
                        t: "plain",
                        v: { replayed: "tampered" },
                    }),
                },
            });
            await expectRejectedWithoutMutation();
            await db.account.update({
                where: { id: account.id },
                data: {
                    settings: JSON.stringify(targetSettings),
                },
            });

            await db.userKVStore.create({
                data: {
                    accountId: account.id,
                    key: "todo.replay-mismatch",
                    value: Buffer.from("unexpected"),
                },
            });
            await expectRejectedWithoutMutation();
        } finally {
            await app.close();
        }
    });

    it("validates the original e2ee key proof before recognizing a keyless plain-to-e2ee replay", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const signingKeyPair = tweetnacl.sign.keyPair();
        const contentKeyBinding =
            createSignedContentKeyBinding(signingKeyPair.secretKey);
        const publicKeyHex =
            privacyKit.encodeHex(
                copyBytes(signingKeyPair.publicKey),
            );
        const targetSettingsCiphertext = "target-settings-ciphertext";
        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex,
                contentPublicKey:
                    contentKeyBinding.contentPublicKeyBytes,
                contentPublicKeySig:
                    contentKeyBinding.contentPublicKeySigBytes,
                encryptionMode: "e2ee",
                seq: 1,
                settings: targetSettingsCiphertext,
                settingsVersion: 1,
            },
            select: { id: true },
        });
        const unsignedRequest = {
            toMode: "e2ee",
            expectedAccountVersion: 0,
            expectedSigningKeyFingerprint: null,
            expectedContentKeyFingerprint: null,
            expectedSettingsVersion: 0,
            settingsContent: {
                t: "encrypted",
                c: targetSettingsCiphertext,
            },
            connectedServices: { action: "assert_empty" },
            automations: { action: "assert_empty" },
            machines: { action: "assert_empty" },
            todos: { action: "assert_empty" },
            artifacts: { action: "assert_empty" },
            sessions: { action: "assert_empty" },
            reviewComments: { action: "assert_empty" },
            sessionOrganization: { action: "assert_empty" },
            pets: { action: "assert_empty" },
            externalAuthProof: {
                provider: "github",
                pending: "already-consumed-pending",
                proof: "already-consumed-proof",
            },
            keyProof: {
                v: 1,
                publicKey:
                    privacyKit.encodeBase64(
                        copyBytes(signingKeyPair.publicKey),
                    ),
                contentPublicKey:
                    contentKeyBinding.contentPublicKey,
                contentPublicKeySig:
                    contentKeyBinding.contentPublicKeySig,
            },
        } satisfies AccountEncryptionMigrateUnsignedRequest;
        const request = signPlainToE2eeRequest({
            accountId: account.id,
            signingSecretKey: signingKeyPair.secretKey,
            request: unsignedRequest,
        });
        const protocolRequestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                accountId: account.id,
                sourceMode: "plain",
                request,
            });
        await db.accountChange.create({
            data: {
                accountId: account.id,
                kind: "account",
                entityId: "self",
                cursor: 1,
                hint: {
                    settingsVersion: 1,
                    sourceAccountVersion: 0,
                    accountEncryptionMigrationReplayBinding:
                        createAccountEncryptionMigrationReplayBindingV1({
                            accountId: account.id,
                            protocolRequestDigest,
                        }),
                },
            },
        });
        const before = await Promise.all([
            db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    seq: true,
                    publicKey: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                    encryptionMode: true,
                    encryptionModeUpdatedAt: true,
                    settings: true,
                    settingsVersion: true,
                    updatedAt: true,
                },
            }),
            db.accountChange.findMany({
                where: { accountId: account.id },
                select: {
                    cursor: true,
                    hint: true,
                    changedAt: true,
                },
            }),
        ]);
        const app = createTestApp();
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]:
                        String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: request,
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({
                success: true,
                mode: "e2ee",
                accountVersion: 1,
                settingsVersion: 1,
            });
            const after = await Promise.all([
                db.account.findUniqueOrThrow({
                    where: { id: account.id },
                    select: {
                        seq: true,
                        publicKey: true,
                        contentPublicKey: true,
                        contentPublicKeySig: true,
                        encryptionMode: true,
                        encryptionModeUpdatedAt: true,
                        settings: true,
                        settingsVersion: true,
                        updatedAt: true,
                    },
                }),
                db.accountChange.findMany({
                    where: { accountId: account.id },
                    select: {
                        cursor: true,
                        hint: true,
                        changedAt: true,
                    },
                }),
            ]);
            expect(after).toEqual(before);
            expect(ioTo).not.toHaveBeenCalled();
            expect(socketEmit).not.toHaveBeenCalled();

            const expectRejectedWithoutMutation = async (
                payload: AccountEncryptionMigrateRequest,
                expectedReason:
                    | "migration_inventory_changed"
                    | "restore_required" =
                        "migration_inventory_changed",
            ) => {
                const beforeRejectedReplay = await Promise.all([
                    db.account.findUniqueOrThrow({
                        where: { id: account.id },
                    }),
                    db.accountChange.findMany({
                        where: { accountId: account.id },
                    }),
                ]);
                const rejected = await app.inject({
                    method: "POST",
                    url: "/v1/account/encryption/migrate",
                    headers: {
                        [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]:
                            String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload,
                });
                expect(
                    rejected.statusCode,
                    rejected.body,
                ).toBe(400);
                expect(rejected.json()).toEqual({
                    error: "invalid-params",
                    reason: expectedReason,
                });
                expect(await Promise.all([
                    db.account.findUniqueOrThrow({
                        where: { id: account.id },
                    }),
                    db.accountChange.findMany({
                        where: { accountId: account.id },
                    }),
                ])).toEqual(beforeRejectedReplay);
                expect(ioTo).not.toHaveBeenCalled();
                expect(socketEmit).not.toHaveBeenCalled();
            };
            await expectRejectedWithoutMutation({
                ...request,
                keyProof: {
                    ...request.keyProof!,
                    signature: privacyKit.encodeBase64(
                        new Uint8Array(
                            tweetnacl.sign.signatureLength,
                        ),
                    ),
                },
            });
            const otherKeyPair = tweetnacl.sign.keyPair();
            await db.account.update({
                where: { id: account.id },
                data: {
                    publicKey: privacyKit.encodeHex(
                        copyBytes(otherKeyPair.publicKey),
                    ),
                },
            });
            await expectRejectedWithoutMutation(
                request,
                "restore_required",
            );
        } finally {
            await app.close();
        }
    });

    it("rolls fresh first-key proof consumption back when Session admission rejects", async () => {
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
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "replay-rollback-user",
                profile: {},
            },
        });
        const signingKeyPair = tweetnacl.sign.keyPair();
        const contentKeyBinding =
            createSignedContentKeyBinding(signingKeyPair.secretKey);
        const pending = "oauth_pending_replayrollback1";
        const proof = "fresh-replay-rollback-proof";
        const unsignedRequest = {
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
            reviewComments: { action: "assert_empty" },
            sessionOrganization: { action: "assert_empty" },
            pets: { action: "assert_empty" },
            externalAuthProof: {
                provider: "github",
                pending,
                proof,
            },
            keyProof: {
                v: 1,
                publicKey: privacyKit.encodeBase64(
                    copyBytes(signingKeyPair.publicKey),
                ),
                contentPublicKey:
                    contentKeyBinding.contentPublicKey,
                contentPublicKeySig:
                    contentKeyBinding.contentPublicKeySig,
            },
        } satisfies AccountEncryptionMigrateUnsignedRequest;
        const request = signPlainToE2eeRequest({
            accountId: account.id,
            signingSecretKey: signingKeyPair.secretKey,
            request: unsignedRequest,
        });
        const requestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                request,
                accountId: account.id,
                sourceMode: "plain",
            });
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
                    providerUserId:
                        "replay-rollback-user",
                    proofHash: createHash("sha256")
                        .update(proof, "utf8")
                        .digest("hex"),
                    requestDigest,
                }),
                expiresAt:
                    new Date(Date.now() + 60_000),
            },
        });
        const blockingSession = await db.session.create({
            data: {
                accountId: account.id,
                tag: "first-key-rejection",
                metadata: "shared",
                metadataLayoutVersion: 1,
                ownerMetadata: "owner",
            },
            select: { id: true },
        });
        const app = createTestApp();
        await app.ready();
        const inject = async () => await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: {
                [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]:
                    String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: request,
        });
        try {
            const rejected = await inject();
            expect(rejected.statusCode, rejected.body).toBe(400);
            expect(rejected.json()).toEqual({
                error:
                    "metadata_privacy_upgrade_required",
            });
            expect(await db.repeatKey.findUnique({
                where: { key: pending },
            })).not.toBeNull();
            expect(await db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    publicKey: true,
                    seq: true,
                },
            })).toEqual({
                encryptionMode: "plain",
                publicKey: null,
                seq: account.seq,
            });

            await db.session.delete({
                where: { id: blockingSession.id },
            });
            const retried = await inject();
            expect(retried.statusCode, retried.body).toBe(200);
            expect(retried.json()).toEqual({
                success: true,
                mode: "e2ee",
                accountVersion: account.seq + 1,
                settingsVersion: 1,
            });
            expect(await db.repeatKey.findUnique({
                where: { key: pending },
            })).toBeNull();
        } finally {
            await app.close();
        }
    });
});
