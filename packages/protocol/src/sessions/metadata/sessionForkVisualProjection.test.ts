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


it('retains continuation intent through source context, owner storage and the display projection', async () => {
    const { SessionSpawnSourceContextV1Schema } = await import('../creation/sessionSpawnSourceContextV1.js');
    const { projectSessionOwnerDisplayV1 } = await import('./sessionDisplayProjectionV1.js');
    const source = SessionSpawnSourceContextV1Schema.parse({ v: 1, kind: 'session_replay',
        sourceSessionId: 'parent', forkPoint: { type: 'latest' }, continuation: true });
    const result = createSessionOwnerMetadataV1({ metadata: { forkV1: { v: 1,
        parentSessionId: source.sourceSessionId, parentCutoffSeqInclusive: 2, createdAtMs: 1,
        strategy: 'replay', continuation: source.continuation } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ownerMetadata.history?.forkV1).toMatchObject({ continuation: true });
    expect(projectSessionOwnerDisplayV1(result.ownerMetadata).forkV1).toMatchObject({ continuation: true });
});
