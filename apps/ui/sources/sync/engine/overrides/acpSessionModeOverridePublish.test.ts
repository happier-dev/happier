import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    computeNextAcpSessionModeOverrideMetadata,
    publishAcpSessionModeOverrideToMetadata,
} from './acpSessionModeOverridePublish';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('computeNextAcpSessionModeOverrideMetadata', () => {
    it('updates metadata when override updatedAt is newer', () => {
        const base = buildMetadata();
        const next = computeNextAcpSessionModeOverrideMetadata({
            metadata: base,
            modeId: 'plan',
            updatedAt: 11,
        });

        expect(next).toEqual({
            ...base,
            sessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' },
        });
    });

    it('applies a monotonic bump when mode changes and updatedAt is not newer', () => {
        const base = buildMetadata({
            sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'build' },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'build' },
        });
        const next = computeNextAcpSessionModeOverrideMetadata({
            metadata: base,
            modeId: 'plan',
            updatedAt: 10,
        });

        expect(next).toEqual({
            ...base,
            sessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' },
        });
    });

    it('returns metadata unchanged when mode and updatedAt are unchanged', () => {
        const base = buildMetadata({
            sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'build' },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'build' },
        });
        const next = computeNextAcpSessionModeOverrideMetadata({
            metadata: base,
            modeId: 'build',
            updatedAt: 10,
        });

        expect(next).toBe(base);
    });

    it('updates timestamp when updatedAt is newer even if mode does not change', () => {
        const base = buildMetadata({
            acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'build' },
        });
        const next = computeNextAcpSessionModeOverrideMetadata({
            metadata: base,
            modeId: 'build',
            updatedAt: 15,
        });

        expect(next).toEqual({
            ...base,
            sessionModeOverrideV1: { v: 1, updatedAt: 15, modeId: 'build' },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 15, modeId: 'build' },
        });
    });

    it('uses the canonical key as the monotonic source when canonical metadata is newer than the legacy alias', () => {
        const base = buildMetadata({
            sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 3, modeId: 'plan' },
        });
        const next = computeNextAcpSessionModeOverrideMetadata({
            metadata: base,
            modeId: 'build',
            updatedAt: 5,
        });

        expect(next).toEqual({
            ...base,
            sessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'build' },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'build' },
        });
    });
});

describe('publishAcpSessionModeOverrideToMetadata', () => {
    it('uses updateSessionMetadataWithRetry with a monotonic updater', async () => {
        const updates: Metadata[] = [];
        const base = buildMetadata();

        await publishAcpSessionModeOverrideToMetadata({
            sessionId: 's1',
            modeId: 'plan',
            updatedAt: 11,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(base));
            },
        });

        expect(updates).toHaveLength(1);
        expect((updates[0] as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 11, modeId: 'plan' });
        expect((updates[0] as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 11, modeId: 'plan' });
    });
});
