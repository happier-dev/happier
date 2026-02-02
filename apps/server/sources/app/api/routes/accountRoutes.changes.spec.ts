import { describe, expect, it, vi } from "vitest";

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
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 444);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

let txAccountFindUnique: any;
let txAccountUpdateMany: any;

vi.mock("@/storage/inTx", () => {
    const afterTx = (tx: any, callback: () => void) => {
        tx.__afterTxCallbacks.push(callback);
    };

    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            account: {
                findUnique: (...args: any[]) => txAccountFindUnique(...args),
                updateMany: (...args: any[]) => txAccountUpdateMany(...args),
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

vi.mock("@/storage/db", () => ({ db: {} }));

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get() {}
    post(path: string, _opts: any, handler: any) {
        this.routes.set(`POST ${path}`, handler);
    }
}

describe("accountRoutes (AccountChange integration)", () => {
    it("marks account settings change and emits update using returned cursor", async () => {
        txAccountFindUnique = vi.fn(async () => ({ settings: "old", settingsVersion: 1 }));
        txAccountUpdateMany = vi.fn(async () => ({ count: 1 }));

        const { accountRoutes } = await import("./accountRoutes");
        const app = new FakeApp();
        accountRoutes(app as any);

        const handler = app.routes.get("POST /v1/account/settings");
        const reply = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };

        const response = await handler(
            { userId: "u1", body: { settings: "new", expectedVersion: 1 } },
            reply,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "account", entityId: "self" }),
        );

        expect(buildUpdateAccountUpdate).toHaveBeenCalledWith("u1", expect.anything(), 444, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(response).toEqual({ success: true, version: 2 });
    });
});
