import Fastify from "fastify";
import { createHash, randomUUID } from "node:crypto";
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
    signAccountContentKeyBindingV1,
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
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { registerAccountEncryptionMigrateRoutes } from "./registerAccountEncryptionMigrateRoutes";
import { mutateSessionDraft, readSessionDraft } from "@/app/account/sessionDrafts/sessionDraftService";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { updateAccountEncryptionMode } from './updateAccountEncryptionMode';

const authentication = createPresentUserSessionAccessAuthentication();

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function createSignedContentKeyBinding(
    signingSecretKey: Uint8Array,
) {
    const contentKeyPair = tweetnacl.box.keyPair();
    const contentPublicKeySig = signAccountContentKeyBindingV1({
        accountSigningSecretKey: signingSecretKey,
        contentPublicKey: contentKeyPair.publicKey,
    });
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
        request: {
            headers: Record<string, unknown>;
            userId?: string;
            authAuthority?: "present_user";
            authTokenKind?: "account";
        },
        reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    ) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
        // Authentication is the genuine boundary replaced by this route harness.
        request.authAuthority = "present_user";
        request.authTokenKind = "account";
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
        await harness?.close();
    });

    it("returns capable drafts and migrates workspace and Coach rows atomically with exact read-only replay", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
        });
        const signing = tweetnacl.sign.keyPair();
        const binding = createSignedContentKeyBinding(signing.secretKey);
        const account = await db.account.create({ data: {
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            contentPublicKey: binding.contentPublicKeyBytes,
            contentPublicKeySig: binding.contentPublicKeySigBytes,
            encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0,
        } });
        const address = { kind: "newSession" as const, draftId: randomUUID() };
        const mutationId = randomUUID();
        const content = { t: "plain" as const, v: { v: 2 as const, address, document: {
            v: 2 as const,
            composer: {
                text: { mutationId, value: "Preserve this launch" },
                mentions: { mutationId, value: [] },
                attachments: { mutationId, value: [] },
            },
            target: { kind: "newSession" as const, authoring: { executionTarget: { mutationId, value: {
                kind: "temporary_computer", serverId: "home-a", artifactTarget: "linux-x64", workspace: { kind: "endpoint_home" },
            } } } },
            extensions: {},
        } } };
        expect(await mutateSessionDraft({
            accountId: account.id, address, expectedRevision: "absent",
            content: { t: "encrypted", v: 2, c: "source-ciphertext" },
            authentication,
        })).toMatchObject({ status: "updated", record: { revision: 0 } });
        const workspaceKeys = ['workspace:tabs:v1', 'workspace:handoff-tabs:v1:device:window'];
        const workspaceValue = privacyKit.encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { v: 1, tabsById: {}, order: [], pairs: [] } })));
        for (const key of workspaceKeys) await db.userKVStore.create({ data: { accountId: account.id, key, version: 4, value: new TextEncoder().encode('source-ciphertext') } });
        const tombstoneKey = 'workspace:handoff-tabs:v1:deleted:window';
        await db.userKVStore.create({ data: { accountId: account.id, key: tombstoneKey, version: 9, value: null } });
        const coachKey = 'workspace:usage-coach:suppressions';
        const coachValue = privacyKit.encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { v: 1, suppressions: [{ kind: 'dismissed', evidenceKey: 'dismissed' }] } })));
        await db.userKVStore.create({ data: { accountId: account.id, key: coachKey, version: 6, value: new TextEncoder().encode('source-coach-ciphertext') } });
        const currentAccount = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        const request = {
            toMode: "plain", expectedAccountVersion: currentAccount.seq,
            expectedSigningKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(signing.publicKey),
            expectedContentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(binding.contentPublicKeyBytes),
            expectedSettingsVersion: 0, settingsContent: { t: "plain", v: {} },
            connectedServices: { action: "assert_empty" }, automations: { action: "assert_empty" },
            machines: { action: "assert_empty" }, todos: { action: "assert_empty" }, artifacts: { action: "assert_empty" },
            sessions: { action: "assert_empty" }, reviewComments: { action: "assert_empty" },
            sessionOrganization: { action: "assert_empty" }, pets: { action: "assert_empty" },
            sessionDrafts: { v: 2, items: [{ address, expectedRevision: 0, content }] },
            workspace: { action: 'migrate', items: [...workspaceKeys.map(key => ({ key, expectedVersion: 4, value: workspaceValue })),
                { key: coachKey, expectedVersion: 6, value: coachValue }] },
        } satisfies AccountEncryptionMigrateRequest;
        const app = createTestApp();
        await app.ready();
        try {
            const invoke = (payload: AccountEncryptionMigrateRequest = request) => app.inject({
                method: "POST", url: "/v1/account/encryption/migrate",
                headers: {
                    [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                    "content-type": "application/json", "x-test-user-id": account.id,
                },
                payload,
            });
            const omittedInventory = await invoke({ ...request, workspace: { action: 'assert_empty' } });
            expect(omittedInventory.statusCode, omittedInventory.body).toBe(400);
            expect(await db.account.findUnique({ where: { id: account.id } })).toMatchObject({ encryptionMode: 'e2ee', settingsVersion: 0 });
            const { workspace: _workspace, ...olderRequest } = request;
            for (const candidate of [olderRequest, { ...request, workspace: { action: 'migrate' as const, items: request.workspace.items.filter(item => item.key !== coachKey) } }]) {
                const refused = await invoke(candidate);
                expect(refused.statusCode, refused.body).toBe(400);
                expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: account.id, key: coachKey } } })).toMatchObject({ version: 6 });
                expect(await db.account.findUnique({ where: { id: account.id } })).toMatchObject({ encryptionMode: 'e2ee', settingsVersion: 0 });
            }
            expect(await db.userKVStore.findMany({ where: { accountId: account.id, key: { in: workspaceKeys } } })).toEqual(expect.arrayContaining(workspaceKeys.map(key => expect.objectContaining({ key, version: 4 }))));
            const staleInventory = await invoke({ ...request, workspace: { action: 'migrate', items: request.workspace.items.map(item => ({ ...item, expectedVersion: item.expectedVersion - 1 })) } });
            expect(staleInventory.statusCode, staleInventory.body).toBe(400);
            expect(await db.account.findUnique({ where: { id: account.id } })).toMatchObject({ encryptionMode: 'e2ee', settingsVersion: 0 });
            const response = await invoke();
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                success: true, mode: "plain", sessionDrafts: { v: 2, records: [{ address, revision: 1, content }] },
            });
            expect(await db.userKVStore.findMany({ where: { accountId: account.id, key: { in: workspaceKeys } }, orderBy: { key: 'asc' }, select: { version: true, value: true } }))
                .toEqual(workspaceKeys.map(() => ({ version: 5, value: privacyKit.decodeBase64(workspaceValue) })));
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: account.id, key: tombstoneKey } } })).toMatchObject({ version: 9, value: null });
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: account.id, key: coachKey } } })).toMatchObject({ version: 7, value: privacyKit.decodeBase64(coachValue) });
            const beforeReplay = await readSessionDraft({ accountId: account.id, address, epoch: "v2", authentication });
            socketEmit.mockClear();
            const replay = await invoke();
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(response.json());
            expect(await readSessionDraft({ accountId: account.id, address, epoch: "v2", authentication })).toEqual(beforeReplay);
            expect(socketEmit).not.toHaveBeenCalled();
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: coachKey } }, data: { version: 8 } });
            const driftedReplay = await invoke();
            expect(driftedReplay.statusCode, driftedReplay.body).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('requires conversion before switching an Account with Coach suppression state directly', async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1' });
        const signing = tweetnacl.sign.keyPair();
        const account = await db.account.create({ data: { publicKey: Buffer.from(signing.publicKey).toString('hex'), encryptionMode: 'e2ee' } });
        await db.userKVStore.create({ data: { accountId: account.id, key: 'workspace:usage-coach:suppressions', version: 2, value: new TextEncoder().encode('source-coach-ciphertext') } });
        expect(await updateAccountEncryptionMode({ accountId: account.id, mode: 'plain' })).toEqual({ status: 'migration_required' });
        expect(await db.account.findUnique({ where: { id: account.id } })).toMatchObject({ encryptionMode: 'e2ee' });
    });

    it("rolls the migrated draft back when the Session inventory refuses the conversion", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
        });
        const signing = tweetnacl.sign.keyPair();
        const binding = createSignedContentKeyBinding(signing.secretKey);
        const account = await db.account.create({ data: {
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            contentPublicKey: binding.contentPublicKeyBytes,
            contentPublicKeySig: binding.contentPublicKeySigBytes,
            encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0,
        } });
        // A live Session makes the `assert_empty` inventory refuse, after the
        // draft writer in the same transaction has already run.
        await db.session.create({ data: {
            accountId: account.id,
            tag: "session-inventory-not-empty",
            metadata: "shared-before-migration",
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            agentState: null,
            agentStateVersion: 2,
        } });
        const address = { kind: "newSession" as const, draftId: randomUUID() };
        const mutationId = randomUUID();
        const content = { t: "plain" as const, v: { v: 2 as const, address, document: {
            v: 2 as const,
            composer: {
                text: { mutationId, value: "Preserve this launch" },
                mentions: { mutationId, value: [] },
                attachments: { mutationId, value: [] },
            },
            target: { kind: "newSession" as const, authoring: { executionTarget: { mutationId, value: {
                kind: "temporary_computer", serverId: "home-a", artifactTarget: "linux-x64", workspace: { kind: "endpoint_home" },
            } } } },
            extensions: {},
        } } };
        expect(await mutateSessionDraft({
            accountId: account.id, address, expectedRevision: "absent",
            content: { t: "encrypted", v: 2, c: "source-ciphertext" },
            authentication,
        })).toMatchObject({ status: "updated", record: { revision: 0 } });
        const beforeConversion = await readSessionDraft({ accountId: account.id, address, epoch: "v2", authentication });
        const currentAccount = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        const request = {
            toMode: "plain", expectedAccountVersion: currentAccount.seq,
            expectedSigningKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(signing.publicKey),
            expectedContentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(binding.contentPublicKeyBytes),
            expectedSettingsVersion: 0, settingsContent: { t: "plain", v: {} },
            connectedServices: { action: "assert_empty" }, automations: { action: "assert_empty" },
            machines: { action: "assert_empty" }, todos: { action: "assert_empty" }, artifacts: { action: "assert_empty" },
            sessions: { action: "assert_empty" }, reviewComments: { action: "assert_empty" },
            sessionOrganization: { action: "assert_empty" }, pets: { action: "assert_empty" },
            sessionDrafts: { v: 2, items: [{ address, expectedRevision: 0, content }] },
        } satisfies AccountEncryptionMigrateRequest;
        const app = createTestApp();
        await app.ready();
        try {
            // The draft this test rolls back was published when it was written;
            // only the refused conversion's own events are under assertion.
            socketEmit.mockClear();
            const response = await app.inject({
                method: "POST", url: "/v1/account/encryption/migrate",
                headers: {
                    [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                    "content-type": "application/json", "x-test-user-id": account.id,
                },
                payload: request,
            });
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: "metadata_privacy_upgrade_required" });
            expect(await readSessionDraft({ accountId: account.id, address, epoch: "v2", authentication }))
                .toEqual(beforeConversion);
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { encryptionMode: true, settings: true, settingsVersion: true },
            })).resolves.toEqual({ encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 });
            expect(socketEmit).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
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
            GITHUB_CLIENT_ID: "client",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://api.example.test/v1/oauth/github/callback",
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
                    securityBinding: {
                        provider: (await resolveOAuthRuntimeById(process.env, "github"))!.reference,
                        connection: null,
                        admission: null,
                        purpose: "account_encryption_first_key",
                    },
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
