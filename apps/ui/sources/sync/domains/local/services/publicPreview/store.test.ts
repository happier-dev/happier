import { describe, expect, it } from 'vitest';

import type {
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';

const exposure = {
    exposureId: 'public_preview_1',
    previewId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    mode: 'secret_link',
    state: 'active',
    publicUrl: 'https://preview.example.test/s/public_preview_1',
    issuedAt: 1_000,
    expiresAt: 601_000,
    auditEventIds: ['audit_1'],
    rateLimitProfileId: 'default',
} satisfies LocalServicePublicExposureV1;

const snapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    previewId: 'preview_1',
    generatedAt: 2_000,
    refreshState: 'idle',
    policy: {
        enabled: true,
        allowedModes: ['secret_link'],
        maxTtlMs: 600_000,
        maxConcurrentExposures: 1,
        dnsTlsRequired: true,
        auditRequired: true,
        rateLimitProfileIds: ['default'],
    },
    exposures: [exposure],
    diagnostics: [],
} satisfies LocalServicePublicPreviewSnapshotV1;

describe('local service public-preview store', () => {
    it('stores public preview exposures by preview and exposure id', async () => {
        const mod = await import('./store').catch(() => null);

        expect(mod?.createLocalServicePublicPreviewState).toBeTypeOf('function');
        if (!mod) return;

        const state = mod.applyLocalServicePublicPreviewSnapshot(
            mod.createLocalServicePublicPreviewState(),
            snapshot,
        );

        expect(mod.selectLocalServicePublicPreviewRows(state)).toEqual([exposure]);
        expect(mod.selectLocalServicePublicPreviewRowsForPreview(state, 'preview_1')).toEqual([exposure]);
        expect(mod.selectLocalServicePublicPreviewExposure(state, 'public_preview_1')).toEqual(exposure);
    });

    it('preserves public preview rows while refresh is in flight or fails', async () => {
        const mod = await import('./store').catch(() => null);

        expect(mod?.applyLocalServicePublicPreviewRefreshStarted).toBeTypeOf('function');
        if (!mod) return;

        const hydrated = mod.applyLocalServicePublicPreviewSnapshot(
            mod.createLocalServicePublicPreviewState(),
            snapshot,
        );
        const refreshing = mod.applyLocalServicePublicPreviewRefreshStarted(hydrated);
        const failed = mod.applyLocalServicePublicPreviewRefreshFailed(refreshing);

        expect(mod.selectLocalServicePublicPreviewRows(refreshing)).toEqual([exposure]);
        expect(refreshing.refreshState).toBe('refreshing');
        expect(mod.selectLocalServicePublicPreviewRows(failed)).toEqual([exposure]);
        expect(failed.refreshState).toBe('error');
        expect(failed.generatedAt).toBe(snapshot.generatedAt);
    });
});
