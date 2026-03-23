import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createInTxHarness } from "../../testkit/txHarness";

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
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async (_tx: any, params: any) => {
    // Return distinct cursors for recipient kinds so we can assert we pick the latest.
    if (params.accountId === "recipient" && params.kind === "share") return 11;
    if (params.accountId === "recipient" && params.kind === "session") return 12;
    if (params.accountId === "owner") return 21;
    return 99;
});
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const dbMocks = createDbMocks({
    session: ["findUnique"],
    account: ["findUnique"],
    sessionShare: ["upsert", "findFirst", "update"],
} as const);
const txDbMocks = createDbMocks({
    sessionShare: ["upsert", "update", "findFirst", "delete"],
} as const);

installDbModuleMock(() => ({
    db: dbMocks.db,
}));

vi.mock("@/storage/inTx", () => {
    const harness = createInTxHarness(() => ({
            sessionShare: txDbMocks.db.sessionShare,
        }));
    return { afterTx: harness.afterTx, inTx: harness.inTx };
});

const ENCRYPTED_DATA_KEY = Buffer.from(Uint8Array.from([0, ...new Array(73).fill(1)])).toString("base64");

describe("shareRoutes (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();
        dbMocks.db.session.findUnique.mockResolvedValue({ id: "s1", encryptionMode: "e2ee" });
        dbMocks.db.account.findUnique.mockResolvedValue({ id: "recipient" });

        txDbMocks.db.sessionShare.upsert.mockResolvedValue({
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
        });
        txDbMocks.db.sessionShare.update.mockResolvedValue({
            id: "share-1",
            sessionId: "s1",
            sharedWithUserId: "recipient",
            accessLevel: "admin",
            canApprovePermissions: true,
            sharedWithUser: { id: "recipient" },
            createdAt: new Date(1),
            updatedAt: new Date(2),
        });
        txDbMocks.db.sessionShare.findFirst.mockResolvedValue({ id: "share-1", sessionId: "s1", sharedWithUserId: "recipient" });
        txDbMocks.db.sessionShare.delete.mockResolvedValue({});

        dbMocks.db.sessionShare.findFirst.mockResolvedValue({ accessLevel: "edit", canApprovePermissions: false });
        dbMocks.db.sessionShare.update.mockResolvedValue({} as any);
    });

    it("POST marks owner+recipient share changes (and recipient session) and emits using latest recipient cursor", async () => {
        const { shareRoutes } = await import("./shareRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/sessions/:sessionId/shares",
            registerRoutes(app) {
                shareRoutes(app as any);
            },
        });

        await route.invoke(
            {
                userId: "owner",
                params: { sessionId: "s1" },
                body: {
                    userId: "recipient",
                    accessLevel: "edit",
                    encryptedDataKey: ENCRYPTED_DATA_KEY,
                },
            },
        );

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "session", entityId: "s1" }));

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "recipient",
                payload: expect.objectContaining({
                    seq: 12,
                    body: expect.objectContaining({ t: "session-shared" }),
                }),
            }),
        );
    });

    it("POST allows plaintext sessions without an encryptedDataKey", async () => {
        dbMocks.db.session.findUnique.mockResolvedValue({ id: "s1", encryptionMode: "plain" });
        txDbMocks.db.sessionShare.upsert.mockImplementation(async (args: any) => ({
            id: "share-1",
            sessionId: "s1",
            sharedWithUserId: "recipient",
            accessLevel: "edit",
            canApprovePermissions: false,
            encryptedDataKey: null,
            sharedWithUser: { id: "recipient" },
            sharedByUser: { id: "owner" },
            createdAt: new Date(1),
            updatedAt: new Date(1),
        }));

        const { shareRoutes } = await import("./shareRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/sessions/:sessionId/shares",
            registerRoutes(app) {
                shareRoutes(app as any);
            },
        });

        const { reply } = await route.invoke(
            {
                userId: "owner",
                params: { sessionId: "s1" },
                body: {
                    userId: "recipient",
                    accessLevel: "edit",
                },
            },
        );

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(txDbMocks.db.sessionShare.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ encryptedDataKey: null }),
                update: expect.objectContaining({ encryptedDataKey: null }),
            }),
        );
    });

    it("PATCH marks owner+recipient share changes (and recipient session) and emits using latest recipient cursor", async () => {
        const { shareRoutes } = await import("./shareRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v1/sessions/:sessionId/shares/:shareId",
            registerRoutes(app) {
                shareRoutes(app as any);
            },
        });

        await route.invoke(
            {
                userId: "owner",
                params: { sessionId: "s1", shareId: "share-1" },
                body: { accessLevel: "admin", canApprovePermissions: true },
            },
        );

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "session", entityId: "s1" }));

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "recipient",
                payload: expect.objectContaining({
                    seq: 12,
                    body: expect.objectContaining({ t: "session-share-updated" }),
                }),
            }),
        );
    });

    it("DELETE marks owner+recipient share changes (and recipient session) and emits using latest recipient cursor", async () => {
        const { shareRoutes } = await import("./shareRoutes");
        const route = createRouteTestBuilder({
            method: "DELETE",
            path: "/v1/sessions/:sessionId/shares/:shareId",
            registerRoutes(app) {
                shareRoutes(app as any);
            },
        });

        await route.invoke(
            {
                userId: "owner",
                params: { sessionId: "s1", shareId: "share-1" },
            },
        );

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "recipient", kind: "session", entityId: "s1" }));

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "recipient",
                payload: expect.objectContaining({
                    seq: 12,
                    body: expect.objectContaining({ t: "session-share-revoked" }),
                }),
            }),
        );
    });
});
