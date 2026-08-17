import type { TriageSourceInstanceDraftV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import { TRIAGE_TESTKIT_SOURCE } from '../testkit/observations.test-support.js';
import { deriveConfiguredSourceInstanceTag } from './tags.js';

function binding(overrides: Partial<Readonly<{
    purpose: string;
    servicePluginId: string;
    serviceLocalId: string;
    accountId: string;
}>> = {}): TriageSourceInstanceDraftV1['binding'] {
    return {
        purpose: overrides.purpose ?? 'example.api',
        account: {
            service: {
                pluginId: overrides.servicePluginId ?? 'happier.example.source',
                localId: overrides.serviceLocalId ?? 'example-account',
            },
            accountId: overrides.accountId ?? 'account-1',
        },
    };
}

describe('configured source instance identity tags', () => {
    it('derives source-instance tags from structural account-ref leaves', async () => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const base = {
            source: TRIAGE_TESTKIT_SOURCE,
            binding: binding(),
            localInstanceKey: 'example:41231',
        };

        // Equivalent bindings written with different property insertion order
        // must address one row: the derivation reads named leaves, never an
        // object stringification.
        const reordered: TriageSourceInstanceDraftV1['binding'] = {
            account: { accountId: 'account-1', service: { localId: 'example-account', pluginId: 'happier.example.source' } },
            purpose: 'example.api',
        };

        expect(await deriveConfiguredSourceInstanceTag(collections.sourceInstances, { ...base, binding: reordered }))
            .toBe(await deriveConfiguredSourceInstanceTag(collections.sourceInstances, base));
    });

    it('keeps two exact accounts with one local key as distinct source instances', async () => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const base = {
            source: TRIAGE_TESTKIT_SOURCE,
            binding: binding(),
            localInstanceKey: 'example:41231',
        };

        const other = await deriveConfiguredSourceInstanceTag(collections.sourceInstances, {
            ...base,
            binding: binding({ accountId: 'account-2' }),
        });

        expect(other).not.toBe(await deriveConfiguredSourceInstanceTag(collections.sourceInstances, base));
    });

    it('separates account-ref leaves that a delimiter join would stringify identically', async () => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const source = TRIAGE_TESTKIT_SOURCE;

        const left = await deriveConfiguredSourceInstanceTag(collections.sourceInstances, {
            source,
            binding: binding({ accountId: 'account:1' }),
            localInstanceKey: 'example',
        });
        const right = await deriveConfiguredSourceInstanceTag(collections.sourceInstances, {
            source,
            binding: binding({ accountId: 'account' }),
            localInstanceKey: '1:example',
        });

        expect(right).not.toBe(left);
    });
});
