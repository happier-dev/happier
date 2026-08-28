import { beforeEach, describe, expect, it, vi } from "vitest";
const deletion = vi.hoisted(() => vi.fn(async () => ({ status: "deleted" as const })));
vi.mock("@/app/plugins/data/accountDataErase", () => ({ deleteAccountForErasure: deletion }));
import { registerAccountErasureRoute } from "./registerAccountErasureRoute";

describe("registerAccountErasureRoute", () => {
    beforeEach(() => deletion.mockClear());
    it("selects only the authenticated Account and disconnects its sockets after deletion", async () => {
        let handler: any;
        const app: any = { authenticate: vi.fn(), disconnectAccountSockets: vi.fn(), post: vi.fn((_path: string, _options: unknown, next: any) => { handler = next; }) };
        registerAccountErasureRoute(app);
        const reply: any = { send: vi.fn(async (body) => body), code: vi.fn() };
        await expect(handler({ userId: "present-user", validationError: null }, reply)).resolves.toEqual({ status: "deleted" });
        expect(deletion).toHaveBeenCalledWith({ accountId: "present-user" });
        expect(app.disconnectAccountSockets).toHaveBeenCalledWith("present-user");
    });
    it("rejects malformed confirmation before deletion", async () => {
        let handler: any;
        const app: any = { authenticate: vi.fn(), disconnectAccountSockets: vi.fn(), post: vi.fn((_p: string, _o: unknown, next: any) => { handler = next; }) };
        registerAccountErasureRoute(app);
        const send = vi.fn(async (body) => body); const code = vi.fn(() => ({ send }));
        await expect(handler({ userId: "present-user", validationError: new Error("bad") }, { code })).resolves.toEqual({ error: "invalid_request" });
        expect(deletion).not.toHaveBeenCalled();
    });
});
