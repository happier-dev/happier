import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import type { Tx } from '@/storage/inTx';

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

const txDbMocks = createDbMocks({
    account: ["update"],
    accountChange: ["findUnique", "upsert"],
    session: ["findUnique"],
    machine: ["findUnique"],
    artifact: ["findUnique"],
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
        txDbMocks.db.accountChange.findUnique.mockResolvedValue(null);
        txDbMocks.db.accountChange.upsert.mockResolvedValue({});
        txDbMocks.db.session.findUnique.mockResolvedValue({ id: 'session-one' });
        txDbMocks.db.machine.findUnique.mockResolvedValue({ id: 'machine-one' });
        txDbMocks.db.artifact.findUnique.mockResolvedValue({ id: 'artifact-one', kind: 'v1:other:bot_template.v1' });
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

    it('routes known Artifact publications by their stored kind and keeps a mixed unknown wake coarse', async () => {
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        const { inTx } = await import('@/storage/inTx');
        const { markAccountChanged, markAccountsChanged } = await import('./markAccountChanged');
        await inTx(tx => markAccountsChanged(tx, { accountIds: ['new-recipient'], kind: 'artifact', entityId: 'artifact-one' }));
        expect(UpdateContainerSchema.parse(emit.mock.calls[0][1]).body).toMatchObject({
            t: 'account-change', artifactKinds: ['v1:other:bot_template.v1'],
        });
        emit.mockClear();
        txDbMocks.db.artifact.findUnique
            .mockResolvedValueOnce({ id: 'artifact-one', kind: 'v1:other:bot_template.v1' })
            .mockResolvedValueOnce({ id: 'legacy', kind: null });
        await inTx(async tx => {
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'artifact', entityId: 'artifact-one' });
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'artifact', entityId: 'legacy' });
        });
        expect(UpdateContainerSchema.parse(emit.mock.calls[0][1]).body).not.toHaveProperty('artifactKinds');
    });

    afterEach(() => {
        if (originalDbProvider === undefined) delete process.env.HAPPIER_DB_PROVIDER;
        else process.env.HAPPIER_DB_PROVIDER = originalDbProvider;
        eventRouter.clearIo();
    });

    it('publishes settings versions separately from unrelated inventory changes in the same transaction', async () => {
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        const { inTx } = await import('@/storage/inTx');
        const { markAccountChanged } = await import('./markAccountChanged');
        await inTx(async tx => {
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'account', entityId: 'self', hint: { settingsVersion: 7 } });
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'account', entityId: 'self', hint: { settingsVersion: 8 } });
        });
        expect.soft(emit.mock.calls.map(([, payload]) => UpdateContainerSchema.parse(payload).body))
            .toEqual([{ t: 'account-settings-changed', settingsVersion: 8 }]);
        emit.mockClear();
        await inTx(async tx => {
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'account', entityId: 'self', hint: { settingsVersion: 9 } });
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'machine', entityId: 'machine-one' });
        });
        expect.soft(emit.mock.calls.map(([, payload]) => UpdateContainerSchema.parse(payload).body))
            .toEqual([{ t: 'account-settings-changed', settingsVersion: 9 },
                { t: 'account-change', changeKinds: ['machine'], entityIds: ['machine-one'] }]);
        emit.mockClear();
        await inTx(async tx => {
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'account', entityId: 'self', hint: { settingsVersion: 10 } });
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'account', entityId: 'self' });
        });
        expect(emit.mock.calls.map(([, payload]) => UpdateContainerSchema.parse(payload).body))
            .toContainEqual({ t: 'account-change', changeKinds: ['account'], entityIds: ['self'] });
    });

    it('does not classify malformed or broader self hints as settings-only', async () => {
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        const { inTx } = await import('@/storage/inTx');
        const { markAccountChanged } = await import('./markAccountChanged');
        for (const hint of [{}, { settingsVersion: '8' }, { settingsVersion: -1 }, { settingsVersion: 1.5 },
            { settingsVersion: 8, encryptionMode: 'plain' }]) {
            emit.mockClear();
            await inTx(tx => markAccountChanged(tx, { accountId: 'account-1', kind: 'account', entityId: 'self', hint }));
            expect(emit.mock.calls.map(([, payload]) => UpdateContainerSchema.parse(payload).body))
                .toEqual([{ t: 'account-change', changeKinds: ['account'], entityIds: ['self'] }]);
        }
    });

    it('keeps addressed record invalidation through a coalesced transcript wake without exposing record content', async () => {
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        const target = { sessionId: 'session-one', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' } };
        const { inTx } = await import('@/storage/inTx');
        const { markAccountChanged } = await import('./markAccountChanged');
        await inTx(async tx => {
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'account', entityId: 'session-record:record-one',
                hint: { v: 1, sessionRecords: target } });
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'session', entityId: 'session-one',
                hint: { lastMessageSeq: 1, lastMessageId: 'ordinary-message' } });
            // Entity strings are qualified by kind in the durable owner too.
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'share', entityId: 'session-record:record-one' });
        });
        expect(emit).toHaveBeenCalledTimes(1);
        expect(UpdateContainerSchema.parse(emit.mock.calls[0][1]).body).toMatchObject({ sessionSystemRecords: [target, { sessionId: 'session-record:record-one' }] });
    });

    it('excludes transcript-only refreshes but preserves access and unknown Account recovery', async () => {
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        const { inTx } = await import('@/storage/inTx');
        const { markAccountChanged } = await import('./markAccountChanged');
        await inTx(tx => markAccountChanged(tx, { accountId: 'account-1', kind: 'session', entityId: 'session-one',
            hint: { lastMessageSeq: 2 } }));
        expect(UpdateContainerSchema.parse(emit.mock.calls[0][1]).body).toMatchObject({ sessionSystemRecords: [] });
        emit.mockClear();
        await inTx(async tx => {
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'session', entityId: 'session-one', hint: { lastMessageSeq: 3 } });
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'share', entityId: 'session-one' });
        });
        expect(UpdateContainerSchema.parse(emit.mock.calls[0][1]).body).toMatchObject({ sessionSystemRecords: [{ sessionId: 'session-one' }] });
        emit.mockClear();
        await inTx(async tx => {
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'account', entityId: 'self' });
            await markAccountChanged(tx, { accountId: 'account-1', kind: 'session', entityId: 'session-one', hint: { lastMessageSeq: 4 } });
        });
        expect(UpdateContainerSchema.parse(emit.mock.calls[0][1]).body).not.toHaveProperty('sessionSystemRecords');
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
            body: { t: "account-change", changeKinds: ["pluginDomain"],
                entityIds: ["pluginDomain/example.tasks/availability"] },
        }));
        const payload = emit.mock.calls[0]?.[1] as { body?: unknown } | undefined;
        expect(payload?.body).toEqual({ t: "account-change", changeKinds: ["pluginDomain"],
            entityIds: ["pluginDomain/example.tasks/availability"] });
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

    it("keeps a wake without allocation metadata coarse for the exact-Machine webhook producer", async () => {
        const { buildAccountChangeWakeUpdate } = await import("../events/eventPayloadBuilders");
        expect(UpdateContainerSchema.parse(buildAccountChangeWakeUpdate(7, "coarse-webhook-wake")).body)
            .toEqual({ t: "account-change" });
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
                    accountId, kind: index % 2 === 0 ? "account" : "savedSecretResource",
                    entityId: `${accountId}-entity-${index % 6}`, hint: { keys: [`private-key-${index}`] },
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
            room: `account-stored-content-v3:${accountId}`, seq: 12,
            body: { t: "account-change", changeKinds: ["account", "savedSecretResource"],
                entityIds: Array.from({ length: 6 }, (_, index) => `${accountId}-entity-${index}`) },
        })));
        expect(order).toEqual(["commit", "before-wakes", ...accounts.map(id => `wake:account-stored-content-v3:${id}`), "after-wakes"]);

        // A later transaction must get its own wake, even on the same DB proxy.
        await inTx(tx => markAccountChanged(tx, { accountId: "account-1", kind: "account", entityId: "later" }));
        expect(deliveries).toHaveLength(accountCount + 1);
        expect(deliveries.at(-1)).toEqual({ room: "account-stored-content-v3:account-1", seq: 13,
            body: { t: "account-change", changeKinds: ["account"], entityIds: ["later"] } });
    });

    it("discards the failed attempt's coalesced audience before replaying", async () => {
        const emit = vi.fn();
        const ioTo = vi.fn((_room: string | string[]) => ({ emit, disconnectSockets: vi.fn() }));
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
            if (attempts === 1) {
                await markAccountChanged(tx, { accountId: "account-1", kind: "savedSecretResource", entityId: "failed-only" });
                await markAccountChanged(tx, { accountId: "retired-recipient", kind: "account", entityId: "self" });
            }
        });
        expect(attempts).toBe(2);
        expect(ioTo.mock.calls).toEqual([["account-stored-content-v3:account-1"]]);
        expect(emit).toHaveBeenCalledExactlyOnceWith("update", expect.objectContaining({
            body: { t: "account-change", changeKinds: ["account"], entityIds: ["self"] },
        }));
    });
});
