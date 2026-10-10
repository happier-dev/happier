import { expect, it } from 'vitest';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from './sessionMetadataSchemasV1.js';

it('retains small fork copy outcomes for child readers without sharing owner lineage authority', () => {
    const copies = [{ originServerId: 'home', originSessionId: 'parent', originItemId: 'chart', status: 'copied', itemId: 'child-chart' },
        { originServerId: 'home', originSessionId: 'parent', originItemId: 'missing', status: 'not_copied' }];
    const metadata = { forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 5,
        createdAtMs: 1, strategy: 'replay', visualCopies: copies } };
    expect(createSessionOwnerMetadataV1({ metadata })).toMatchObject({ ok: true,
        ownerMetadata: { history: { forkV1: { visualCopies: copies } } } });
    expect(projectSessionSharedMetadataV1({ metadata })).toMatchObject({ forkVisualsV1: { v: 1, copies } });
    expect(projectSessionSharedMetadataV1({ metadata })).not.toHaveProperty('forkV1');
});
