import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES } from "@happier-dev/protocol";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const verifyToken = vi.fn(async () => null as any);
vi.mock("@/app/auth/auth", () => ({
    auth: { verifyToken },
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
const inTx = vi.fn();
vi.mock("@/storage/inTx", () => ({ afterTx: vi.fn(), inTx }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));

const dbMocks = createDbMocks({
    publicSessionShare: ["findUnique"],
    session: ["findUnique"],
    sessionMessage: ["findMany"],
} as const);
const txDbMocks = createDbMocks({
    publicSessionShare: ["findUnique", "update", "updateMany"],
    publicShareAccessLog: ["create"],
    session: ["findUnique"],
    sessionMessage: ["findMany"],
} as const);
const dbTransaction = createDbTransactionMock(() => ({
    publicSessionShare: txDbMocks.db.publicSessionShare,
    publicShareAccessLog: txDbMocks.db.publicShareAccessLog,
    session: txDbMocks.db.session,
    sessionMessage: txDbMocks.db.sessionMessage,
}));

installDbModuleMock(() => ({
    db: dbTransaction.wrapDb(dbMocks.db),
}));

describe("publicShareRoutes optional auth (no reply-already-sent)", () => {
    const validEncryptedDataKey = new Uint8Array(PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES).fill(1);

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();
        dbTransaction.transaction.mockClear();
        inTx.mockReset();
        inTx.mockImplementation(async (fn) => dbTransaction.transaction(fn));
        vi.stubEnv("HANDY_MASTER_SECRET", "public-share-test-secret");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("does not call app.authenticate() for /v1/public-share/:token and succeeds even with invalid bearer", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            encryptedDataKey: validEncryptedDataKey,
        });
        txDbMocks.db.publicSessionShare.updateMany.mockResolvedValue({ count: 1 });
        txDbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            encryptionMode: "e2ee",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: "m",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            account: { id: "owner" },
        });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token",
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: { authorization: "Bearer bad" },
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
        expect(payload).toEqual(
            expect.objectContaining({
                session: expect.objectContaining({ id: "s1" }),
                accessLevel: "view",
            }),
        );
    });

    it("does not consume a public-share use when the session projection is unavailable", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            encryptedDataKey: validEncryptedDataKey,
        });
        txDbMocks.db.publicSessionShare.update.mockResolvedValue({});
        txDbMocks.db.session.findUnique.mockResolvedValue(null);

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createRouteTestBuilder({
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
        await route.handler(route.createRequest(), reply);

        expect(reply.statusCode).toBe(404);
        expect(txDbMocks.db.publicSessionShare.update).not.toHaveBeenCalled();
        expect(txDbMocks.db.publicSessionShare.updateMany).not.toHaveBeenCalled();
        expect(txDbMocks.db.publicShareAccessLog.create).not.toHaveBeenCalled();
    });

    it("does not claim a capped use after the public token rotates concurrently", async () => {
        vi.stubEnv("HANDY_MASTER_SECRET", "public-share-test-secret");
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
            encryptionMode: "plain",
            createdAt: new Date(1),
            updatedAt: new Date(2),
            metadata: "m",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            account: { id: "owner" },
        });
        txDbMocks.db.publicSessionShare.updateMany.mockImplementation(async (args: any) => ({
            // Model a concurrent rotation: the latest row no longer has the requested token hash.
            count: args.where.tokenHash ? 0 : 1,
        }));

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createRouteTestBuilder({
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
        await route.handler(route.createRequest(), reply);

        expect(reply.statusCode).toBe(404);
        expect(txDbMocks.db.publicShareAccessLog.create).not.toHaveBeenCalled();
    });

    it("does not apply authenticated-user block policy to anonymous bearer access", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "viewer" });
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            sessionId: "s1",
            expiresAt: new Date(4_102_444_800_000),
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
            metadata: "m",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            active: true,
            lastActiveAt: new Date(3),
            account: { id: "owner" },
        });
        txDbMocks.db.publicSessionShare.updateMany.mockResolvedValue({ count: 1 });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token",
            defaultRequest: {
                params: { token: "tok" },
                query: {},
                headers: { authorization: "Bearer viewer-token" },
            },
            registerRoutes(app) {
                publicShareRoutes(app as any);
            },
        });

        const reply = route.createReply();
        await route.handler(route.createRequest(), reply);

        expect(reply.statusCode).toBe(200);
        expect(txDbMocks.db.publicSessionShare.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.not.objectContaining({ blockedUsers: expect.anything() }),
        }));
        expect(txDbMocks.db.publicShareAccessLog.create).toHaveBeenCalledWith({
            data: { publicShareId: "ps1", userId: "viewer", ipAddress: null, userAgent: null },
        });
    });

    it("does not call app.authenticate() for /v1/public-share/:token/messages and succeeds even with invalid bearer", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            isConsentRequired: false,
            encryptedDataKey: validEncryptedDataKey,
        });

        txDbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
        });

        txDbMocks.db.sessionMessage.findMany.mockResolvedValue([
            { id: "m1", seq: 1, localId: "l1", messageRole: null, content: "c", createdAt: new Date(1), updatedAt: new Date(2) },
        ]);

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createRouteTestBuilder({
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
        expect(payload).toEqual({
            messages: [{ id: "m1", seq: 1, content: "c", localId: "l1", createdAt: 1, updatedAt: 2 }],
            hasMore: false,
        });
        expect(dbMocks.db.sessionMessage.findMany).not.toHaveBeenCalled();
    });
});
