import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { afterEach, describe, expect, it, vi } from "vitest";

import { inTxPostgresControlStatementMock, installDbModuleMock } from "../api/testkit/dbMocks";

const transaction = vi.fn();
installDbModuleMock(() => ({
    db: {
        $transaction: transaction,
    },
}));
// Module transformation belongs to suite collection, outside per-test hooks.
const { eventRouter } = await import("../events/eventRouter");

type MarkAccountChangedParams = Parameters<typeof import("./markAccountChanged").markAccountChanged>[1];
type MarkAccountsChangedParams = Parameters<typeof import("./markAccountChanged").markAccountsChanged>[1];

async function runMarkAccountChanged(tx: object, params: MarkAccountChangedParams): Promise<number> {
    transaction.mockImplementationOnce(async (fn: (transactionTx: object) => Promise<number>) => await fn({ ...inTxPostgresControlStatementMock, ...tx }));
    const [{ inTx, transactionResult }, { markAccountChanged }] = await Promise.all([
        import("@/storage/inTx"),
        import("./markAccountChanged"),
    ]);
    return await inTx(async (transactionTx) => {
        const publication = await markAccountChanged(transactionTx, params);
        return transactionResult(() => publication.resolveCursor());
    });
}

async function runMarkAccountsChanged(
    tx: object,
    params: MarkAccountsChangedParams,
): Promise<ReadonlyArray<{ accountId: string; cursor: number }>> {
    transaction.mockImplementationOnce(async (fn: (transactionTx: object) => Promise<ReadonlyArray<{ accountId: string; cursor: number }>>) => await fn({ ...inTxPostgresControlStatementMock, ...tx }));
    const [{ inTx, transactionResult }, { markAccountsChanged }] = await Promise.all([
        import("@/storage/inTx"),
        import("./markAccountChanged"),
    ]);
    return await inTx(async (transactionTx) => {
        const publications = await markAccountsChanged(transactionTx, params);
        return transactionResult(() => publications.map(publication => ({
            accountId: publication.accountId,
            cursor: publication.resolveCursor(),
        })));
    });
}

describe("markAccountChanged", () => {
    const originalDbProvider = process.env.HAPPIER_DB_PROVIDER;
    afterEach(() => {
        process.env.HAPPIER_DB_PROVIDER = originalDbProvider;
        eventRouter.clearIo();
    });

    it.each([{ settingsVersion: 7 }, { username: true }])('replaces retained legacy connected service hints on ordinary self writes (%j)', async next => {
        process.env.HAPPIER_DB_PROVIDER = 'sqlite';
        let hint: unknown = { connectedServices: true };
        let seq = 0;
        const tx = {
            account: { update: vi.fn(async () => ({ seq: ++seq })) },
            accountChange: {
                findUnique: vi.fn(async () => hint === null ? null : { hint }),
                upsert: vi.fn(async (input: { update: { hint: unknown } }) => { hint = input.update.hint; return {}; }),
            },
        };
        await runMarkAccountChanged(tx, { accountId: 'a1', kind: 'account', entityId: 'self', hint: next });
        expect(hint).toEqual(next);
    });

    it("resolves publication results after terminal writes and before commit", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const phases: string[] = [];
        const tx = {
            account: { update: vi.fn(async () => { phases.push("allocate"); return { seq: 7 }; }) },
            accountChange: { upsert: vi.fn(async () => { phases.push("publish"); return {}; }) },
        };
        transaction.mockImplementationOnce(async fn => {
            const result = await fn(tx);
            phases.push("commit");
            return result;
        });
        const { inTx, afterTx, transactionResult } = await import("@/storage/inTx");
        const { markAccountChanged } = await import("./markAccountChanged");

        await expect(inTx(async transactionTx => {
            const publication = await markAccountChanged(transactionTx, {
                accountId: "a1", kind: "account", entityId: "settings",
            });
            expect(tx.account.update).not.toHaveBeenCalled();
            expect(tx.accountChange.upsert).not.toHaveBeenCalled();
            expect(() => publication.resolveCursor()).toThrow();
            afterTx(transactionTx, () => {
                expect(publication.resolveCursor()).toBe(7);
                phases.push("after-commit");
            });
            phases.push("domain");
            return transactionResult(() => {
                phases.push("project");
                return { cursor: publication.resolveCursor() };
            });
        })).resolves.toEqual({ cursor: 7 });

        expect(phases).toEqual(["domain", "allocate", "publish", "project", "commit", "after-commit"]);
    });

    it("isolates overlapping publication phases and after-commit callbacks on a reused database facade", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        let seq = 0;
        const changes: string[] = [];
        const committed: string[] = [];
        const tx = {
            account: { update: vi.fn(async () => ({ seq: ++seq })) },
            accountChange: { upsert: vi.fn(async ({ create }: { create: { entityId: string } }) => {
                changes.push(create.entityId);
                return {};
            }) },
        };
        // Prisma facades may share a backing object. Transaction lifecycle
        // state must belong to each managed attempt rather than that object.
        transaction.mockImplementationOnce(async fn => await fn(tx));
        transaction.mockImplementationOnce(async fn => await fn(tx));
        const { inTx, afterTx, transactionResult } = await import("@/storage/inTx");
        const { markAccountChanged } = await import("./markAccountChanged");
        let recorded!: () => void;
        const firstRecorded = new Promise<void>(resolve => { recorded = resolve; });
        let release!: () => void;
        const mayFinish = new Promise<void>(resolve => { release = resolve; });
        const first = inTx(async transactionTx => {
            const publication = await markAccountChanged(transactionTx, {
                accountId: "a1", kind: "account", entityId: "first",
            });
            afterTx(transactionTx, () => { committed.push("first"); });
            recorded();
            await mayFinish;
            return transactionResult(() => publication.resolveCursor());
        });
        const firstOutcome = Promise.allSettled([first]);
        await Promise.race([firstRecorded, firstOutcome.then(() => { throw new Error("First transaction ended before recording"); })]);
        let failure: unknown;
        try {
            await expect(inTx(async transactionTx => {
                const publication = await markAccountChanged(transactionTx, {
                    accountId: "a1", kind: "account", entityId: "second",
                });
                afterTx(transactionTx, () => { committed.push("second"); });
                return transactionResult(() => publication.resolveCursor());
            })).resolves.toBe(1);
            expect(changes).toEqual(["second"]);
            expect(committed).toEqual(["second"]);
        } catch (error) {
            failure = error;
        } finally { release(); }
        const [outcome] = await firstOutcome;
        if (failure !== undefined) throw failure;
        if (outcome.status === "rejected") throw outcome.reason;
        expect(outcome.value).toBe(2);
        expect(changes).toEqual(["second", "first"]);
        expect(committed).toEqual(["second", "first"]);
    });

    it("uses the atomic postgres fast path when raw query execution is available", async () => {
        process.env.HAPPIER_DB_PROVIDER = "postgres";
        const tx: any = {
            $queryRawUnsafe: vi.fn().mockResolvedValue([{ cursor: 7 }]),
            account: {
                update: vi.fn(),
            },
            accountChange: {
                upsert: vi.fn(),
            },
        };

        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        const cursor = await runMarkAccountChanged(tx, {
            accountId: "a1",
            kind: "session",
            entityId: "s1",
            hint: { lastMessageSeq: 123 },
        });

        expect(cursor).toBe(7);
        expect(tx.$queryRawUnsafe).toHaveBeenCalled();
        expect(tx.account.update).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
        expect(UpdateContainerSchema.parse(emit.mock.calls[0][1]).body).toEqual({
            t: "account-change", changeKinds: ["session"], entityIds: ["s1"], sessionSystemRecords: [],
        });
    });

    it("carries every PostgreSQL Session-set identity only to its allocated Account audience", async () => {
        process.env.HAPPIER_DB_PROVIDER = "postgres";
        const tx = { $queryRawUnsafe: vi.fn().mockResolvedValue([
            { accountId: "a2", cursor: 24 }, { accountId: "a1", cursor: 12 }, { accountId: "a1", cursor: 11 },
        ]) };
        const deliveries: Array<{ room: string | string[]; seq: number; body: unknown }> = [];
        eventRouter.setIo({ to: room => ({ disconnectSockets: vi.fn(), emit: (_event, payload) => {
            const update = UpdateContainerSchema.parse(payload);
            deliveries.push({ room, seq: update.seq, body: update.body });
        } }) });
        transaction.mockImplementationOnce(async fn => fn({ ...inTxPostgresControlStatementMock, ...tx }));
        const { inTx } = await import("@/storage/inTx");
        const { markSessionAccountsChanged } = await import("./markAccountChanged");
        const publications = await inTx(transactionTx => markSessionAccountsChanged(transactionTx, new Map([
            ["s1", ["a2", "a1", "a1"]], ["s2", ["a1"]],
        ])));
        expect(publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() })))
            .toEqual([{ accountId: "a1", cursor: 11 }, { accountId: "a1", cursor: 12 }, { accountId: "a2", cursor: 24 }]);
        expect(deliveries).toEqual([
            { room: "account-stored-content-v3:a1", seq: 12,
                body: { t: "account-change", changeKinds: ["session"], entityIds: ["s1", "s2"],
                    sessionSystemRecords: [{ sessionId: "s1" }, { sessionId: "s2" }] } },
            { room: "account-stored-content-v3:a2", seq: 24,
                body: { t: "account-change", changeKinds: ["session"], entityIds: ["s1"],
                    sessionSystemRecords: [{ sessionId: "s1" }] } },
        ]);
    });

    it("falls back to the Prisma update + upsert path outside the postgres raw fast path", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const tx: any = {
            session: { findUnique: vi.fn().mockResolvedValue({ id: "s1" }) },
            account: {
                update: vi.fn().mockResolvedValue({ seq: 7 }),
            },
            accountChange: {
                upsert: vi.fn().mockResolvedValue({}),
            },
        };

        eventRouter.setIo({ to: vi.fn(() => ({ emit: vi.fn() })) } as any);
        const cursor = await runMarkAccountChanged(tx, {
            accountId: "a1",
            kind: "session",
            entityId: "s1",
            hint: { lastMessageSeq: 123 },
        });

        expect(cursor).toBe(7);

        expect(tx.account.update).toHaveBeenCalledWith({
            where: { id: "a1" },
            data: { seq: { increment: 1 } },
            select: { seq: true },
        });

        expect(tx.accountChange.upsert).toHaveBeenCalledWith({
            where: {
                accountId_kind_entityId: { accountId: "a1", kind: "session", entityId: "s1" },
            },
            create: {
                accountId: "a1",
                kind: "session",
                entityId: "s1",
                sessionId: "s1",
                cursor: 7,
                changedAt: expect.any(Date),
                hint: { lastMessageSeq: 123 },
            },
            update: {
                sessionId: "s1",
                cursor: 7,
                changedAt: expect.any(Date),
                hint: { lastMessageSeq: 123 },
            },
        });
    });

    it("keeps a retained full Collection reread broad in the Prisma fallback", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const existingHint = {
            pluginDomain: "dataCollection",
            pluginId: "example.tasks",
            collectionId: "tasks",
            contractDigest: "a".repeat(43),
            revision: 4,
            full: true,
        };
        const tx: any = {
            account: {
                update: vi.fn().mockResolvedValue({ seq: 7 }),
            },
            accountChange: {
                findUnique: vi.fn().mockResolvedValue({ hint: existingHint }),
                upsert: vi.fn().mockResolvedValue({}),
            },
        };

        await expect(runMarkAccountChanged(tx, {
            accountId: "a1",
            kind: "pluginDomain",
            entityId: "pluginDomain/example.tasks/data-collection/tasks",
            hint: {
                pluginDomain: "dataCollection",
                pluginId: "example.tasks",
                collectionId: "tasks",
                contractDigest: "b".repeat(43),
                revision: 5,
                rowIds: ["task-1"],
            },
        })).resolves.toBe(7);

        expect(tx.accountChange.findUnique).toHaveBeenCalledWith({
            where: {
                accountId_kind_entityId: {
                    accountId: "a1",
                    kind: "pluginDomain",
                    entityId: "pluginDomain/example.tasks/data-collection/tasks",
                },
            },
            select: { hint: true },
        });
        expect(tx.accountChange.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId: "example.tasks",
                    collectionId: "tasks",
                    contractDigest: "b".repeat(43),
                    revision: 5,
                    full: true,
                },
            }),
            update: expect.objectContaining({
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId: "example.tasks",
                    collectionId: "tasks",
                    contractDigest: "b".repeat(43),
                    revision: 5,
                    full: true,
                },
            }),
        }));
    });

    it("links pet changes to account pet packages in the Prisma fallback path", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const tx: any = {
            accountPetPackage: { findUnique: vi.fn().mockResolvedValue({ id: "pet-package-1" }) },
            account: {
                update: vi.fn().mockResolvedValue({ seq: 8 }),
            },
            accountChange: {
                upsert: vi.fn().mockResolvedValue({}),
            },
        };

        eventRouter.setIo({ to: vi.fn(() => ({ emit: vi.fn() })) } as any);
        const cursor = await runMarkAccountChanged(tx, {
            accountId: "a1",
            kind: "pet",
            entityId: "pet-package-1",
        });

        expect(cursor).toBe(8);
        expect(tx.accountChange.upsert).toHaveBeenCalledWith({
            where: {
                accountId_kind_entityId: { accountId: "a1", kind: "pet", entityId: "pet-package-1" },
            },
            create: {
                accountId: "a1",
                kind: "pet",
                entityId: "pet-package-1",
                accountPetPackageId: "pet-package-1",
                cursor: 8,
                changedAt: expect.any(Date),
                hint: undefined,
            },
            update: {
                accountPetPackageId: "pet-package-1",
                cursor: 8,
                changedAt: expect.any(Date),
                hint: undefined,
            },
        });
    });

    it("throws on missing required params", async () => {
        const tx: any = {
            account: { update: vi.fn() },
            accountChange: { upsert: vi.fn() },
        };

        await expect(runMarkAccountChanged(tx, { accountId: "", kind: "k" as any, entityId: "e" })).rejects.toThrow(/accountId/i);
        await expect(runMarkAccountChanged(tx, { accountId: "a", kind: "" as any, entityId: "e" })).rejects.toThrow(/kind/i);
        await expect(runMarkAccountChanged(tx, { accountId: "a", kind: "session", entityId: "" })).rejects.toThrow(/entityId/i);
    });

    it("rejects malformed or mismatched pluginDomain facts before allocating a cursor", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const tx: any = {
            account: {
                update: vi.fn().mockResolvedValue({ seq: 9 }),
            },
            accountChange: {
                upsert: vi.fn().mockResolvedValue({}),
            },
        };

        await expect(runMarkAccountChanged(tx, {
            accountId: "a1",
            kind: "pluginDomain",
            entityId: "pluginDomain/example.tasks/settings",
            hint: {
                pluginDomain: "dataCollection",
                pluginId: "example.tasks",
                collectionId: "tasks",
                contractDigest: "a".repeat(43),
                revision: 1,
                full: true,
            },
        })).rejects.toThrow(/entityId/i);
        await expect(runMarkAccountChanged(tx, {
            accountId: "a1",
            kind: "pluginDomain",
            entityId: "pluginDomain/example.tasks/availability",
            hint: {
                pluginDomain: "availability",
                pluginId: "example.tasks",
                status: "ready",
            },
        })).rejects.toThrow(/pluginDomain/i);

        expect(tx.account.update).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("preserves each Session recipient hint and foreign key in an ordered audience", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const changes: Array<{ accountId: string; sessionId: string; hint: unknown; cursor: number }> = [];
        const tx = {
            session: { findUnique: vi.fn(async () => ({ id: "session-1" })) },
            account: {
                update: vi.fn(async ({ where }: { where: { id: string } }) => ({ seq: where.id === "a1" ? 11 : 24 })),
                updateMany: vi.fn(async () => ({ count: 2 })),
                findMany: vi.fn(async () => [{ id: "a1", seq: 11 }, { id: "a2", seq: 24 }]),
            },
            accountChange: {
                findMany: vi.fn(async () => []),
                deleteMany: vi.fn(async () => ({ count: 0 })),
                createMany: vi.fn(async ({ data }: { data: typeof changes }) => { changes.push(...data); }),
                upsert: vi.fn(async ({ create }: { create: typeof changes[number] }) => { changes.push(create); }),
            },
        };

        const cursors = await runMarkAccountsChanged(tx, {
            accountIds: ["a2", "a1", "a2"],
            kind: "session",
            entityId: "session-1",
            hintForAccount: accountId => ({ sharedMetadataVersion: accountId === "a1" ? 3 : 5 }),
        });

        expect(cursors).toEqual([{ accountId: "a1", cursor: 11 }, { accountId: "a2", cursor: 24 }]);
        expect(changes).toEqual([
            expect.objectContaining({ accountId: "a1", sessionId: "session-1", hint: { sharedMetadataVersion: 3 }, cursor: 11 }),
            expect.objectContaining({ accountId: "a2", sessionId: "session-1", hint: { sharedMetadataVersion: 5 }, cursor: 24 }),
        ]);
    });

    it("publishes one Account projection change to a recipient set with bounded database operations", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const tx: any = {
            $executeRawUnsafe: vi.fn().mockResolvedValue(2),
            account: {
                findMany: vi.fn().mockResolvedValue([
                    { id: "a1", seq: 11 },
                    { id: "a2", seq: 24 },
                ]),
            },
            accountChange: {
                deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
                createMany: vi.fn().mockResolvedValue({ count: 2 }),
            },
        };

        const cursors = await runMarkAccountsChanged(tx, {
            accountIds: ["a2", "a1", "a2"],
            entityId: "teams",
        });

        expect(cursors).toEqual([
            { accountId: "a1", cursor: 11 },
            { accountId: "a2", cursor: 24 },
        ]);
        expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
        expect(tx.account.findMany).toHaveBeenCalledTimes(1);
        expect(tx.accountChange.deleteMany).toHaveBeenCalledTimes(1);
        expect(tx.accountChange.createMany).toHaveBeenCalledTimes(1);
        expect(tx.accountChange.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({ accountId: "a1", kind: "account", entityId: "teams", cursor: 11 }),
                expect.objectContaining({ accountId: "a2", kind: "account", entityId: "teams", cursor: 24 }),
            ],
        });
    });

    it("publishes a Saved Secret resource invalidation to the recipient set without a Session foreign key", async () => {
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const tx: any = {
            $executeRawUnsafe: vi.fn().mockResolvedValue(2),
            account: {
                findMany: vi.fn().mockResolvedValue([
                    { id: "owner", seq: 12 },
                    { id: "recipient", seq: 25 },
                ]),
            },
            accountChange: {
                deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
                createMany: vi.fn().mockResolvedValue({ count: 2 }),
            },
        };

        await runMarkAccountsChanged(tx, {
            accountIds: ["recipient", "owner"],
            kind: "savedSecretResource",
            entityId: "resource-1",
        });

        expect(tx.accountChange.createMany.mock.calls[0][0].data
            .every((row: { sessionId?: unknown }) => row.sessionId === undefined)).toBe(true);
        expect(tx.accountChange.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({ accountId: "owner", kind: "savedSecretResource", entityId: "resource-1", cursor: 12 }),
                expect.objectContaining({ accountId: "recipient", kind: "savedSecretResource", entityId: "resource-1", cursor: 25 }),
            ],
        });
    });
});
