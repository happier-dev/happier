import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from "@happier-dev/protocol";

import { createDbMocks, createDbTransactionMock, installDbModuleMock, matchesDbMockWhere, inTxPostgresControlStatementMock } from "../../testkit/dbMocks";
import { isPrismaErrorCode } from '@/storage/prismaErrors';
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { homeConfigSnapshotPostgresQueryMock } from '@/app/home/settings/homeConfigSnapshot.testkit';
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

let auth: typeof import("@/app/auth/auth").auth;

const dbMocks = createDbMocks({
    account: ["create", "findUnique"],
    machine: ["create", "findFirst"],
    accessKey: ["create", "findUnique"],
    ephemeralRunnerActivation: ["create", "findFirst"],
    accountApiToken: ["create", "findUnique", "updateMany"],
    homeSettings: ["findUnique"],
    homeGovernancePolicy: ["findUnique"],
    publicSessionShare: ["findUnique"],
    session: ["create", "findFirst", "findUnique"],
    sessionMessage: ["findMany"],
} as const);
const txDbMocks = createDbMocks({
    account: ["findUnique", "findUniqueOrThrow"],
    publicSessionShare: ["findUnique", "update", "updateMany"],
    session: ["findUnique"],
    sessionMessage: ["findMany"],
    publicShareAccessLog: ["create"],
} as const);
const dbTransaction = createDbTransactionMock(() => ({
    ...inTxPostgresControlStatementMock,
    homeSettings: dbMocks.db.homeSettings,
    homeGovernancePolicy: dbMocks.db.homeGovernancePolicy,
    account: txDbMocks.db.account,
    publicSessionShare: txDbMocks.db.publicSessionShare,
    session: txDbMocks.db.session,
    sessionMessage: txDbMocks.db.sessionMessage,
    publicShareAccessLog: txDbMocks.db.publicShareAccessLog,
    accountApiToken: dbMocks.db.accountApiToken,
    $queryRawUnsafe: async (query: string, accountId: string) => query.includes('FROM (SELECT 1) AS singleton')
        ? homeConfigSnapshotPostgresQueryMock.$queryRawUnsafe.call(dbMocks.db, query, accountId)
        : [{ id: accountId }],
}));

// The storage adapter alone is substituted: issuance/verification, transaction
// lifecycle, access logging and metadata/profile projection run their real owners.
const accessLogCreate = txDbMocks.db.publicShareAccessLog.create;
const ownerProfile = { name: null, firstName: null, lastName: null, username: null, avatar: null };

// Retain rows written by the canonical credential producers; never fabricate a
// verifier result. Prisma IO is the substituted boundary, using its shared matcher.
function retainCredentialRows() {
    for (const model of [dbMocks.db.account, dbMocks.db.machine, dbMocks.db.accessKey,
        dbMocks.db.ephemeralRunnerActivation, dbMocks.db.session, dbMocks.db.accountApiToken]) {
        const rows: Record<string, unknown>[] = [];
        model.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: crypto.randomUUID(), tokenEpoch: 0, status: "active",
                revokedAt: null, replacedByMachineId: null, lastUsedAt: null,
                parentTokenId: null, parent: null, embedConfig: null, authenticationEvidence: null,
                Account: { status: "active" }, ...data };
            rows.push(row);
            return row;
        });
        const read = async ({ where }: { where: Record<string, unknown> }) => {
            const predicate = "accountId_machineId_sessionId" in where ? where.accountId_machineId_sessionId : where;
            return rows.find(row => matchesDbMockWhere(row, predicate)) ?? null;
        };
        if ("findFirst" in model) model.findFirst.mockImplementation(read);
        if ("findUnique" in model && model !== dbMocks.db.session) model.findUnique.mockImplementation(read);
    }
}

installDbModuleMock(() => ({
    isPrismaErrorCode,
    // The Home configuration snapshot is one statement on PostgreSQL and runs on the primary client.
    db: Object.assign(dbTransaction.wrapDb(dbMocks.db), {
        $queryRawUnsafe: (query: string, id: string) => homeConfigSnapshotPostgresQueryMock.$queryRawUnsafe.call(dbMocks.db, query, id),
    }),
}));
// This testkit imports storage; load it after installing the database boundary.
const { createSignedAccountContentBinding } = await import("@/testkit/accountEncryption");

const STORED_OWNER_METADATA_ENVELOPE_V1 = JSON.stringify({
    t: "encrypted",
    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
});
const STORED_SHARED_METADATA_V1 = JSON.stringify({ v: 1 });
const CURRENT_STORED_CONTENT_COMPATIBILITY = {
    accepted: true,
    supportsCurrentProtocol: true,
    outcome: "accepted",
    declaration: {
        v: 1,
        protocolVersion:
            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    },
    upgradeRequired: null,
} as const;

function createCurrentRouteTestBuilder(
    options: Parameters<typeof createRouteTestBuilder>[0],
) {
    return createRouteTestBuilder({
        ...options,
        defaultRequest: {
            accountStoredContentCompatibility:
                CURRENT_STORED_CONTENT_COMPATIBILITY,
            ...options.defaultRequest,
            headers: {
                "x-happier-account-stored-content-protocol": String(
                    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                ),
                ...options.defaultRequest?.headers,
            },
        },
    });
}

describe("publicShareRoutes optional auth (no reply-already-sent)", () => {
    beforeAll(async () => {
        vi.stubEnv("HANDY_MASTER_SECRET", "public-share-test-secret");
        auth = (await import("@/app/auth/auth")).auth;
        await auth.init();
    });
    afterAll(() => { vi.unstubAllEnvs(); });
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();
        retainCredentialRows();
        vi.stubEnv("HAPPIER_DB_PROVIDER", "postgres");
        vi.stubEnv("HAPPY_DB_PROVIDER", "postgres");
        // The public route family's real feature gate inherits deployment settings.
        dbMocks.db.homeSettings.findUnique.mockResolvedValue(null);
        dbMocks.db.homeGovernancePolicy.findUnique.mockResolvedValue(null);
        dbTransaction.transaction.mockClear();
        txDbMocks.db.account.findUnique.mockResolvedValue({
            tokenEpoch: 0, status: "active",
            encryptionMode: "e2ee",
            ...createSignedAccountContentBinding(),
        });
        txDbMocks.db.account.findUniqueOrThrow.mockResolvedValue({ status: "active" });
        vi.stubEnv("HANDY_MASTER_SECRET", "public-share-test-secret");
    });

    it.each([
        "/v1/public-share/:token",
        "/v1/public-share/:token/messages",
    ] as const)("rejects a verified Runner bearer before reading public route %s", async (path) => {
        const { createMaterializedEphemeralRunnerFixture } = await import("@/app/ephemeralRunner/materializedRunner.testkit");
        const runner = await createMaterializedEphemeralRunnerFixture();
        expect(await auth.verifyTokenDisposition(runner.token, { allowLegacyHome: true })).toMatchObject({
            status: "verified", credential: { authTokenKind: "ephemeral_session_runner", authority: "session_runtime" },
        });
        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createCurrentRouteTestBuilder({
            method: "GET",
            path,
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: {
                    authorization: `Bearer ${runner.token}`,
                    "x-happier-account-stored-content-protocol": String(
                        CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    ),
                },
            },
            registerRoutes(app) {
                publicShareRoutes(app as any);
            },
        });

        const reply = route.createReply();
        await route.handler(route.createRequest(), reply);

        expect(reply.statusCode).toBe(403);
        expect(txDbMocks.db.publicSessionShare.findUnique).not.toHaveBeenCalled();
        expect(accessLogCreate).not.toHaveBeenCalled();
    });

    it("does not call app.authenticate() for /v1/public-share/:token and succeeds even with invalid bearer", async () => {
        const ownerAccount = {
            encryptionMode: "e2ee",
            ...createSignedAccountContentBinding(),
        };
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            keyDerivation: "legacy_token_v1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            encryptedDataKey: null,
            blockedUsers: undefined,
        });
        txDbMocks.db.publicSessionShare.updateMany.mockResolvedValue({ count: 1 });
        const session = {
            id: "s1",
            accountId: "owner",
            seq: 1,
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: STORED_SHARED_METADATA_V1,
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            account: { ...ownerProfile, id: "owner" },
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 1,
        };
        txDbMocks.db.session.findUnique.mockImplementation(async (request) => ({
            ...session,
            ...(request.select?.accountId === true
                ? { accountId: "owner" }
                : {}),
        }));
        txDbMocks.db.account.findUnique.mockImplementation(async (request) =>
            request.where.id === "owner" ? ownerAccount : null,
        );

        dbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            accountId: "owner",
            seq: 1,
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: STORED_SHARED_METADATA_V1,
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            account: { ...ownerProfile, id: "owner" },
        });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createCurrentRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token",
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: {
                    authorization: "Bearer bad",
                    "x-happier-account-stored-content-protocol": String(
                        CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    ),
                },
                accountStoredContentCompatibility: undefined,
            },
            registerRoutes(app) {
                app.authenticate.mockImplementation(async (_req: any, reply: any) => {
                    reply.code(401).send({ error: "invalid" });
                    throw new Error("unauthorized");
                });
                publicShareRoutes(app as any);
            },
        });

        const legacyReply = route.createReply();
        const legacyPayload = await route.handler(
            route.createRequest({
                headers: {
                    "x-happier-account-stored-content-protocol": undefined,
                },
            }),
            legacyReply,
        );
        expect(legacyReply.statusCode).toBe(426);
        expect(legacyPayload).toBeUndefined();
        expect(txDbMocks.db.publicSessionShare.updateMany).not.toHaveBeenCalled();
        expect(accessLogCreate).not.toHaveBeenCalled();

        const reply = route.createReply();
        const send = reply.send;
        reply.send = vi.fn((payload: any) => {
            if (reply.sent) {
                throw new Error("Reply was already sent");
            }
            return send(payload);
        });

        const payload = await route.handler(route.createRequest(), reply);

        expect(route.app.authenticate).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(200);
        expect(payload).toEqual(
            expect.objectContaining({
                session: expect.objectContaining({ id: "s1" }),
                accessLevel: "view",
            }),
        );
        expect(accessLogCreate).toHaveBeenCalledWith({
            data: { publicShareId: "ps1", userId: null, ipAddress: null, userAgent: null },
        });
    });

    it("refuses the released layout-zero public-share projection without consuming the share", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            keyDerivation: "legacy_token_v1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: 1,
            useCount: 0,
            isConsentRequired: false,
            encryptedDataKey: null,
        });
        txDbMocks.db.publicSessionShare.updateMany.mockResolvedValue({ count: 1 });
        txDbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: "legacy-whole-bag",
            metadataVersion: 1,
            accountId: "owner",
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            agentState: "legacy-owner-state",
            agentStateVersion: 3,
            active: true,
            lastActiveAt: new Date(3),
            account: { ...ownerProfile, id: "owner" },
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 1,
        });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createCurrentRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token",
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: {},
            },
            registerRoutes(app) {
                publicShareRoutes(app as any);
            },
        });

        const reply = route.createReply();
        const payload = await route.handler(route.createRequest(), reply);

        expect(reply.statusCode).toBe(409);
        expect(payload).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
        expect(txDbMocks.db.publicSessionShare.updateMany).not.toHaveBeenCalled();
        expect(accessLogCreate).not.toHaveBeenCalled();
        expect(txDbMocks.db.session.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                select: expect.objectContaining({
                    accountId: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                }),
            }),
        );
    });

    it("refuses public disclosure when the owning plain Account has an encrypted owner envelope", async () => {
        txDbMocks.db.account.findUnique.mockResolvedValue({
            encryptionMode: "plain",
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        });
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            keyDerivation: "legacy_token_v1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: 1,
            useCount: 0,
            isConsentRequired: false,
            encryptedDataKey: null,
        });
        txDbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            accountId: "owner",
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: STORED_SHARED_METADATA_V1,
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            account: { ...ownerProfile, id: "owner" },
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 1,
        });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createCurrentRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token",
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: {},
            },
            registerRoutes(app) {
                publicShareRoutes(app as any);
            },
        });

        const { reply, response } = await route.invoke();

        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
        expect(txDbMocks.db.publicSessionShare.updateMany).not.toHaveBeenCalled();
        expect(accessLogCreate).not.toHaveBeenCalled();
    });

    it("does not grant, log, or increment when an unlimited share rotates after authorization", async () => {
        const expiresAt = new Date(4_102_444_800_000);
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            keyDerivation: "legacy_token_v1",
            sessionId: "s1",
            expiresAt,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            encryptedDataKey: null,
        });
        txDbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: STORED_SHARED_METADATA_V1,
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            accountId: "owner",
            account: { ...ownerProfile, id: "owner" },
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 1,
        });
        dbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: STORED_SHARED_METADATA_V1,
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            accountId: "owner",
            account: { ...ownerProfile, id: "owner" },
        });
        txDbMocks.db.publicSessionShare.update.mockResolvedValue({});
        txDbMocks.db.publicSessionShare.updateMany.mockImplementation(async (args: any) => ({
            // The current row no longer matches the originally authorized token/policy snapshot.
            count:
                args.where.tokenHash
                && args.where.expiresAt === expiresAt
                && args.where.isConsentRequired === false
                    ? 0
                    : 1,
        }));

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createCurrentRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token",
            defaultRequest: {
                params: { token: "old-token" },
                query: {},
                headers: {},
            },
            registerRoutes(app) {
                publicShareRoutes(app as any);
            },
        });

        const reply = route.createReply();
        const payload = await route.handler(route.createRequest(), reply);

        expect(reply.statusCode).toBe(404);
        expect(payload).not.toHaveProperty("messagesAccessToken");
        expect(txDbMocks.db.publicSessionShare.update).not.toHaveBeenCalled();
        expect(txDbMocks.db.publicSessionShare.updateMany).toHaveBeenCalledWith({
            where: {
                id: "ps1",
                tokenHash: expect.any(Uint8Array),
                maxUses: null,
                expiresAt,
                isConsentRequired: false,
            },
            data: { useCount: { increment: 1 } },
        });
        expect(accessLogCreate).not.toHaveBeenCalled();
    });

    it("returns the same admitted public session row instead of re-reading a newer unshareable state", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            keyDerivation: "legacy_token_v1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            isConsentRequired: false,
            encryptedDataKey: null,
        });
        txDbMocks.db.publicSessionShare.updateMany.mockResolvedValue({ count: 1 });
        txDbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: STORED_SHARED_METADATA_V1,
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 9,
            active: true,
            lastActiveAt: new Date(3),
            accountId: "owner",
            account: { ...ownerProfile, id: "owner" },
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
        });
        dbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(99),
            metadata: "private-transition",
            metadataVersion: 2,
            agentState: "private-transition",
            agentStateVersion: 1,
            active: true,
            lastActiveAt: new Date(99),
            accountId: "owner",
            account: { ...ownerProfile, id: "owner" },
            currentStorageState: "machine_only",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
        });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createCurrentRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token",
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: {},
            },
            registerRoutes(app) {
                publicShareRoutes(app as any);
            },
        });

        const reply = route.createReply();
        const payload = await route.handler(route.createRequest(), reply);

        expect(reply.statusCode).toBe(200);
        expect(payload).toEqual(expect.objectContaining({
            session: expect.objectContaining({
                id: "s1",
                updatedAt: 2,
                metadata: STORED_SHARED_METADATA_V1,
                metadataLayoutVersion: 1,
            }),
        }));
        const session = (
            payload as Readonly<{ session?: unknown }>
        ).session;
        expect(session).not.toHaveProperty("ownerMetadata");
        expect(session).toMatchObject({
            agentState: null,
            agentStateVersion: 9,
        });
        expect(dbMocks.db.session.findUnique).not.toHaveBeenCalled();
    });

    it("returns consent owner data from the admitted transaction row without a stale second read", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            keyDerivation: "legacy_token_v1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            isConsentRequired: true,
            encryptedDataKey: null,
        });
        txDbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: STORED_SHARED_METADATA_V1,
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            accountId: "admitted-owner",
            account: { ...ownerProfile, id: "admitted-owner" },
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
        });
        dbMocks.db.session.findUnique.mockResolvedValue({
            accountId: "newer-owner",
            account: { ...ownerProfile, id: "newer-owner" },
            currentStorageState: "machine_only",
        });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createCurrentRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token",
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: {},
            },
            registerRoutes(app) {
                publicShareRoutes(app as any);
            },
        });

        const reply = route.createReply();
        const payload = await route.handler(route.createRequest(), reply);

        expect(reply.statusCode).toBe(403);
        expect(payload).toEqual(expect.objectContaining({
            requiresConsent: true,
            owner: { id: "admitted-owner", firstName: null, lastName: null, username: null, avatar: null },
        }));
        expect(dbMocks.db.session.findUnique).not.toHaveBeenCalled();
    });

    it.each([
        {
            label: "a signed-session bearer",
            kind: "account",
            expectedLoggedUserId: "viewer-1",
        },
        {
            label: "an API token bearer",
            kind: "api_token",
            expectedLoggedUserId: null,
        },
    ])("treats the public token as the only per-viewer authority for $label", async ({ kind, expectedLoggedUserId }) => {
        await dbMocks.db.account.create({ data: { id: "viewer-1", encryptionMode: "plain" } });
        const token = kind === "account"
            ? await auth.createToken("viewer-1", undefined, { kind: "account", authority: "present_user" })
            : (await auth.createApiToken({ accountId: "viewer-1", tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel("viewer-1", "public-viewer") })).token;
        expect(await auth.verifyTokenDisposition(token, { allowLegacyHome: true })).toMatchObject({
            status: "verified", credential: { userId: "viewer-1", authTokenKind: kind },
        });
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            keyDerivation: "legacy_token_v1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            encryptedDataKey: null,
            blockedUsers: [{ id: "legacy-block" }],
        });
        txDbMocks.db.publicSessionShare.updateMany.mockResolvedValue({ count: 1 });
        txDbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: STORED_SHARED_METADATA_V1,
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            accountId: "owner",
            account: { ...ownerProfile, id: "owner" },
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 1,
        });
        dbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: STORED_SHARED_METADATA_V1,
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            accountId: "owner",
            account: { ...ownerProfile, id: "owner" },
        });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createCurrentRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token",
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: { authorization: `Bearer ${token}` },
            },
            registerRoutes(app) {
                publicShareRoutes(app as any);
            },
        });

        const reply = route.createReply();
        const payload = await route.handler(route.createRequest(), reply);

        expect(reply.statusCode).toBe(200);
        expect(payload).toEqual(expect.objectContaining({
            session: expect.objectContaining({ id: "s1" }),
            accessLevel: "view",
        }));
        expect(txDbMocks.db.publicSessionShare.findUnique).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.not.objectContaining({ blockedUsers: expect.anything() }),
        }));
        expect(accessLogCreate).toHaveBeenCalledWith({
            data: { publicShareId: "ps1", userId: expectedLoggedUserId, ipAddress: null, userAgent: null },
        });
    });

    it("does not call app.authenticate() for /v1/public-share/:token/messages and succeeds even with invalid bearer", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            keyDerivation: "legacy_token_v1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            blockedUsers: undefined,
            encryptedDataKey: null,
        });

        txDbMocks.db.session.findUnique.mockResolvedValue({
            accountId: "owner",
            seq: 1,
            encryptionMode: "plain",
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 1,
        });

        txDbMocks.db.sessionMessage.findMany.mockResolvedValue([
            { id: "m1", seq: 1, localId: "l1", content: { t: "plain", v: "c" }, createdAt: new Date(1), updatedAt: new Date(2) },
        ]);

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createCurrentRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token/messages",
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: {
                    authorization: "Bearer bad",
                },
            },
            registerRoutes(app) {
                app.authenticate.mockImplementation(async (_req: any, reply: any) => {
                    reply.code(401).send({ error: "invalid" });
                    throw new Error("unauthorized");
                });
                publicShareRoutes(app as any);
            },
        });

        const reply = route.createReply();
        const send = reply.send;
        reply.send = vi.fn((payload: any) => {
            if (reply.sent) {
                throw new Error("Reply was already sent");
            }
            return send(payload);
        });

        const payload = await route.handler(route.createRequest(), reply);

        expect(route.app.authenticate).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(200);
        expect(txDbMocks.db.sessionMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                sessionId: "s1",
                sidechainId: null,
                seq: { lte: 1 },
                session: expect.objectContaining({
                    OR: expect.any(Array),
                }),
            },
        }));
        expect(payload).toEqual({
            messages: [{ id: "m1", seq: 1, content: { t: "plain", v: "c" }, localId: "l1", createdAt: 1, updatedAt: 2 }],
            hasMore: false,
            nextBeforeSeq: null,
        });
    });
});
