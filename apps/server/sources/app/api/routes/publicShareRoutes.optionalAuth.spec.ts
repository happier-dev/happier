import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "u") }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildPublicShareCreatedUpdate: vi.fn(),
    buildPublicShareUpdatedUpdate: vi.fn(),
    buildPublicShareDeletedUpdate: vi.fn(),
}));
vi.mock("@/storage/inTx", () => ({ afterTx: vi.fn(), inTx: vi.fn() }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));

const dbTransaction = vi.fn();
const publicSessionShareFindUnique = vi.fn();
const sessionFindUnique = vi.fn();
const sessionMessageFindMany = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        $transaction: (...args: any[]) => dbTransaction(...args),
        publicSessionShare: {
            findUnique: (...args: any[]) => publicSessionShareFindUnique(...args),
        },
        session: {
            findUnique: (...args: any[]) => sessionFindUnique(...args),
        },
        sessionMessage: {
            findMany: (...args: any[]) => sessionMessageFindMany(...args),
        },
    },
}));

class FakeApp {
    public authenticate = vi.fn(async (_req: any, reply: any) => {
        reply.code(401).send({ error: "invalid" });
        throw new Error("unauthorized");
    });
    public routes = new Map<string, any>();

    get(path: string, _opts: any, handler: any) {
        this.routes.set(`GET ${path}`, handler);
    }
    post() {}
    delete() {}
}

function makeReply() {
    const reply: any = {
        statusCode: 200,
        _sent: false,
        code: vi.fn((statusCode: number) => {
            reply.statusCode = statusCode;
            return reply;
        }),
        send: vi.fn((payload: any) => {
            if (reply._sent) {
                throw new Error("Reply was already sent");
            }
            reply._sent = true;
            return payload;
        }),
    };
    return reply;
}

describe("publicShareRoutes optional auth (no reply-already-sent)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("does not call app.authenticate() for /v1/public-share/:token and succeeds even with invalid bearer", async () => {
        dbTransaction.mockImplementation(async (fn: any) =>
            fn({
                publicSessionShare: {
                    findUnique: vi.fn(async () => ({
                        id: "ps1",
                        sessionId: "s1",
                        expiresAt: null,
                        maxUses: null,
                        useCount: 0,
                        isConsentRequired: false,
                        encryptedDataKey: new Uint8Array([1, 2, 3]),
                        blockedUsers: undefined,
                    })),
                    update: vi.fn(async () => ({})),
                },
            }),
        );

        sessionFindUnique.mockImplementation(async () => ({
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
        }));

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const app = new FakeApp();
        publicShareRoutes(app as any);

        const handler = app.routes.get("GET /v1/public-share/:token");
        const reply = makeReply();

        const payload = await handler(
            { params: { token: "tok" }, query: {}, headers: { authorization: "Bearer bad" } },
            reply,
        );

        expect(app.authenticate).not.toHaveBeenCalled();
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
        publicSessionShareFindUnique.mockImplementation(async () => ({
            id: "ps1",
            sessionId: "s1",
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            blockedUsers: undefined,
        }));

        sessionMessageFindMany.mockImplementation(async () => [
            { id: "m1", seq: 1, localId: "l1", content: "c", createdAt: new Date(1), updatedAt: new Date(2) },
        ]);

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const app = new FakeApp();
        publicShareRoutes(app as any);

        const handler = app.routes.get("GET /v1/public-share/:token/messages");
        const reply = makeReply();

        const payload = await handler(
            { params: { token: "tok" }, query: {}, headers: { authorization: "Bearer bad" } },
            reply,
        );

        expect(app.authenticate).not.toHaveBeenCalled();
        expect(verifyToken).toHaveBeenCalledTimes(1);
        expect(reply.statusCode).toBe(200);
        expect(payload).toEqual({ messages: [{ id: "m1", seq: 1, content: "c", localId: "l1", createdAt: 1, updatedAt: 2 }] });
    });
});

