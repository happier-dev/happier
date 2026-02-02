import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/share/accessControl", () => ({
    canManageSharing: vi.fn(async () => true),
    canManagePermissionDelegation: vi.fn(async () => true),
    areFriends: vi.fn(async () => true),
}));

vi.mock("@/app/share/types", () => ({
    PROFILE_SELECT: {},
    toShareUserProfile: (u: any) => u,
}));

const emitUpdate = vi.fn();
const buildSessionSharedUpdate = vi.fn((_share: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "session-shared" },
}));
const buildSessionShareUpdatedUpdate = vi.fn((_shareId: string, _sessionId: string, _level: any, _updatedAt: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "session-share-updated" },
}));
const buildSessionShareRevokedUpdate = vi.fn((_shareId: string, _sessionId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "session-share-revoked" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildSessionSharedUpdate,
    buildSessionShareUpdatedUpdate,
    buildSessionShareRevokedUpdate,
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async (_tx: any, params: any) => {
    // Return distinct cursors for recipient kinds so we can assert we pick the latest.
    if (params.accountId === "recipient" && params.kind === "share") return 11;
    if (params.accountId === "recipient" && params.kind === "session") return 12;
    if (params.accountId === "owner") return 21;
    return 99;
});
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

const dbSessionFindUnique = vi.fn();
const dbAccountFindUnique = vi.fn();
const dbSessionShareUpsert = vi.fn();
const dbSessionShareFindFirst = vi.fn();
const dbSessionShareUpdate = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findUnique: (...args: any[]) => dbSessionFindUnique(...args),
        },
        account: {
            findUnique: (...args: any[]) => dbAccountFindUnique(...args),
        },
        sessionShare: {
            upsert: (...args: any[]) => dbSessionShareUpsert(...args),
            findFirst: (...args: any[]) => dbSessionShareFindFirst(...args),
            update: (...args: any[]) => dbSessionShareUpdate(...args),
        },
    },
}));

let txSessionShareUpsert: any;
let txSessionShareUpdate: any;
let txSessionShareFindFirst: any;
let txSessionShareDelete: any;

vi.mock("@/storage/inTx", () => {
    const afterTx = (tx: any, callback: () => void) => {
        tx.__afterTxCallbacks.push(callback);
    };

    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            sessionShare: {
                upsert: (...args: any[]) => txSessionShareUpsert(...args),
                update: (...args: any[]) => txSessionShareUpdate(...args),
                findFirst: (...args: any[]) => txSessionShareFindFirst(...args),
                delete: (...args: any[]) => txSessionShareDelete(...args),
            },
        };

        const result = await fn(tx);
        for (const cb of tx.__afterTxCallbacks) {
            await cb();
        }
        return result;
    };

    return { afterTx, inTx };
});

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get() {}
    post(path: string, _opts: any, handler: any) {
        this.routes.set(`POST ${path}`, handler);
    }
    patch(path: string, _opts: any, handler: any) {
        this.routes.set(`PATCH ${path}`, handler);
    }
    delete(path: string, _opts: any, handler: any) {
        this.routes.set(`DELETE ${path}`, handler);
    }
}

describe("shareRoutes (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbSessionFindUnique.mockResolvedValue({ id: "s1" });
        dbAccountFindUnique.mockResolvedValue({ id: "recipient" });

        txSessionShareUpsert = vi.fn(async () => ({
            id: "share-1",
            sessionId: "s1",
            sharedWithUserId: "recipient",
            accessLevel: "edit",
            canApprovePermissions: false,
            encryptedDataKey: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74]),
            sharedWithUser: { id: "recipient" },
            sharedByUser: { id: "owner" },
            createdAt: new Date(1),
            updatedAt: new Date(1),
        }));
        txSessionShareUpdate = vi.fn(async () => ({
            id: "share-1",
            sessionId: "s1",
            sharedWithUserId: "recipient",
            accessLevel: "admin",
            canApprovePermissions: true,
            sharedWithUser: { id: "recipient" },
            createdAt: new Date(1),
            updatedAt: new Date(2),
        }));
        txSessionShareFindFirst = vi.fn(async () => ({ id: "share-1", sessionId: "s1", sharedWithUserId: "recipient" }));
        txSessionShareDelete = vi.fn(async () => ({}));

        dbSessionShareFindFirst.mockResolvedValue({ accessLevel: "edit", canApprovePermissions: false });
        dbSessionShareUpdate.mockResolvedValue({} as any);
    });

    it("POST marks owner+recipient share changes (and recipient session) and emits using latest recipient cursor", async () => {
        const { shareRoutes } = await import("./shareRoutes");
        const app = new FakeApp();
        shareRoutes(app as any);

        const handler = app.routes.get("POST /v1/sessions/:sessionId/shares");
        const reply = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        await handler(
            {
                userId: "owner",
                params: { sessionId: "s1" },
                body: {
                    userId: "recipient",
                    accessLevel: "edit",
                    encryptedDataKey: Buffer.from(Uint8Array.from([0, ...new Array(73).fill(1)])).toString("base64"),
                },
            },
            reply,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "session", entityId: "s1" }));

        expect(buildSessionSharedUpdate).toHaveBeenCalledWith(expect.anything(), 12, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: "recipient" }));
    });

    it("PATCH marks owner+recipient share changes (and recipient session) and emits using latest recipient cursor", async () => {
        const { shareRoutes } = await import("./shareRoutes");
        const app = new FakeApp();
        shareRoutes(app as any);

        const handler = app.routes.get("PATCH /v1/sessions/:sessionId/shares/:shareId");
        const reply = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        await handler(
            {
                userId: "owner",
                params: { sessionId: "s1", shareId: "share-1" },
                body: { accessLevel: "admin", canApprovePermissions: true },
            },
            reply,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "session", entityId: "s1" }));

        expect(buildSessionShareUpdatedUpdate).toHaveBeenCalledWith("share-1", "s1", "admin", expect.any(Date), 12, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: "recipient" }));
    });

    it("DELETE marks owner+recipient share changes (and recipient session) and emits using latest recipient cursor", async () => {
        const { shareRoutes } = await import("./shareRoutes");
        const app = new FakeApp();
        shareRoutes(app as any);

        const handler = app.routes.get("DELETE /v1/sessions/:sessionId/shares/:shareId");
        const reply = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        await handler(
            {
                userId: "owner",
                params: { sessionId: "s1", shareId: "share-1" },
            },
            reply,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "session", entityId: "s1" }));

        expect(buildSessionShareRevokedUpdate).toHaveBeenCalledWith("share-1", "s1", 12, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: "recipient" }));
    });
});
