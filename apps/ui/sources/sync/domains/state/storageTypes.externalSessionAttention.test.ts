import { describe, expect, it } from 'vitest';

import { MetadataSchema } from './storageTypes';

describe('MetadataSchema (externalSessionAttentionV1)', () => {
    it('preserves lightweight direct-session attention markers', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp',
            host: 'localhost',
                externalSessionAttentionV1: {
                    v: 1,
                    observedProgressToken: 'marker-2',
                    viewedProgressToken: 'marker-1',
                    observedAtMs: 200,
                    viewedAtMs: 100,
                },
            } as any);

        expect((parsed as any).externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: 'marker-2',
            viewedProgressToken: 'marker-1',
            observedAtMs: 200,
            viewedAtMs: 100,
        });
    });
});
