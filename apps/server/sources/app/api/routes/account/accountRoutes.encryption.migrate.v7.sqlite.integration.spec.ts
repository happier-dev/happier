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
    signAccountContentKeyBindingV1,
    attachAccountEncryptionMigrateProofSignatureV1,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    createPlainSessionOwnerMetadataEnvelopeV1,
    createAccountEncryptionMigrateProofSigningInputV1,
    createAccountEncryptionMigrateRequestBindingDigestV1,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    encodeSessionOwnerMetadataEnvelopeV1,
    sealSessionOwnerMetadataEnvelopeV1,
    sealAccountScopedBlobCiphertext,
    type AccountEncryptionMigrateRequest,
    type AccountEncryptionMigrateUnsignedRequest,
    type SessionOwnerMetadataEnvelopeV1,
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
    sealEncryptedDataKeyEnvelopeV1,
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
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
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
import { openArtifactStoredContentBytes, storePlainArtifactDbBytes } from "@/app/artifacts/artifactStoredContent";
import { prepareArtifactBlobWrite, completeArtifactBlobCandidateCustodyInTx, openArtifactBlobBytes } from '@/app/artifacts/artifactBlobService';
import { stageArtifactBlobAccountEncryptionConversion } from '@/app/artifacts/artifactEncryptionConversionBlobService';
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

function encryptedAuthoringMemoryContent() {
    return { t: "encrypted" as const, c: sealAccountScopedBlobCiphertext({
        kind: "authoring_memory",
        material: SESSION_OWNER_MATERIAL,
        payload: { key: "lastUsedProfile", value: "profile-a" },
        randomBytes: (length) => new Uint8Array(length).fill(29),
    }) };
}

function createSignedContentKeyBinding(
    signingSecretKey: Uint8Array,
): Readonly<{
    contentPublicKey: string;
    contentPublicKeySig: string;
}> {
    const contentKey = tweetnacl.box.keyPair();
    const signature = signAccountContentKeyBindingV1({
        accountSigningSecretKey: signingSecretKey,
        contentPublicKey: contentKey.publicKey,
    });
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
        // Authentication is the genuine boundary replaced by this route
        // harness; these migration cases exercise an admitted Account owner.
        request.authAuthority = "present_user";
        request.authTokenKind = "account";
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
            initFiles: true,
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

    it.each(['text', 'binary'] as const)("preserves retained Artifact %s bodies through plain to E2EE to plain transitions and exact replay", async kind => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: "server_sealed",
        });
        const signing = tweetnacl.sign.keyPair();
        const binding = createSignedContentKeyBinding(signing.secretKey);
        const account = await db.account.create({ data: {
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
            contentPublicKey: Buffer.from(binding.contentPublicKey, "base64"),
            contentPublicKeySig: Buffer.from(binding.contentPublicKeySig, "base64"), encryptionMode: "plain",
        } });
        const artifactId = randomUUID();
        const privateBlobs = [Uint8Array.of(0, 255, 12), Uint8Array.of(255, 0, 128)].map(bytes => ({ blobId: randomUUID(), bytes }));
        const binaryBody = (index: number) => ({ blobId: privateBlobs[index]!.blobId, mime: 'application/octet-stream',
            sizeBytes: privateBlobs[index]!.bytes.length, sha256: createHash('sha256').update(privateBlobs[index]!.bytes).digest('hex') });
        const plainHeader = encodePlainArtifactStoredContent({ title: "History" });
        const plainBody = encodePlainArtifactStoredContent({ body: kind === 'binary' ? binaryBody(0) : 'Current' });
        const plainRevision = encodePlainArtifactStoredContent({ body: kind === 'binary' ? binaryBody(1) : 'Retained private body' });
        const sealPlain = (field: "header" | "body", value: string) => storePlainArtifactDbBytes({
            accountId: account.id, artifactId, field, content: Buffer.from(value, "base64"),
        })!;
        await db.artifact.create({ data: { id: artifactId, accountId: account.id,
            header: sealPlain("header", plainHeader), body: sealPlain("body", plainBody),
            headerVersion: 1, bodyVersion: 3, dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"),
            currentBlobId: kind === 'binary' ? privateBlobs[0]!.blobId : null,
            revisions: { create: [{ bodyVersion: 1, body: sealPlain("body", plainRevision), createdAt: new Date(1234),
                blobId: kind === 'binary' ? privateBlobs[1]!.blobId : null }] },
        } });
        if (kind === 'binary') for (const blob of privateBlobs) {
            const prepared = await prepareArtifactBlobWrite({ accountId: account.id, artifactId,
                blob: { blobId: blob.blobId, content: { t: 'plain', v: Buffer.from(blob.bytes).toString('base64') } } });
            await inTx(async tx => { await tx.artifactBlob.create({ data: prepared!.row }); await completeArtifactBlobCandidateCustodyInTx(tx, prepared!); });
        }
        // The server's E2EE boundary is deliberately opaque. Client codec
        // round-trip tests separately prove these replacement bodies are opened.
        const encryptedKey = privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: new Uint8Array(32).fill(27), recipientPublicKey: privacyKit.decodeBase64(binding.contentPublicKey),
            randomBytes: length => new Uint8Array(length).fill(29),
        })));
        const encryptedHeader = privacyKit.encodeBase64(new Uint8Array([2, 11, 12]));
        const encryptedBody = privacyKit.encodeBase64(new Uint8Array([2, 21, 22]));
        const encryptedRevision = privacyKit.encodeBase64(new Uint8Array([2, 31, 32]));
        const app = createTestApp();
        try {
            for (const toMode of ["e2ee", "plain"] as const) {
                const sourceAccount = await db.account.findUniqueOrThrow({ where: { id: account.id } });
                const source = await db.artifact.findUniqueOrThrow({ where: { id: artifactId }, include: { revisions: true } });
                const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(sourceAccount);
                const convertedBlobs = kind === 'binary' ? await Promise.all(privateBlobs.map(async blob => {
                    const row = await db.artifactBlob.findUniqueOrThrow({ where: { id: blob.blobId } });
                    const sourceBytes = await openArtifactBlobBytes(account.id, row);
                    const content = toMode === 'plain' ? { t: 'plain' as const, v: Buffer.from(blob.bytes).toString('base64') }
                        : { t: 'encrypted' as const, c: Buffer.from(Uint8Array.of(2, ...blob.bytes)).toString('base64') };
                    return { blobId: blob.blobId, expectedContentSha256: createHash('sha256').update(sourceBytes).digest('hex'),
                        content: await stageArtifactBlobAccountEncryptionConversion({ accountId: account.id, artifactId, blobId: blob.blobId, content }) };
                })) : [];
                const unsigned = {
                    toMode, expectedAccountVersion: sourceAccount.seq,
                    expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
                    expectedSettingsVersion: sourceAccount.settingsVersion, settingsContent: null,
                    connectedServices: { action: "assert_empty" as const }, automations: { action: "assert_empty" as const },
                    machines: { action: "assert_empty" as const }, todos: { action: "assert_empty" as const },
                    sessions: { action: "assert_empty" as const }, ...EMPTY_AMENDMENT9_DIRECTIVES,
                    artifacts: { action: "migrate" as const, items: [{ artifactId,
                        expectedHeaderVersion: source.headerVersion, expectedBodyVersion: source.bodyVersion,
                        expectedDataEncryptionKey: privacyKit.encodeBase64(new Uint8Array(source.dataEncryptionKey)), recipientKeyEnvelopes: [],
                        header: toMode === "plain" ? plainHeader : encryptedHeader,
                        body: toMode === "plain" ? plainBody : encryptedBody,
                        dataEncryptionKey: toMode === "plain" ? ARTIFACT_PLAIN_DATA_KEY_MARKER : encryptedKey,
                        blobs: convertedBlobs,
                        revisions: [{ bodyVersion: 1, expectedBody: toMode === "plain" ? encryptedRevision : plainRevision,
                            body: toMode === "plain" ? plainRevision : encryptedRevision }],
                    }] },
                };
                const payload = toMode === "e2ee" ? signPlainToE2eeRequest({ accountId: account.id,
                    signingSecretKey: signing.secretKey, request: { ...unsigned, keyProof: {
                        v: 1, publicKey: privacyKit.encodeBase64(new Uint8Array(signing.publicKey)), ...binding,
                    } } }) : unsigned;
                const options = { method: "POST" as const, url: "/v1/account/encryption/migrate",
                    headers: { "x-test-user-id": account.id, ...currentCompatibilityHeaders() }, payload };
                const response = await app.inject(options);
                expect(response.statusCode, response.body).toBe(200);
                const committed = await db.artifact.findUniqueOrThrow({ where: { id: artifactId }, include: { revisions: true } });
                expect(committed.revisions).toHaveLength(1);
                const revision = committed.revisions[0]!;
                expect(revision.bodyVersion).toBe(1);
                expect(revision.createdAt).toEqual(new Date(1234));
                expect(privacyKit.encodeBase64(openArtifactStoredContentBytes({ accountId: account.id, artifactId,
                    mode: toMode, field: "body", dataEncryptionKey: committed.dataEncryptionKey, content: revision.body })!))
                    .toBe(toMode === "plain" ? plainRevision : encryptedRevision);
                if (toMode === "plain") expect(Buffer.from(revision.body).toString("utf8")).toContain('"sealed_v1"');
                const replay = await app.inject(options);
                expect(replay.statusCode, replay.body).toBe(200);
                expect(replay.json()).toEqual(response.json());
                expect(await db.artifact.findUniqueOrThrow({ where: { id: artifactId }, include: { revisions: true } }))
                    .toEqual(committed);
            }
        } finally { await app.close(); }
    });

    it.each(["body", "added_revision", "document_quota", "account_quota"] as const)("rejects retained Artifact %s without replacing the head or Account mode", async (drift) => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1", HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: "none" });
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const artifactId = randomUUID();
        const sourceBody = Buffer.from([2, 1, 2]);
        const sourceKey = Buffer.from([3, 4, 5]);
        await db.artifact.create({ data: { id: artifactId, accountId: account.id,
            header: Buffer.from([2, 3, 4]), body: Buffer.from([2, 5, 6]), headerVersion: 1, bodyVersion: 3,
            dataEncryptionKey: sourceKey, revisions: { create: [{ bodyVersion: 1, body: sourceBody }] } } });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
        const payload = { toMode: "plain" as const, expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint, expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
            expectedSettingsVersion: 0, settingsContent: null, connectedServices: { action: "assert_empty" as const },
            automations: { action: "assert_empty" as const }, machines: { action: "assert_empty" as const }, todos: { action: "assert_empty" as const },
            sessions: { action: "assert_empty" as const }, ...EMPTY_AMENDMENT9_DIRECTIVES,
            artifacts: { action: "migrate" as const, items: [{ artifactId, expectedHeaderVersion: 1, expectedBodyVersion: 3,
                expectedDataEncryptionKey: privacyKit.encodeBase64(sourceKey), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                recipientKeyEnvelopes: [], blobs: [], header: encodePlainArtifactStoredContent({ title: "Target" }),
                body: encodePlainArtifactStoredContent({ body: "Current" }), revisions: [{ bodyVersion: 1,
                    expectedBody: privacyKit.encodeBase64(sourceBody), body: encodePlainArtifactStoredContent({ body: "Retained" }) }] }] } };
        if (drift === "body") await db.artifactRevision.update({ where: { artifactId_bodyVersion: { artifactId, bodyVersion: 1 } }, data: { body: Buffer.from([2, 7, 8]) } });
        else if (drift === "added_revision") await db.artifactRevision.create({ data: { artifactId, bodyVersion: 2, body: Buffer.from([2, 9, 10]) } });
        const item = payload.artifacts.items[0]!;
        const headBytes = Buffer.from(item.header, "base64").byteLength + Buffer.from(item.body, "base64").byteLength;
        const convertedDocumentBytes = headBytes + Buffer.from(item.revisions[0]!.body, "base64").byteLength;
        if (drift === "account_quota") {
            const otherArtifactId = randomUUID();
            await db.artifact.create({ data: { id: otherArtifactId, accountId: account.id,
                header: Buffer.from([2, 3, 4]), body: Buffer.from([2, 5, 6]), headerVersion: 1, bodyVersion: 3,
                dataEncryptionKey: sourceKey, revisions: { create: [{ bodyVersion: 1, body: sourceBody }] } } });
            payload.artifacts.items.push({ ...item, artifactId: otherArtifactId });
        }
        // Both byte budgets include the retained physical content.
        // Each Account replacement fits alone; their combined growth does not.
        const limitBytes = drift === "document_quota" ? convertedDocumentBytes - 1 : convertedDocumentBytes * 2 - 1;
        if (drift === "document_quota") process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES = String(limitBytes);
        if (drift === "account_quota") process.env.HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES = String(limitBytes);
        const before = await db.artifact.findMany({ where: { accountId: account.id }, orderBy: { id: "asc" }, include: { revisions: true } });
        const app = createTestApp();
        try {
            const response = await app.inject({ method: "POST", url: "/v1/account/encryption/migrate",
                headers: { "x-test-user-id": account.id, ...currentCompatibilityHeaders() }, payload });
            if (drift.endsWith("_quota")) {
                expect(response.statusCode, response.body).toBe(413);
                expect(response.json()).toEqual({ error: "quota_exceeded", budget: drift === "account_quota" ? "account" : "document",
                    limitBytes, usedBytes: drift === "account_quota" ? convertedDocumentBytes * 2 : convertedDocumentBytes });
            } else {
                expect(response.statusCode, response.body).toBe(400);
                expect(response.json()).toEqual({ error: "invalid-params", reason: "migration_inventory_changed" });
            }
            expect(await db.artifact.findMany({ where: { accountId: account.id }, orderBy: { id: "asc" }, include: { revisions: true } })).toEqual(before);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toEqual(account);
        } finally { await app.close(); }
    });

    it.each(["plain", "e2ee"] as const)("reseals Account authoring memory atomically and replays the exact result (%s source)", async (fromMode) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
        });
        const signing = tweetnacl.sign.keyPair();
        const binding = createSignedContentKeyBinding(signing.secretKey);
        const account = await db.account.create({ data: {
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
            contentPublicKey: Buffer.from(binding.contentPublicKey, "base64"),
            contentPublicKeySig: Buffer.from(binding.contentPublicKeySig, "base64"),
            encryptionMode: fromMode,
            settings: null,
        } });
        const key = "lastUsedProfile";
        const physicalKey = `@happier/account/authoring-memory/v1/${key}`;
        const source = fromMode === "plain"
            ? { t: "plain" as const, v: "profile-a" }
            : encryptedAuthoringMemoryContent();
        await db.userKVStore.create({ data: {
            accountId: account.id, key: physicalKey, version: 3,
            value: new TextEncoder().encode(JSON.stringify(source)),
        } });
        const toMode: "plain" | "e2ee" = fromMode === "plain" ? "e2ee" : "plain";
        const content = toMode === "plain"
            ? { t: "plain" as const, v: "profile-a" }
            : encryptedAuthoringMemoryContent();
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
        const base = {
            toMode,
            expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
            expectedSettingsVersion: 0,
            settingsContent: null,
            connectedServices: { action: "assert_empty" as const },
            automations: { action: "assert_empty" as const },
            machines: { action: "assert_empty" as const },
            todos: { action: "assert_empty" as const },
            artifacts: { action: "assert_empty" as const },
            sessions: { action: "assert_empty" as const },
            ...EMPTY_AMENDMENT9_DIRECTIVES,
            authoringMemory: { items: [{ key, expectedRevision: 3, content }] },
        };
        const buildRequest = (candidate: typeof base | Omit<typeof base, "authoringMemory">) => toMode === "e2ee" ? signPlainToE2eeRequest({
            accountId: account.id, signingSecretKey: signing.secretKey,
            request: { ...candidate, keyProof: {
                v: 1, publicKey: privacyKit.encodeBase64(new Uint8Array(signing.publicKey)), ...binding,
            } },
        }) : candidate;
        const request = buildRequest(base);
        const app = createTestApp();
        try {
            const options = {
                method: "POST" as const, url: "/v1/account/encryption/migrate",
                headers: { "x-test-user-id": account.id, ...currentCompatibilityHeaders() },
                payload: request,
            };
            const { authoringMemory: _memory, ...missingInventory } = base;
            for (const invalid of [missingInventory, { ...base, authoringMemory: { items: [] } }, {
                ...base, authoringMemory: { items: [{ key, expectedRevision: 2, content }] },
            }]) {
                const rejected = await app.inject({ ...options, payload: buildRequest(invalid) });
                expect(rejected.statusCode).toBe(400);
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe(fromMode);
                expect((await db.userKVStore.findUniqueOrThrow({ where: {
                    accountId_key: { accountId: account.id, key: physicalKey },
                } })).version).toBe(3);
            }
            const wrongMode = await app.inject({ ...options, payload: buildRequest({
                ...base, authoringMemory: { items: [{ key, expectedRevision: 3, content: source }] },
            }) });
            expect(wrongMode.statusCode).toBe(400);
            // A stored source envelope inconsistent with the persisted mode
            // must not be silently overwritten as part of a mode transition.
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: physicalKey } },
                data: { value: new TextEncoder().encode(JSON.stringify(content)) },
            });
            const corruptSource = await app.inject(options);
            expect(corruptSource.statusCode).toBe(400);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe(fromMode);
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: physicalKey } },
                data: { value: new TextEncoder().encode(JSON.stringify(source)) },
            });
            const response = await app.inject(options);
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ mode: toMode, authoringMemory: {
                rows: [{ key, revision: 4, content }],
            } });
            const committed = await db.userKVStore.findUniqueOrThrow({ where: {
                accountId_key: { accountId: account.id, key: physicalKey },
            } });
            expect(JSON.parse(new TextDecoder().decode(committed.value!))).toEqual(content);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe(toMode);
            socketEmit.mockClear();
            const replay = await app.inject(options);
            expect(replay.statusCode).toBe(200);
            expect(replay.json()).toEqual(response.json());
            expect(socketEmit).not.toHaveBeenCalled();
            expect(await db.userKVStore.findUniqueOrThrow({ where: {
                accountId_key: { accountId: account.id, key: physicalKey },
            } })).toEqual(committed);
        } finally {
            await app.close();
        }
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
        const ownerSocketId = "migration-owner-socket";
        eventRouter.setIo({
            to: ioTo,
            in: vi.fn().mockReturnValue({
                fetchSockets: async () => [{
                    id: ownerSocketId,
                    data: {
                        userId: account.id,
                        clientType: "user-scoped",
                        authAuthority: "present_user",
                        authTokenAuthenticationEvidence: undefined,
                    },
                }],
            }),
        } as unknown as Parameters<typeof eventRouter.setIo>[0]);
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
            await vi.waitFor(() => {
                const deliveredSessionUpdates = socketEmit.mock.calls.filter(
                    ([, payload]) => payload?.body?.t === "update-session",
                );
                expect(deliveredSessionUpdates).toHaveLength(sessions.length);
            });
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
            const connectionTargets = sessionEmissions.map(
                ({ roomTarget }) => roomTarget,
            );
            expect(connectionTargets).toEqual(
                sessions.map(() => ownerSocketId),
            );
            expect(connectionTargets).not.toContain(
                `user-scoped:${sharedRecipient.id}`,
            );
        } finally {
            await app.close();
        }
    });

    it("completes the real Account migration entry point beyond the former 500-Session ceiling", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const fixture = await createE2eeSessionInventoryFixture();
        const encodedSource = encodeSessionOwnerMetadataEnvelopeV1(
            fixture.sourceOwnerMetadata,
        );
        await db.session.createMany({
            data: Array.from({ length: 499 }, (_, index) => ({
                accountId: fixture.account.id,
                tag: `overflow-layout-1-${index}`,
                metadata: "overflow-source-metadata",
                metadataVersion: 1,
                metadataLayoutVersion: 1,
                ownerMetadata: encodedSource,
                agentState: null,
                agentStateVersion: 1,
                archivedAt: null,
            })),
        });
        const overflowSessions = await db.session.findMany({
            where: {
                accountId: fixture.account.id,
                tag: { startsWith: "overflow-layout-1-" },
            },
            select: {
                id: true,
                metadataVersion: true,
                agentStateVersion: true,
            },
        });
        fixture.request.sessions.items.push(
            ...overflowSessions.map((session) => ({
                sessionId: session.id,
                expectedMetadataLayoutVersion: 1 as const,
                expectedMetadataVersion: session.metadataVersion,
                expectedAgentStateVersion: session.agentStateVersion,
                expectedOwnerMetadata: fixture.sourceOwnerMetadata,
                ownerMetadata: fixture.targetOwnerMetadata,
            })),
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
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                success: true,
                mode: "plain",
            });
            await expect(db.session.count({
                where: {
                    accountId: fixture.account.id,
                    ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(
                        fixture.targetOwnerMetadata,
                    ),
                },
            })).resolves.toBe(501);
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
        const memory = await db.userKVStore.create({ data: {
            accountId: fixture.account.id,
            key: "@happier/account/authoring-memory/v1/lastUsedProfile",
            version: 3,
            value: new TextEncoder().encode(JSON.stringify(encryptedAuthoringMemoryContent())),
        } });
        const request = {
            ...fixture.request,
            settingsContent: null,
            authoringMemory: { items: [{ key: "lastUsedProfile", expectedRevision: 3, content: { t: "plain", v: "profile-a" } }] },
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
            await expect(db.userKVStore.findUniqueOrThrow({ where: { accountId_key: {
                accountId: fixture.account.id, key: memory.key,
            } } })).resolves.toEqual(memory);
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
                    securityBinding: {
                        provider: (await resolveOAuthRuntimeById(process.env, "github"))!.reference,
                        connection: null,
                        admission: null,
                        purpose: "account_encryption_first_key",
                    },
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
                            authentication: {
                                env: process.env,
                                authority: "present_user",
                                authenticationEvidence: undefined,
                            },
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
