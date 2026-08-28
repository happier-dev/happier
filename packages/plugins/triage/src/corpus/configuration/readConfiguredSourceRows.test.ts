import { describe, expect, it } from 'vitest';

import { TriageConfiguredSourceInstanceV1Schema } from '@happier-dev/triage-protocol/v1';

import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../collections/ids.js';
import { toCorpusStoredValue } from '../collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import {
    readActiveConfiguredSourceRowPage,
    readActiveConfiguredSourceRows,
} from './readConfiguredSourceRows.js';

function sourceRow(seed: number) {
    const suffix = String(seed).padStart(12, '0');
    return {
        instanceTag: `a${String(seed).padStart(42, '0')}`,
        sourceQualifiedId: 'happier.example.source/example-forge',
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: seed,
        configured: TriageConfiguredSourceInstanceV1Schema.parse({
            v: 1,
            instance: {
                source: { pluginId: 'happier.example.source', localId: 'example-forge' },
                sourceInstanceId: `00000000-0000-4000-8000-${suffix}`,
            },
            binding: {
                purpose: 'triage-source',
                account: {
                    service: { pluginId: 'happier.example.source', localId: 'accounts' },
                    accountId: `account-${seed}`,
                },
            },
            localInstanceKey: `scope-${seed}`,
            configuration: { v: 1, token: `routing-token-${seed}` },
            locator: { v: 1, displayLabel: `Source ${seed}` },
        }),
    } as const;
}

describe('the canonical active configured-source read', () => {
    it('pages the Collection cursor while the full reader carries every configured source', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const count = 34;
        for (let seed = 1; seed <= count; seed += 1) {
            control.sourceInstances.seed(toCorpusStoredValue(sourceRow(seed)));
        }

        const first = await readActiveConfiguredSourceRowPage(collections.sourceInstances, { limit: 32 });
        const second = await readActiveConfiguredSourceRowPage(collections.sourceInstances, {
            limit: 32,
            cursor: first.nextCursor,
        });
        const read = await readActiveConfiguredSourceRows(collections.sourceInstances);

        expect(first.rows).toHaveLength(32);
        expect(first.status).toBe('truncated');
        expect(first.nextCursor).toBeDefined();
        expect(second.rows).toHaveLength(2);
        expect(second.status).toBe('complete');
        expect(second.nextCursor).toBeUndefined();
        expect(read.status).toBe('complete');
        expect(read.rows).toHaveLength(count);
        expect(read.rows.at(-1)?.configured.instance.sourceInstanceId)
            .toBe(`00000000-0000-4000-8000-${String(count).padStart(12, '0')}`);
    });

    it('rejects a repeated Collection cursor instead of walking forever', async () => {
        let calls = 0;
        const sourceInstances = {
            async query() {
                calls += 1;
                if (calls > 2) throw new Error('the cursor loop escaped its owner');
                return { rows: [], nextCursor: 'same-cursor' };
            },
        };

        await expect(readActiveConfiguredSourceRows(sourceInstances as never))
            .rejects.toThrow('repeated continuation cursor');
        expect(calls).toBe(2);
    });
});
