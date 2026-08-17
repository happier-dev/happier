import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";
import { eventRouter } from "../events/eventRouter";

const txDbMocks = createDbMocks({
    account: ["update"],
    accountChange: ["upsert"],
} as const);

const transaction = vi.fn(async <T>(
    fn: (tx: typeof txDbMocks.db) => Promise<T>,
): Promise<T> => await fn(txDbMocks.db));

installDbModuleMock(() => ({
    db: {
        $transaction: transaction,
    },
}));

describe("markAccountChanged live wake", () => {
    const originalDbProvider = process.env.HAPPIER_DB_PROVIDER;

    beforeEach(() => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        txDbMocks.reset();
        transaction.mockReset();
        transaction.mockImplementation(async <T>(
            fn: (tx: typeof txDbMocks.db) => Promise<T>,
        ): Promise<T> => await fn(txDbMocks.db));
        txDbMocks.db.account.update.mockResolvedValue({ seq: 7 });
        txDbMocks.db.accountChange.upsert.mockResolvedValue({});
    });

    afterEach(() => {
        if (originalDbProvider === undefined) delete process.env.HAPPIER_DB_PROVIDER;
        else process.env.HAPPIER_DB_PROVIDER = originalDbProvider;
        eventRouter.clearIo();
    });

    it("emits one V3-only content-free wake after the AccountChange transaction commits", async () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);

        const { inTx } = await import("@/storage/inTx");
        const { markAccountChanged } = await import("./markAccountChanged");
        await inTx(async (tx) => await markAccountChanged(tx, {
            accountId: "account-1",
            kind: "pluginDomain",
            entityId: "pluginDomain/example.tasks/availability",
            hint: {
                pluginDomain: "availability",
                pluginId: "example.tasks",
            },
        }));

        expect(ioTo).toHaveBeenCalledWith("account-stored-content-v3:account-1");
        expect(emit).toHaveBeenCalledWith("update", expect.objectContaining({
            seq: 7,
            body: { t: "account-change" },
        }));
        const payload = emit.mock.calls[0]?.[1] as { body?: unknown } | undefined;
        expect(payload?.body).toEqual({ t: "account-change" });
    });

    it("does not emit a wake when the AccountChange transaction rolls back", async () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);
        transaction.mockImplementationOnce(async <T>(
            fn: (tx: typeof txDbMocks.db) => Promise<T>,
        ): Promise<T> => {
            await fn(txDbMocks.db);
            throw new Error("rollback");
        });

        const { inTx } = await import("@/storage/inTx");
        const { markAccountChanged } = await import("./markAccountChanged");
        await expect(inTx(async (tx) => await markAccountChanged(tx, {
            accountId: "account-1",
            kind: "pluginDomain",
            entityId: "pluginDomain/example.tasks/availability",
            hint: {
                pluginDomain: "availability",
                pluginId: "example.tasks",
            },
        }))).rejects.toThrow("rollback");

        expect(ioTo).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });
});
