import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import {
    deriveDirectSessionObservedProgress,
    updateMetadataWithObservedDirectSessionProgress,
    updateMetadataWithUnreadDirectSessionProgress,
    updateMetadataWithViewedDirectSessionProgress,
} from './directSessionAttentionMetadata';

function createBaseMetadata(): Metadata {
        return {
            path: '/tmp',
            host: 'localhost',
            directSessionAttentionV1: {
                v: 1,
                observedProgressToken: '10:msg-1',
                viewedProgressToken: '10:msg-1',
                observedAtMs: 10,
                viewedAtMs: 10,
            },
        } as Metadata;
    }

describe('directSessionAttentionMetadata', () => {
    it('preserves observed attention markers when observed progress advances', () => {
        const progress = deriveDirectSessionObservedProgress([
            { id: 'msg-2', createdAtMs: 20 } as any,
        ]);

        const next = updateMetadataWithObservedDirectSessionProgress(createBaseMetadata(), progress);

        expect((next as any).directSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '20:msg-2',
            viewedProgressToken: '10:msg-1',
            observedAtMs: 20,
            viewedAtMs: 10,
        });
    });

    it('preserves viewed attention markers when viewed progress advances', () => {
        const next = updateMetadataWithViewedDirectSessionProgress(createBaseMetadata());

        expect((next as any).directSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '10:msg-1',
            viewedProgressToken: '10:msg-1',
            observedAtMs: 10,
            viewedAtMs: 10,
        });
    });

    it('lowers viewed attention markers when direct-session progress is marked unread', () => {
        const next = updateMetadataWithUnreadDirectSessionProgress(createBaseMetadata());

        expect((next as any).directSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '10:msg-1',
            observedAtMs: 10,
        });
    });
});
