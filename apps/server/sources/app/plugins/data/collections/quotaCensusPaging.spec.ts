import { describe, expect, it } from 'vitest';

import type { Tx } from '@/storage/inTx';

import {
    readPluginCollectionAccountActivationUsageInTx,
    readPluginCollectionAccountUsageInTx,
} from './quota';

const CONTRACT = Object.freeze({
    id: 'contract-1',
    pluginId: 'example.paging',
    collectionId: 'tasks',
    schemaVersion: 1,
    contractDigest: 'd'.repeat(43),
    normalizedSchema: {},
    indexes: [],
    relations: [],
    privacyProjection: {},
});

type FindManyArgs = Readonly<{
    where: Readonly<{ accountId: string; deletedAt: null; id?: Readonly<{ gt: string }> }>;
    orderBy: unknown;
    take: number;
}>;

/**
 * The database is the only boundary the census touches. This stand-in serves a
 * deterministic live-row set through the same keyset contract a provider would
 * and records exactly what each page asked for.
 */
function censusTx(input: Readonly<{ rows: number; bodyBytes: number }>): Readonly<{
    tx: Tx;
    calls: FindManyArgs[];
}> {
    const body = 'x'.repeat(input.bodyBytes);
    const rows = Array.from({ length: input.rows }, (_, index) => ({
        id: `row-${String(index).padStart(8, '0')}`,
        pluginId: CONTRACT.pluginId,
        collectionId: CONTRACT.collectionId,
        rowId: `r-${index}`,
        contentEnvelope: { t: 'plain', v: { body } },
        contract: CONTRACT,
        projections: [] as readonly Readonly<{ fieldId: string; typedEncodedValue: string }>[],
    }));
    const calls: FindManyArgs[] = [];
    const tx = {
        pluginCollectionRow: {
            findMany: async (args: FindManyArgs) => {
                calls.push(args);
                const after = args.where.id?.gt;
                const start = after === undefined
                    ? 0
                    : rows.findIndex((row) => row.id === after) + 1;
                return rows.slice(start, start + args.take);
            },
        },
    } as unknown as Tx;
    return { tx, calls };
}

const deployment = Object.freeze({
    maxRowEncodedBytes: 512 * 1024,
    maxBatchBytes: 16 * 1024 * 1024,
    maxBatchRows: 100,
    maxAccountRows: 10_000,
    maxAccountBytes: 256 * 1024 * 1024,
});

describe('Plugin Collection quota census paging', () => {
    it('does not derive its database page size from the inbound mutation batch limit', async () => {
        // `maxBatchRows` bounds how many row operations one client request may
        // carry. An operator may lower it to 1 without asking the server to
        // read this Account one row at a time.
        const { tx, calls } = censusTx({ rows: 2_500, bodyBytes: 64 });
        const usage = await readPluginCollectionAccountUsageInTx({
            tx,
            accountId: 'account-1',
            deployment: { ...deployment, maxBatchRows: 1 },
        });

        expect(usage.rows).toBe(2_500);
        expect(calls.length).toBeLessThanOrEqual(8);
        expect(calls.every((call) => call.take > 1)).toBe(true);
    });

    it('bounds the first page by the deployment row-byte ceiling and then follows observed row sizes', async () => {
        const { tx, calls } = censusTx({ rows: 2_500, bodyBytes: 64 });
        await readPluginCollectionAccountUsageInTx({
            tx,
            accountId: 'account-1',
            deployment,
        });

        const first = calls[0];
        const second = calls[1];
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        // A page sized for rows at the 512 KiB ceiling stays small; once the
        // census has measured real rows the page grows to its round-trip cap.
        expect(first!.take).toBeLessThanOrEqual(64);
        expect(second!.take).toBeGreaterThan(first!.take);
    });

    it('keeps the page small when the Account really does hold ceiling-sized rows', async () => {
        const { tx, calls } = censusTx({ rows: 400, bodyBytes: 512 * 1024 });
        await readPluginCollectionAccountActivationUsageInTx({
            tx,
            accountId: 'account-1',
            deployment,
        });

        expect(calls.every((call) => call.take <= 64)).toBe(true);
    });

    it('asks the provider for the account-live keyset order the supporting index serves', async () => {
        // Measured on PostgreSQL 16: with only `ORDER BY id`, the planner keeps
        // the primary-key scan under LIMIT and filters every other tenant's
        // rows out (200,000 rows removed, 17,443 buffers for one page). Naming
        // the index's own column order collapses that to 12 buffers.
        const { tx, calls } = censusTx({ rows: 300, bodyBytes: 64 });
        await readPluginCollectionAccountUsageInTx({
            tx,
            accountId: 'account-1',
            deployment,
        });

        for (const call of calls) {
            expect(call.orderBy).toEqual([
                { accountId: 'asc' },
                { deletedAt: 'asc' },
                { id: 'asc' },
            ]);
            expect(call.where.accountId).toBe('account-1');
            expect(call.where.deletedAt).toBeNull();
        }
        expect(calls.slice(1).every((call) => typeof call.where.id?.gt === 'string')).toBe(true);
    });
});
