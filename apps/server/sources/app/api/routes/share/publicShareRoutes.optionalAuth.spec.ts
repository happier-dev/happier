import { beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from "@happier-dev/protocol";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

const verifyToken = vi.fn(async () => null as any);
vi.mock("@/app/auth/auth", () => ({
    auth: { verifyToken },
}));

// Mirrors the production logPublicShareAccess contract (accessLogger.ts) so
// call-argument assertions type-check instead of widening to a zero-arg mock.
const logPublicShareAccess = vi.fn(async (
    _publicShareId: string,
    _userId: string | null,
    _ipAddress?: string,
    _userAgent?: string,
    _writer?: unknown,
) => {});
vi.mock("@/app/share/accessLogger", () => ({
    logPublicShareAccess,
    getIpAddress: vi.fn(() => "1.2.3.4"),
    getUserAgent: vi.fn(() => "ua"),
}));

vi.mock("@/app/share/types", () => ({
    PROFILE_SELECT: {},
    toShareUserProfile: vi.fn((a: any) => ({ id: a?.id ?? "owner" })),
}));

vi.mock("@/app/share/accessControl", () => ({
    isSessionOwner: vi.fn(async () => true),
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "u") }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildPublicShareCreatedUpdate: vi.fn(),
    buildPublicShareUpdatedUpdate: vi.fn(),
    buildPublicShareDeletedUpdate: vi.fn(),
}));
const inTx = vi.hoisted(() => vi.fn());
vi.mock("@/storage/inTx", () => ({ afterTx: vi.fn(), inTx }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));

const dbMocks = createDbMocks({
    publicSessionShare: ["findUnique"],
    session: ["findUnique"],
    sessionMessage: ["findMany"],
} as const);
const txDbMocks = createDbMocks({
    account: ["findUnique"],
    publicSessionShare: ["findUnique", "update", "updateMany"],
    session: ["findUnique"],
    sessionMessage: ["findMany"],
} as const);
const dbTransaction = createDbTransactionMock(() => ({
    account: txDbMocks.db.account,
    publicSessionShare: txDbMocks.db.publicSessionShare,
    session: txDbMocks.db.session,
    sessionMessage: txDbMocks.db.sessionMessage,
}));

installDbModuleMock(() => ({
    db: dbTransaction.wrapDb(dbMocks.db),
}));

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
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();
        dbTransaction.transaction.mockClear();
        inTx.mockReset();
        inTx.mockImplementation(async (run: (tx: typeof txDbMocks.db) => Promise<unknown>) =>
            await run(txDbMocks.db));
        txDbMocks.db.account.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            ...createSignedAccountContentBinding(),
        });
        vi.stubEnv("HANDY_MASTER_SECRET", "public-share-test-secret");
    });

    it("does not call app.authenticate() for /v1/public-share/:token and succeeds even with invalid bearer", async () => {
        const ownerAccount = {
            encryptionMode: "e2ee",
            ...createSignedAccountContentBinding(),
        };
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
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
            account: { id: "owner" },
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
            account: { id: "owner" },
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
        expect(logPublicShareAccess).not.toHaveBeenCalled();

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
        expect(verifyToken).toHaveBeenCalledTimes(2);
        expect(reply.statusCode).toBe(200);
        expect(payload).toEqual(
            expect.objectContaining({
                session: expect.objectContaining({ id: "s1" }),
                accessLevel: "view",
            }),
        );
        expect(logPublicShareAccess).toHaveBeenCalledWith(
            "ps1",
            null,
            undefined,
            undefined,
            txDbMocks.db,
        );
    });

    it("refuses the released layout-zero public-share projection without consuming the share", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
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
            account: { id: "owner" },
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
        expect(logPublicShareAccess).not.toHaveBeenCalled();
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
            account: { id: "owner" },
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
        expect(logPublicShareAccess).not.toHaveBeenCalled();
    });

    it("does not grant, log, or increment when an unlimited share rotates after authorization", async () => {
        const expiresAt = new Date(4_102_444_800_000);
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
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
            account: { id: "owner" },
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
            account: { id: "owner" },
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
        expect(logPublicShareAccess).not.toHaveBeenCalled();
    });

    it("returns the same admitted public session row instead of re-reading a newer unshareable state", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
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
            account: { id: "owner" },
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
            account: { id: "owner" },
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
        expect(inTx).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.session.findUnique).not.toHaveBeenCalled();
    });

    it("returns consent owner data from the admitted transaction row without a stale second read", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
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
            account: { id: "admitted-owner" },
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
        });
        dbMocks.db.session.findUnique.mockResolvedValue({
            account: { id: "newer-owner" },
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
            owner: { id: "admitted-owner" },
        }));
        expect(dbMocks.db.session.findUnique).not.toHaveBeenCalled();
    });

    it.each([
        {
            label: "a signed-session bearer",
            verified: { userId: "viewer-1", authTokenKind: "account" },
            expectedLoggedUserId: "viewer-1",
        },
        {
            label: "an API token bearer",
            verified: {
                userId: "viewer-1",
                authTokenKind: "api_token",
                authority: "account_automation",
                apiTokenPrincipal: {
                    accountId: "viewer-1",
                    principalId: "viewer-1",
                    credentialId: "pat-1",
                    authority: "account_automation",
                    expiresAt: null,
                },
            },
            expectedLoggedUserId: null,
        },
    ])("treats the public token as the only per-viewer authority for $label", async ({ verified, expectedLoggedUserId }) => {
        verifyToken.mockResolvedValueOnce(verified);
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
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
            account: { id: "owner" },
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
            account: { id: "owner" },
        });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createCurrentRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token",
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: { authorization: "Bearer valid" },
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
        expect(logPublicShareAccess.mock.calls.at(-1)?.[1]).toBe(expectedLoggedUserId);
    });

    it("does not call app.authenticate() for /v1/public-share/:token/messages and succeeds even with invalid bearer", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            blockedUsers: undefined,
            encryptedDataKey: null,
        });

        txDbMocks.db.session.findUnique.mockResolvedValue({
            seq: 1,
            encryptionMode: "plain",
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 1,
        });

        txDbMocks.db.sessionMessage.findMany.mockResolvedValue([
            { id: "m1", seq: 1, localId: "l1", content: "c", createdAt: new Date(1), updatedAt: new Date(2) },
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
        expect(verifyToken).toHaveBeenCalledTimes(1);
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
        expect(inTx).toHaveBeenCalledTimes(1);
        expect(payload).toEqual({
            messages: [{ id: "m1", seq: 1, content: "c", localId: "l1", createdAt: 1, updatedAt: 2 }],
            hasMore: false,
            nextBeforeSeq: null,
        });
    });
});
