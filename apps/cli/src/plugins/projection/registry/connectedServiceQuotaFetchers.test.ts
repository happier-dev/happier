import { describe, expect, it, vi } from 'vitest';

import { resolveConnectedServiceQuotaFetcherDescriptors } from './connectedServiceQuotaFetchers';
import type { ResolvedContributionRegistry } from './types';

describe('resolveConnectedServiceQuotaFetcherDescriptors', () => {
    it('collects provider-owned quota fetcher descriptors from catalog entries once per descriptor id', async () => {
        const createFetcher = vi.fn();
        const registry = {
            catalogEntriesById: {
                codex: {
                    getConnectedServiceQuotaFetcherDescriptor: async () => ({
                        id: 'openai-codex',
                        createFetcher,
                    }),
                },
                codexAlias: {
                    getConnectedServiceQuotaFetcherDescriptor: async () => ({
                        id: 'openai-codex',
                        createFetcher,
                    }),
                },
                pi: {},
            },
        } as unknown as Pick<ResolvedContributionRegistry, 'catalogEntriesById'>;

        await expect(resolveConnectedServiceQuotaFetcherDescriptors(registry)).resolves.toEqual([
            {
                id: 'openai-codex',
                createFetcher,
            },
        ]);
    });
});
