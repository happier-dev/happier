import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import type { Tx } from '@/storage/inTx';

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

const txDbMocks = createDbMocks({
    account: ["update"],
    accountChange: ["upsert"],
    session: ["findUnique"],
    machine: ["findUnique"],
} as const);

const transaction = vi.fn(async <T>(
    fn: (tx: typeof txDbMocks.db) => Promise<T>,
): Promise<T> => await fn(txDbMocks.db));

installDbModuleMock(() => ({
    db: {
        $transaction: transaction,
    },
}));

// Install the database boundary before the event graph can load inTx.
const { eventRouter } = await import("../events/eventRouter");

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
        txDbMocks.db.session.findUnique.mockResolvedValue({ id: 'session-one' });
        txDbMocks.db.machine.findUnique.mockResolvedValue({ id: 'machine-one' });
    });

    it('publishes row-only Session routing only when every coalesced Session write is row-only', async () => {
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        const { inTx } = await import('@/storage/inTx');
        const { markAccountChanged } = await import('./markAccountChanged');
        const publish = (tx: Tx, hint: unknown) => markAccountChanged(tx, {
            accountId: 'account-1', kind: 'session', entityId: 'session-one', hint,
        });
        await inTx(tx => publish(tx, { runtimeActivityRevision: 1 }));
        expect(UpdateContainerSchema.parse(emit.mock.calls[0][1]).body).toMatchObject({
            t: 'account-change', changeKinds: ['session'], entityIds: ['session-one'], sessionSystemRecords: [],
        });
        for (const hints of [
            [{ runtimeActivityRevision: 2 }, { archivedAt: 3 }],
            [{ archivedAt: 3 }, { runtimeActivityRevision: 4 }],
            [undefined, { runtimeActivityRevision: 5 }],
        ]) {
            emit.mockClear();
            await inTx(async tx => { for (const hint of hints) await publish(tx, hint); });
            expect(UpdateContainerSchema.parse(emit.mock.calls[0][1]).body).toMatchObject({
                sessionSystemRecords: [{ sessionId: 'session-one' }],
            });
        }
        emit.mockClear();
        await inTx(async tx => {
            await publish(tx, { runtimeActivityRevision: 6 });
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'machine', entityId: 'machine-one' });
        });
        expect(UpdateContainerSchema.parse(emit.mock.calls[0][1]).body).toMatchObject({
            changeKinds: ['session', 'machine'], sessionSystemRecords: [],
        });
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

    it.each([1, 2])("coalesces twelve changes per Account into one post-commit wake for %i Account audiences", async accountCount => {
        const accounts = Array.from({ length: accountCount }, (_, index) => `account-${index + 1}`);
        const cursors = new Map<string, number>();
        txDbMocks.db.account.update.mockImplementation(async ({ where }: { where: { id: string } }) => {
            const seq = (cursors.get(where.id) ?? 0) + 1;
            cursors.set(where.id, seq);
            return { seq };
        });
        const order: string[] = [];
        const deliveries: Array<{ room: string | string[]; seq: number; body: unknown }> = [];
        const ioTo = vi.fn((room: string | string[]) => ({
            emit: vi.fn((_event: string, payload: unknown) => {
                const update = UpdateContainerSchema.parse(payload);
                order.push(`wake:${room}`);
                deliveries.push({ room, seq: update.seq, body: update.body });
            }),
            disconnectSockets: vi.fn(),
        }));
        eventRouter.setIo({ to: ioTo });
        transaction.mockImplementation(async <T>(fn: (tx: typeof txDbMocks.db) => Promise<T>): Promise<T> => {
            const before = deliveries.length;
            const result = await fn(txDbMocks.db);
            expect(deliveries).toHaveLength(before);
            order.push("commit");
            return result;
        });

        const { afterTx, inTx } = await import("@/storage/inTx");
        const { afterAccountChangePublication, markAccountChanged } = await import("./markAccountChanged");
        const publications = await inTx(async tx => {
            afterTx(tx, () => { order.push("before-wakes"); });
            const publications = [];
            for (const accountId of accounts) for (let index = 0; index < 12; index++) {
                publications.push(await markAccountChanged(tx, {
                    accountId, kind: "account", entityId: `entity-${index}`, hint: { keys: [`key-${index}`] },
                }));
            }
            afterAccountChangePublication(tx, async () => {
                afterTx(tx, () => { order.push("after-wakes"); });
            });
            return publications;
        });

        expect(publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() })))
            .toEqual(accounts.flatMap(accountId => Array.from({ length: 12 }, (_, index) => ({ accountId, cursor: index + 1 }))));
        expect(txDbMocks.db.accountChange.upsert).toHaveBeenCalledTimes(12 * accountCount);
        expect(deliveries).toEqual(accounts.map(accountId => ({
            room: `account-stored-content-v3:${accountId}`, seq: 12, body: { t: "account-change" },
        })));
        expect(order).toEqual(["commit", "before-wakes", ...accounts.map(id => `wake:account-stored-content-v3:${id}`), "after-wakes"]);

        // A later transaction must get its own wake, even on the same DB proxy.
        await inTx(tx => markAccountChanged(tx, { accountId: "account-1", kind: "account", entityId: "later" }));
        expect(deliveries).toHaveLength(accountCount + 1);
        expect(deliveries.at(-1)).toEqual({ room: "account-stored-content-v3:account-1", seq: 13, body: { t: "account-change" } });
    });

    it("discards the failed attempt's coalesced audience before replaying", async () => {
        const ioTo = vi.fn(() => ({ emit: vi.fn(), disconnectSockets: vi.fn() }));
        eventRouter.setIo({ to: ioTo });
        const { inTx, TransactionReplayRequiredError } = await import("@/storage/inTx");
        const { markAccountChanged } = await import("./markAccountChanged");
        transaction.mockImplementationOnce(async <T>(fn: (tx: typeof txDbMocks.db) => Promise<T>): Promise<T> => {
            await fn(txDbMocks.db);
            throw new TransactionReplayRequiredError("transaction-account-audience-changed");
        });
        let attempts = 0;
        await inTx(async tx => {
            attempts++;
            await markAccountChanged(tx, { accountId: "account-1", kind: "account", entityId: "self" });
            if (attempts === 1) await markAccountChanged(tx, { accountId: "retired-recipient", kind: "account", entityId: "self" });
        });
        expect(attempts).toBe(2);
        expect(ioTo.mock.calls).toEqual([["account-stored-content-v3:account-1"]]);
    });
});
