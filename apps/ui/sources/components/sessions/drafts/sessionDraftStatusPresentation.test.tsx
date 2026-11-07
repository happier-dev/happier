import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

import {
    buildSessionDraftSyncStatusBadge,
    resolveSessionDraftStatusKey,
    SessionDraftSyncErrorDetails,
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

    it('makes the error badge open its details only when the repository can explain the failure', () => {
        expect(buildSessionDraftSyncStatusBadge('error', { readErrorReason: () => 'storage' })?.renderPopover).toEqual(expect.any(Function));
        expect(buildSessionDraftSyncStatusBadge('error')?.renderPopover).toBeUndefined();
        expect(buildSessionDraftSyncStatusBadge('offline', { readErrorReason: () => 'storage' })?.renderPopover).toBeUndefined();
    });

    it.each(['storage', 'encryption'] as const)('explains a %s failure in selectable text', async (reason) => {
        const screen = await renderScreen(<SessionDraftSyncErrorDetails reason={reason} />);
        const details = screen.findByTestId(`session-draft-sync-error-details:${reason}`);
        expect(details).not.toBeNull();
        const selectableTexts = details!.findAll((node) => node.props?.selectable === true && typeof node.props?.children === 'string');
        expect(selectableTexts.length).toBeGreaterThan(0);
    });
});
