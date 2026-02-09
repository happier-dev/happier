import { describe, expect, it, vi } from "vitest";
import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";
import { createInTxHarness } from "../../testkit/txHarness";

const emitUpdate = vi.fn();
const buildUpdateAccountUpdate = vi.fn((_userId: string, _profile: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-account" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildUpdateAccountUpdate,
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 444);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

let txAccountFindUnique: any;
let txAccountUpdateMany: any;

vi.mock("@/storage/inTx", () => {
    const harness = createInTxHarness(() => ({
            account: {
                findUnique: (...args: any[]) => txAccountFindUnique(...args),
                updateMany: (...args: any[]) => txAccountUpdateMany(...args),
            },
        }));
    return { afterTx: harness.afterTx, inTx: harness.inTx };
});

vi.mock("@/storage/db", () => ({ db: {} }));

describe("accountRoutes (AccountChange integration)", () => {
    it("marks account settings change and emits update using returned cursor", async () => {
        txAccountFindUnique = vi.fn(async () => ({ settings: "old", settingsVersion: 1 }));
        txAccountUpdateMany = vi.fn(async () => ({ count: 1 }));

        const { accountRoutes } = await import("./accountRoutes");
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v1/account/settings");
        const reply = createReplyStub();

        const response = await handler(
            { userId: "u1", body: { settings: "new", expectedVersion: 1 } },
            reply,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "account", entityId: "self" }),
        );

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "u1",
                payload: expect.objectContaining({
                    seq: 444,
                    body: expect.objectContaining({ t: "update-account" }),
                }),
            }),
        );
        expect(response).toEqual({ success: true, version: 2 });
    });
});
