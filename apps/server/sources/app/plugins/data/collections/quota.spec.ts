import { describe, expect, it } from 'vitest';

import { resolveEffectivePluginCollectionLimitsV1 } from '@happier-dev/protocol';

import {
    findPluginCollectionActivationQuotaIncompatibility,
    findPluginCollectionBatchQuotaIncompatibility,
    findPluginCollectionDeclaredQuotaIncompatibility,
    findPluginCollectionMutationQuotaIncompatibility,
} from './quota';

const deployment = {
    maxRowEncodedBytes: 512 * 1024,
    maxBatchBytes: 16 * 1024 * 1024,
    maxBatchRows: 100,
    maxAccountRows: 10_000,
    maxAccountBytes: 256 * 1024 * 1024,
};

describe('Plugin Collection quota policy', () => {
    it('enforces exactly the per-collection ceilings the Protocol owner composes for a writer', () => {
        // The numbers a plugin plans against come from this one Protocol owner;
        // enforcement must not re-derive them, or a writer can plan against a
        // ceiling this server does not apply.
        const quota = {
            maxRowEncodedBytes: 400 * 1024,
            maxRows: 1_000,
            maxCollectionEncodedBytes: 64 * 1024 * 1024,
        };
        const planned = resolveEffectivePluginCollectionLimitsV1({ deployment, quota });
        const activationUsage = (rows: number, encodedBytes: number, maximumRowEncodedBytes: number) => ({
            rows,
            encodedBytes,
            collections: new Map([[
                'example.tasks\u0000tasks',
                { rows, encodedBytes, maximumRowEncodedBytes },
            ]]),
            contracts: new Map(),
        });
        const activation = (usage: ReturnType<typeof activationUsage>) => (
            findPluginCollectionActivationQuotaIncompatibility({
                deployment,
                usage,
                collections: [{ pluginId: 'example.tasks', collectionId: 'tasks', quota }],
                prefixUsage: [],
            })
        );

        expect(activation(activationUsage(planned.maxRows, 1_000, 1_000))).toBeNull();
        expect(activation(activationUsage(planned.maxRows + 1, 1_000, 1_000)))
            .toEqual({ dimension: 'maxRows', effectiveMaximum: planned.maxRows });
        expect(activation(activationUsage(1, planned.maxCollectionEncodedBytes + 1, 1_000)))
            .toEqual({
                dimension: 'maxCollectionEncodedBytes',
                effectiveMaximum: planned.maxCollectionEncodedBytes,
            });
        expect(activation(activationUsage(1, 1_000, planned.maxRowEncodedBytes + 1)))
            .toEqual({ dimension: 'maxRowEncodedBytes', effectiveMaximum: planned.maxRowEncodedBytes });
    });

    it('bounds a declared per-collection quota by the Account-wide dimension the Protocol owner names', () => {
        // A declaration may only lower deployment policy. The ceiling for each
        // per-collection dimension is the same composition with no declaration,
        // so `maxRows` is bounded by the Account-wide row ceiling rather than by
        // a number transcribed into the server.
        const ceilings = resolveEffectivePluginCollectionLimitsV1({ deployment, quota: undefined });
        expect(ceilings.maxRows).toBe(deployment.maxAccountRows);
        expect(ceilings.maxCollectionEncodedBytes).toBe(deployment.maxAccountBytes);

        expect(findPluginCollectionDeclaredQuotaIncompatibility({
            deployment,
            quota: { maxRows: ceilings.maxRows },
        })).toBeNull();
        expect(findPluginCollectionDeclaredQuotaIncompatibility({
            deployment,
            quota: { maxRows: ceilings.maxRows + 1 },
        })).toEqual({ dimension: 'maxRows', effectiveMaximum: ceilings.maxRows });
        expect(findPluginCollectionDeclaredQuotaIncompatibility({
            deployment,
            quota: { maxCollectionEncodedBytes: ceilings.maxCollectionEncodedBytes + 1 },
        })).toEqual({
            dimension: 'maxCollectionEncodedBytes',
            effectiveMaximum: ceilings.maxCollectionEncodedBytes,
        });
        expect(findPluginCollectionDeclaredQuotaIncompatibility({
            deployment,
            quota: { maxRowEncodedBytes: ceilings.maxRowEncodedBytes + 1 },
        })).toEqual({ dimension: 'maxRowEncodedBytes', effectiveMaximum: ceilings.maxRowEncodedBytes });
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
            changedRows: [{ pluginId: 'example.tasks', collectionId: 'tasks', rowIds: ['row-1'] }],
            beforePrefixUsage: [],
            afterPrefixUsage: [],
        })).toBeNull();
        expect(findPluginCollectionMutationQuotaIncompatibility({
            deployment,
            before: usage(10_001, 1_000, [['row-1', 100]]),
            after: usage(10_001, 900, [['row-1', 50]]),
            collections,
            changedRows: [{ pluginId: 'example.tasks', collectionId: 'tasks', rowIds: ['row-1'] }],
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
            changedRows: [{ pluginId: 'example.tasks', collectionId: 'tasks', rowIds: ['task-1'] }],
            beforePrefixUsage: [],
            afterPrefixUsage: [],
        })).toEqual({ dimension: 'maxAccountBytes', effectiveMaximum: 1_000 });
        expect(findPluginCollectionMutationQuotaIncompatibility({
            deployment: aggregateDeployment,
            before: accountUsage(600),
            after: accountUsage(500),
            collections,
            changedRows: [{ pluginId: 'example.tasks', collectionId: 'tasks', rowIds: ['task-1'] }],
            beforePrefixUsage: [],
            afterPrefixUsage: [],
        })).toBeNull();
    });

    it('admits a small Collection transition beside an unchanged oversized row', () => {
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
            changedRows: [{ pluginId: 'example.beta', collectionId: 'beta', rowIds: ['beta-2'] }],
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
        })).toBeNull();
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
                    maximumRowEncodedBytes: 100,
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

    it('enforces activation row bytes through the compact collection maximum', () => {
        const usage = {
            rows: 1,
            encodedBytes: 600,
            collections: new Map([[
                'example.tasks\u0000tasks',
                {
                    rows: 1,
                    encodedBytes: 600,
                    maximumRowEncodedBytes: 600,
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
                quota: { maxRowEncodedBytes: 512 },
            }],
            prefixUsage: [],
        })).toEqual({ dimension: 'maxRowEncodedBytes', effectiveMaximum: 512 });
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
            changedRows: [],
            beforePrefixUsage: prefix(3),
            afterPrefixUsage: prefix(2),
        })).toBeNull();
        expect(findPluginCollectionMutationQuotaIncompatibility({
            deployment,
            before: usage,
            after: usage,
            collections: [],
            changedRows: [],
            beforePrefixUsage: prefix(3),
            afterPrefixUsage: prefix(3),
        })).toEqual({ dimension: 'maxRows', effectiveMaximum: 1 });
    });
});
