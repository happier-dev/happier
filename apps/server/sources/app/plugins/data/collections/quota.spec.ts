import { describe, expect, it } from 'vitest';

import {
    findPluginCollectionActivationQuotaIncompatibility,
    findPluginCollectionBatchQuotaIncompatibility,
    findPluginCollectionMutationQuotaIncompatibility,
    resolvePluginCollectionEffectiveQuotaLimits,
} from './quota';

const deployment = {
    maxRowEncodedBytes: 512 * 1024,
    maxBatchBytes: 16 * 1024 * 1024,
    maxBatchRows: 100,
    maxAccountRows: 10_000,
    maxAccountBytes: 256 * 1024 * 1024,
};

describe('Plugin Collection quota policy', () => {
    it('uses deployment Account ceilings as per-collection upper bounds while retaining a narrower declaration', () => {
        expect(resolvePluginCollectionEffectiveQuotaLimits({
            deployment,
            quota: undefined,
        })).toEqual({
            maxRowEncodedBytes: 512 * 1024,
            maxRows: 10_000,
            maxCollectionEncodedBytes: 256 * 1024 * 1024,
            maxBatchRows: 100,
            maxBatchBytes: 16 * 1024 * 1024,
            maxAccountRows: 10_000,
            maxAccountBytes: 256 * 1024 * 1024,
        });

        expect(resolvePluginCollectionEffectiveQuotaLimits({
            deployment,
            quota: {
                maxRowEncodedBytes: 400 * 1024,
                maxRows: 1_000,
                maxCollectionEncodedBytes: 64 * 1024 * 1024,
            },
        })).toEqual({
            maxRowEncodedBytes: 400 * 1024,
            maxRows: 1_000,
            maxCollectionEncodedBytes: 64 * 1024 * 1024,
            maxBatchRows: 100,
            maxBatchBytes: 16 * 1024 * 1024,
            maxAccountRows: 10_000,
            maxAccountBytes: 256 * 1024 * 1024,
        });
    });

    it('allows only a strict reduction of a pre-existing overage and rejects fresh batch excesses', () => {
        const usage = (rows: number, bytes: number, rowSizes: readonly [string, number][] = []) => ({
            rows,
            encodedBytes: bytes,
            collections: new Map([[
                'example.tasks\u0000tasks',
                {
                    rows,
                    encodedBytes: bytes,
                    rowEncodedBytesByRowId: new Map(rowSizes),
                },
            ]]),
            contracts: new Map(),
        });
        const collections = [{
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            quota: undefined,
        }];

        expect(findPluginCollectionMutationQuotaIncompatibility({
            deployment,
            before: usage(10_001, 1_000, [['row-1', 100]]),
            after: usage(10_000, 900, []),
            collections,
            beforePrefixUsage: [],
            afterPrefixUsage: [],
        })).toBeNull();
        expect(findPluginCollectionMutationQuotaIncompatibility({
            deployment,
            before: usage(10_001, 1_000, [['row-1', 100]]),
            after: usage(10_001, 900, [['row-1', 50]]),
            collections,
            beforePrefixUsage: [],
            afterPrefixUsage: [],
        })).toEqual({ dimension: 'maxRows', effectiveMaximum: 10_000 });
        expect(findPluginCollectionBatchQuotaIncompatibility({
            deployment,
            operationCount: 101,
            encodedBytes: 1,
        })).toEqual({ dimension: 'maxBatchRows', effectiveMaximum: 100 });
        expect(findPluginCollectionBatchQuotaIncompatibility({
            deployment,
            operationCount: 100,
            encodedBytes: (16 * 1024 * 1024) + 1,
        })).toEqual({ dimension: 'maxBatchBytes', effectiveMaximum: 16 * 1024 * 1024 });
    });

    it('keeps independent under-limit collections from bypassing the Account aggregate byte ceiling', () => {
        const accountUsage = (firstBytes: number) => ({
            rows: 2,
            encodedBytes: firstBytes + 600,
            collections: new Map([
                ['example.tasks\u0000tasks', {
                    rows: 1,
                    encodedBytes: firstBytes,
                    rowEncodedBytesByRowId: new Map([['task-1', firstBytes]]),
                }],
                ['example.other\u0000tasks', {
                    rows: 1,
                    encodedBytes: 600,
                    rowEncodedBytesByRowId: new Map([['other-1', 600]]),
                }],
            ]),
            contracts: new Map(),
        });
        const aggregateDeployment = {
            ...deployment,
            maxAccountRows: 10,
            maxAccountBytes: 1_000,
        };
        const collections = [{
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            quota: undefined,
        }];

        expect(findPluginCollectionMutationQuotaIncompatibility({
            deployment: aggregateDeployment,
            before: accountUsage(600),
            after: accountUsage(700),
            collections,
            beforePrefixUsage: [],
            afterPrefixUsage: [],
        })).toEqual({ dimension: 'maxAccountBytes', effectiveMaximum: 1_000 });
        expect(findPluginCollectionMutationQuotaIncompatibility({
            deployment: aggregateDeployment,
            before: accountUsage(600),
            after: accountUsage(500),
            collections,
            beforePrefixUsage: [],
            afterPrefixUsage: [],
        })).toBeNull();
    });

    it('does not let a retained oversized row bypass its declared quota through another Collection transition', () => {
        const before = {
            rows: 2,
            encodedBytes: 700,
            collections: new Map([
                ['example.alpha\u0000alpha', {
                    rows: 1,
                    encodedBytes: 600,
                    rowEncodedBytesByRowId: new Map([['alpha-oversized', 600]]),
                }],
                ['example.beta\u0000beta', {
                    rows: 1,
                    encodedBytes: 100,
                    rowEncodedBytesByRowId: new Map([['beta-1', 100]]),
                }],
            ]),
            contracts: new Map(),
        };
        const after = {
            rows: 3,
            encodedBytes: 750,
            collections: new Map([
                ['example.alpha\u0000alpha', {
                    rows: 1,
                    encodedBytes: 600,
                    rowEncodedBytesByRowId: new Map([['alpha-oversized', 600]]),
                }],
                ['example.beta\u0000beta', {
                    rows: 2,
                    encodedBytes: 150,
                    rowEncodedBytesByRowId: new Map([['beta-1', 100], ['beta-2', 50]]),
                }],
            ]),
            contracts: new Map(),
        };

        expect(findPluginCollectionMutationQuotaIncompatibility({
            deployment,
            before,
            after,
            collections: [
                {
                    pluginId: 'example.alpha',
                    collectionId: 'alpha',
                    quota: { maxRowEncodedBytes: 512 },
                },
                {
                    pluginId: 'example.beta',
                    collectionId: 'beta',
                    quota: undefined,
                },
            ],
            beforePrefixUsage: [],
            afterPrefixUsage: [],
        })).toEqual({ dimension: 'maxRowEncodedBytes', effectiveMaximum: 512 });
    });

    it('rejects activation with an indexed-prefix overage at the same quota owner', () => {
        const usage = {
            rows: 2,
            encodedBytes: 200,
            collections: new Map([[
                'example.tasks\u0000tasks',
                {
                    rows: 2,
                    encodedBytes: 200,
                    rowEncodedBytesByRowId: new Map([['open-1', 100], ['open-2', 100]]),
                },
            ]]),
            contracts: new Map(),
        };

        expect(findPluginCollectionActivationQuotaIncompatibility({
            deployment,
            usage,
            collections: [{
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                quota: {
                    maxRowsByIndexPrefix: [{ indexId: 'by-status', prefix: ['open'], maxRows: 1 }],
                },
            }],
            prefixUsage: [{
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                contractDigest: 'fixture-contract',
                indexId: 'by-status',
                prefix: ['open'],
                maxRows: 1,
                rows: 2,
            }],
        })).toEqual({ dimension: 'maxRows', effectiveMaximum: 1 });
    });

    it('allows only a strict indexed-prefix reduction after a deployment or declaration is lowered', () => {
        const usage = {
            rows: 0,
            encodedBytes: 0,
            collections: new Map(),
            contracts: new Map(),
        };
        const prefix = (rows: number) => [{
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            contractDigest: 'fixture-contract',
            indexId: 'by-status',
            prefix: ['open'],
            maxRows: 1,
            rows,
        }];

        expect(findPluginCollectionMutationQuotaIncompatibility({
            deployment,
            before: usage,
            after: usage,
            collections: [],
            beforePrefixUsage: prefix(3),
            afterPrefixUsage: prefix(2),
        })).toBeNull();
        expect(findPluginCollectionMutationQuotaIncompatibility({
            deployment,
            before: usage,
            after: usage,
            collections: [],
            beforePrefixUsage: prefix(3),
            afterPrefixUsage: prefix(3),
        })).toEqual({ dimension: 'maxRows', effectiveMaximum: 1 });
    });
});
