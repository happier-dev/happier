import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const verifyToken = vi.fn(async () => null as any);
vi.mock("@/app/auth/auth", () => ({
    auth: { verifyToken },
}));

const logPublicShareAccess = vi.fn(async () => {});
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
vi.mock("@/storage/inTx", () => ({ afterTx: vi.fn(), inTx: vi.fn() }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));

const dbMocks = createDbMocks({
    publicSessionShare: ["findUnique"],
    session: ["findUnique"],
    sessionMessage: ["findMany"],
} as const);
const txDbMocks = createDbMocks({
    publicSessionShare: ["findUnique", "update"],
} as const);
const dbTransaction = createDbTransactionMock(() => ({
    publicSessionShare: txDbMocks.db.publicSessionShare,
}));

installDbModuleMock(() => ({
    db: dbTransaction.wrapDb(dbMocks.db),
}));

describe("publicShareRoutes optional auth (no reply-already-sent)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();
        dbTransaction.transaction.mockClear();
    });

    it("does not call app.authenticate() for /v1/public-share/:token and succeeds even with invalid bearer", async () => {
        txDbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            encryptedDataKey: new Uint8Array([1, 2, 3]),
            blockedUsers: undefined,
        });
        txDbMocks.db.publicSessionShare.update.mockResolvedValue({});

        dbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
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

    it("does not call app.authenticate() for /v1/public-share/:token/messages and succeeds even with invalid bearer", async () => {
        dbMocks.db.publicSessionShare.findUnique.mockResolvedValue({
            id: "ps1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            blockedUsers: undefined,
            encryptedDataKey: new Uint8Array([1, 2, 3]),
        });

        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
        });

        dbMocks.db.sessionMessage.findMany.mockResolvedValue([
            { id: "m1", seq: 1, localId: "l1", content: "c", createdAt: new Date(1), updatedAt: new Date(2) },
        ]);

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/public-share/:token/messages",
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
        expect(payload).toEqual({ messages: [{ id: "m1", seq: 1, content: "c", localId: "l1", createdAt: 1, updatedAt: 2 }] });
    });
});
