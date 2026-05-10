import { describe, expect, it } from 'vitest';

import {
    buildSessionListRenderableMetadataComparison,
    normalizeSessionListRenderableMetadataComparison,
    readSessionListRenderableMetadataComparison,
} from './sessionListRenderableMetadataComparison';

describe('sessionListRenderableMetadataComparison', () => {
    it('reuses the previous comparison when the metadata is semantically identical', () => {
        const metadata = {
            name: 'Repo',
            summary: { text: 'Summary' },
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'mbp',
            machineId: 'm1',
            flavor: 'pro',
            externalSessionV1: { v: 1 as const, providerId: 'provider-a' },
            systemSessionV1: { hidden: false },
        };

        const previous = buildSessionListRenderableMetadataComparison(metadata as any);
        const next = buildSessionListRenderableMetadataComparison(metadata as any, previous);

        expect(next).toBe(previous);
    });

    it('normalizes the renderable metadata fields used by the store predicates', () => {
        const comparison = readSessionListRenderableMetadataComparison({
            summary: { text: 'Summary' },
            path: '/home/u/repo',
            externalSessionV1: { v: 1 as const, providerId: 'provider-a' },
            systemSessionV1: { hidden: true },
        } as any);

        expect(comparison).toEqual({
            name: undefined,
            summaryText: 'Summary',
            path: '/home/u/repo',
            homeDir: null,
            host: null,
            machineId: null,
            flavor: null,
            externalSessionV1: { v: 1, providerId: 'provider-a' },
            readStateV1: null,
            hiddenSystemSession: true,
        });
    });

    it('reuses the shared normalization helper for equivalent comparison snapshots', () => {
        const previous = normalizeSessionListRenderableMetadataComparison({
            name: 'Repo',
            summaryText: 'Summary',
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'mbp',
            machineId: 'm1',
            flavor: 'pro',
            externalSessionV1: { v: 1 as const, providerId: 'provider-a' },
            readStateV1: null,
            hiddenSystemSession: false,
        });

        const next = normalizeSessionListRenderableMetadataComparison({
            name: 'Repo',
            summaryText: 'Summary',
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'mbp',
            machineId: 'm1',
            flavor: 'pro',
            externalSessionV1: { v: 1 as const, providerId: 'provider-a' },
            readStateV1: null,
            hiddenSystemSession: false,
        }, previous);

        expect(next).toBe(previous);
    });
});
