import { describe, expect, it } from 'vitest';

import { TriageConfiguredSourceInstanceV1Schema } from '@happier-dev/triage-protocol/v1';

import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../collections/ids.js';
import { toCorpusStoredValue } from '../collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import { MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1 } from './administerConfiguredSourceInstance.js';
import { readActiveConfiguredSourceRows } from './readConfiguredSourceRows.js';

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
    it('keeps the bounded list projection but returns every overshoot row for administration', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const count = MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1 + 2;
        for (let seed = 1; seed <= count; seed += 1) {
            control.sourceInstances.seed(toCorpusStoredValue(sourceRow(seed)));
        }

        const read = await readActiveConfiguredSourceRows(collections.sourceInstances);

        expect(read.status).toBe('truncated');
        expect(read.rows).toHaveLength(MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1);
        expect(read.administrativeRows).toHaveLength(count);
        expect(read.administrativeRows.at(-1)?.configured.instance.sourceInstanceId)
            .toBe(`00000000-0000-4000-8000-${String(count).padStart(12, '0')}`);
    });
});
