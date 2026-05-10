import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import {
    deriveExternalSessionObservedProgress,
    updateMetadataWithObservedExternalSessionProgress,
    updateMetadataWithUnreadExternalSessionProgress,
    updateMetadataWithViewedExternalSessionProgress,
} from './externalSessionAttentionMetadata';

function createBaseMetadata(): Metadata {
        return {
            path: '/tmp',
            host: 'localhost',
            externalSessionAttentionV1: {
                v: 1,
                observedProgressToken: '10:msg-1',
                viewedProgressToken: '10:msg-1',
                observedAtMs: 10,
                viewedAtMs: 10,
            },
        } as Metadata;
    }

describe('externalSessionAttentionMetadata', () => {
    it('preserves observed attention markers when observed progress advances', () => {
        const progress = deriveExternalSessionObservedProgress([
            { id: 'msg-2', createdAtMs: 20 } as any,
        ]);

        const next = updateMetadataWithObservedExternalSessionProgress(createBaseMetadata(), progress);

        expect((next as any).externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '20:msg-2',
            viewedProgressToken: '10:msg-1',
            observedAtMs: 20,
            viewedAtMs: 10,
        });
    });

    it('preserves viewed attention markers when viewed progress advances', () => {
        const next = updateMetadataWithViewedExternalSessionProgress(createBaseMetadata());

        expect((next as any).externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '10:msg-1',
            viewedProgressToken: '10:msg-1',
            observedAtMs: 10,
            viewedAtMs: 10,
        });
    });

    it('lowers viewed attention markers when direct-session progress is marked unread', () => {
        const next = updateMetadataWithUnreadExternalSessionProgress(createBaseMetadata());

        expect((next as any).externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '10:msg-1',
            observedAtMs: 10,
        });
    });
});
