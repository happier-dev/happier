import { describe, expect, it, vi } from 'vitest';

import { t } from '@/text';

import {
    buildSessionDraftSyncStatusBadge,
    resolveSessionDraftStatusKey,
} from './sessionDraftStatusPresentation';

describe('sessionDraftStatusPresentation', () => {
    it.each([
        ['offline', 'sessionDrafts.status.offline', 'paused'],
        ['error', 'common.error', 'danger'],
    ] as const)('projects %s from the repository status into the composer badge', (status, labelKey, tone) => {
        const label = t(labelKey);
        expect(buildSessionDraftSyncStatusBadge(status)).toEqual(expect.objectContaining({
            key: 'draft-sync-status',
            label,
            accessibilityLabel: label,
            testID: 'session-draft-sync-status-badge',
            tone,
        }));
    });

    it('keeps transient synchronization and interactive conflict states out of the composer status row', () => {
        expect(buildSessionDraftSyncStatusBadge('pending')).toBeNull();
        expect(buildSessionDraftSyncStatusBadge('clean')).toBeNull();
        expect(buildSessionDraftSyncStatusBadge('conflict')).toBeNull();
        expect(resolveSessionDraftStatusKey('conflict')).toBe('sessionDrafts.status.conflict');
    });

    it('reads the repository reason only when the error badge opens', () => {
        const readErrorReason = vi.fn(() => 'storage' as const);
        const badge = buildSessionDraftSyncStatusBadge('error', { readErrorReason });
        const context = { anchorRef: { current: null }, onRequestClose: vi.fn() };

        expect(badge?.renderPopover?.({ ...context, open: false })).toBeNull();
        expect(readErrorReason).not.toHaveBeenCalled();
        expect(badge?.renderPopover?.({ ...context, open: true })).toBeTruthy();
        expect(readErrorReason).toHaveBeenCalledOnce();
        expect(buildSessionDraftSyncStatusBadge('error')?.renderPopover).toBeUndefined();
        expect(buildSessionDraftSyncStatusBadge('offline', { readErrorReason })?.renderPopover).toBeUndefined();
    });
});
