import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import {
    buildSessionDraftSyncStatusBadge,
    resolveSessionDraftStatusKey,
    selectSessionDraftSyncBadgeStatus,
} from './sessionDraftStatusPresentation';

describe('sessionDraftStatusPresentation', () => {
    it.each([
        ['offline', 'sessionDrafts.status.offline', 'paused'],
        ['error', 'common.error', 'warning'],
        // A Home that cannot sync this draft at all says so in its own words:
        // it is not the transient error, and the draft is still safe on device.
        ['unsupported', 'sessionDrafts.status.unsupported', 'paused'],
    ] as const)('projects %s from the repository status into the composer badge', (status, labelKey, tone) => {
        const label = t(labelKey);
        expect(buildSessionDraftSyncStatusBadge(selectSessionDraftSyncBadgeStatus({ status }))).toEqual(expect.objectContaining({
            key: 'draft-sync-status',
            label,
            accessibilityLabel: label,
            testID: 'session-draft-sync-status-badge',
            tone,
        }));
    });

    it.each([
        ['storage', 'sessionDrafts.status.storageError'],
        ['crypto', 'sessionDrafts.status.cryptoError'],
        ['transport', 'sessionDrafts.status.transportError'],
        ['cleanup', 'sessionDrafts.status.cleanupError'],
        [undefined, 'sessionDrafts.status.unknownError'],
    ] as const)('explains a %s draft failure through the badge popover', (errorReason, explanation) => {
        const badge = buildSessionDraftSyncStatusBadge(selectSessionDraftSyncBadgeStatus({ status: 'error', errorReason }));
        expect(badge?.accessibilityHint).toBe(t(explanation));
        expect(badge?.renderPopover).toBeDefined();
    });

    it('keeps transient synchronization and interactive conflict states out of the composer status row', () => {
        expect(selectSessionDraftSyncBadgeStatus({ status: 'pending' })).toBeNull();
        expect(selectSessionDraftSyncBadgeStatus({ status: 'clean' })).toBeNull();
        expect(selectSessionDraftSyncBadgeStatus({ status: 'conflict' })).toBeNull();
        expect(resolveSessionDraftStatusKey('conflict')).toBe('sessionDrafts.status.conflict');
    });
});
