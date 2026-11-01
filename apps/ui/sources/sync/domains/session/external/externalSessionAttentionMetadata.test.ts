import { describe, expect, it } from 'vitest';

import type { Metadata } from '@happier-dev/session-core/state';

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
            { id: 'msg-2', createdAtMs: 20 },
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

    it('advances viewed progress to the observed progress without changing the observed markers', () => {
        const metadata = updateMetadataWithObservedExternalSessionProgress(createBaseMetadata(), {
            token: '20:msg-2', atMs: 20,
        });
        const next = updateMetadataWithViewedExternalSessionProgress(metadata);

        expect((next as any).externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '20:msg-2',
            viewedProgressToken: '20:msg-2',
            observedAtMs: 20,
            viewedAtMs: 20,
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
