import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";
import { createInTxHarness } from "../../testkit/txHarness";

vi.mock("@/app/share/accessControl", () => ({
    isSessionOwner: vi.fn(async () => true),
}));

const emitUpdate = vi.fn();
const buildPublicShareCreatedUpdate = vi.fn((_ps: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "public-share-created" },
}));
const buildPublicShareUpdatedUpdate = vi.fn((_ps: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "public-share-updated" },
}));
const buildPublicShareDeletedUpdate = vi.fn((_sessionId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "public-share-deleted" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildPublicShareCreatedUpdate,
    buildPublicShareUpdatedUpdate,
    buildPublicShareDeletedUpdate,
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async (_tx: any, params: any) => {
    if (params.kind === "share") return 50;
    if (params.kind === "session") return 51;
    return 99;
});
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

let txFindUnique: any;
let txCreate: any;
let txUpdate: any;
let txDelete: any;

vi.mock("@/storage/inTx", () => {
    const harness = createInTxHarness(() => ({
            publicSessionShare: {
                findUnique: (...args: any[]) => txFindUnique(...args),
                create: (...args: any[]) => txCreate(...args),
                update: (...args: any[]) => txUpdate(...args),
                delete: (...args: any[]) => txDelete(...args),
            },
        }));
    return { afterTx: harness.afterTx, inTx: harness.inTx };
});

vi.mock("@/storage/db", () => ({ db: {} }));

describe("publicShareRoutes (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        txFindUnique = vi.fn();
        txCreate = vi.fn();
        txUpdate = vi.fn();
        txDelete = vi.fn();
    });

    it("POST create marks share+session and emits created update using latest cursor", async () => {
        txFindUnique.mockResolvedValue(null);
        txCreate.mockResolvedValue({
            id: "ps1",
            sessionId: "s1",
            createdByUserId: "u1",
            tokenHash: Buffer.from("h"),
            encryptedDataKey: new Uint8Array([1, 2, 3]),
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: false,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const app = createFakeRouteApp();
        publicShareRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v1/sessions/:sessionId/public-share");
        const reply = createReplyStub();

        await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                body: { token: "tok", encryptedDataKey: Buffer.from("k").toString("base64") },
            },
            reply,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u1", kind: "share", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u1", kind: "session", entityId: "s1" }));

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({
                    seq: 51,
                    body: expect.objectContaining({ t: "public-share-created" }),
                }),
            }),
        );
    });

    it("POST update marks share+session and emits updated update using latest cursor", async () => {
        txFindUnique.mockResolvedValue({ id: "ps1", sessionId: "s1" });
        txUpdate.mockResolvedValue({
            id: "ps1",
            sessionId: "s1",
            createdByUserId: "u1",
            tokenHash: Buffer.from("h"),
            encryptedDataKey: new Uint8Array([1, 2, 3]),
            expiresAt: null,
            maxUses: null,
            useCount: 2,
            isConsentRequired: false,
            createdAt: new Date(1),
            updatedAt: new Date(2),
        });

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const app = createFakeRouteApp();
        publicShareRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v1/sessions/:sessionId/public-share");
        const reply = createReplyStub();

        await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                body: { expiresAt: null, isConsentRequired: false },
            },
            reply,
        );

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({
                    seq: 51,
                    body: expect.objectContaining({ t: "public-share-updated" }),
                }),
            }),
        );
    });

    it("DELETE marks share+session and emits deleted update using latest cursor", async () => {
        txFindUnique.mockResolvedValue({ id: "ps1", sessionId: "s1" });
        txDelete.mockResolvedValue({});

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const app = createFakeRouteApp();
        publicShareRoutes(app as any);

        const handler = getRouteHandler(app, "DELETE", "/v1/sessions/:sessionId/public-share");
        const reply = createReplyStub();

        await handler({ userId: "u1", params: { sessionId: "s1" } }, reply);

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({
                    seq: 51,
                    body: expect.objectContaining({ t: "public-share-deleted" }),
                }),
            }),
        );
    });

    it("DELETE returns 404 when no public share exists", async () => {
        txFindUnique.mockResolvedValue(null);

        const { publicShareRoutes } = await import("./publicShareRoutes");
        const app = createFakeRouteApp();
        publicShareRoutes(app as any);

        const handler = getRouteHandler(app, "DELETE", "/v1/sessions/:sessionId/public-share");
        const reply = createReplyStub();

        const res = await handler({ userId: "u1", params: { sessionId: "s1" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ error: "Share not found" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
