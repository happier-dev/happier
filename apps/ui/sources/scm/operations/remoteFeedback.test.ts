import { describe, expect, it } from 'vitest';

import {
    buildNonFastForwardFetchPromptDialog,
    buildRemoteConfirmDialog,
    buildRemoteConfirmBody,
    buildRemoteOperationBusyLabel,
    buildRemoteOperationSuccessDetail,
    formatRemoteTargetForDisplay,
} from './remoteFeedback';

describe('formatRemoteTargetForDisplay', () => {
    it('formats remote with branch', () => {
        expect(formatRemoteTargetForDisplay({ remote: 'origin', branch: 'main' }, 'Detached HEAD')).toBe('origin/main');
    });

    it('falls back to detached label when branch is missing', () => {
        expect(formatRemoteTargetForDisplay({ remote: 'origin', branch: null }, 'Detached HEAD')).toBe('origin (Detached HEAD)');
    });
});

describe('buildRemoteConfirmBody', () => {
    it('includes remote and branch information plus operation policy context', () => {
        expect(
            buildRemoteConfirmBody(
                { remote: 'upstream', branch: 'feature/x' },
                'Detached HEAD',
                { kind: 'pull' },
            )
        ).toContain('Remote: upstream');
        expect(
            buildRemoteConfirmBody(
                { remote: 'upstream', branch: 'feature/x' },
                'Detached HEAD',
                { kind: 'pull' },
            )
        ).toContain('Policy: fast-forward only');
        expect(
            buildRemoteConfirmBody(
                { remote: 'upstream', branch: 'feature/x' },
                'Detached HEAD',
                { kind: 'push' },
            )
        ).toContain('Push will update the remote branch');
    });
});

describe('buildRemoteConfirmDialog', () => {
    it('returns pull dialog copy and confirm label', () => {
        const dialog = buildRemoteConfirmDialog({
            kind: 'pull',
            target: { remote: 'origin', branch: 'main' },
            detachedHeadLabel: 'Detached HEAD',
        });
        expect(dialog.title).toBe('Pull latest changes');
        expect(dialog.confirmText).toBe('Pull');
        expect(dialog.body).toContain('Policy: fast-forward only');
    });

    it('returns push dialog copy and confirm label', () => {
        const dialog = buildRemoteConfirmDialog({
            kind: 'push',
            target: { remote: 'origin', branch: 'main' },
            detachedHeadLabel: 'Detached HEAD',
        });
        expect(dialog.title).toBe('Push local commits');
        expect(dialog.confirmText).toBe('Push');
        expect(dialog.body).toContain('Push will update the remote branch');
    });
});

describe('buildRemoteOperationBusyLabel', () => {
    it('returns clear operation labels', () => {
        expect(buildRemoteOperationBusyLabel('fetch', { remote: 'origin', branch: 'main' }, 'Detached HEAD')).toBe(
            'Fetching from origin/main…'
        );
        expect(buildRemoteOperationBusyLabel('pull', { remote: 'origin', branch: 'main' }, 'Detached HEAD')).toBe(
            'Pulling from origin/main…'
        );
        expect(buildRemoteOperationBusyLabel('push', { remote: 'origin', branch: 'main' }, 'Detached HEAD')).toBe(
            'Pushing to origin/main…'
        );
    });
});

describe('buildRemoteOperationSuccessDetail', () => {
    it('returns friendly success details when stdout is empty', () => {
        expect(buildRemoteOperationSuccessDetail('fetch', { remote: 'origin', branch: 'main' }, '', 'Detached HEAD')).toBe(
            'Fetched from origin/main'
        );
    });

    it('prefers concise stdout summaries when available', () => {
        expect(
            buildRemoteOperationSuccessDetail(
                'push',
                { remote: 'origin', branch: 'main' },
                'Everything up-to-date\n',
                'Detached HEAD'
            )
        ).toBe('Pushed to origin/main • Everything up-to-date');
    });
});

describe('buildNonFastForwardFetchPromptDialog', () => {
    it('returns follow-up dialog copy for non-fast-forward push errors', () => {
        const dialog = buildNonFastForwardFetchPromptDialog({
            target: { remote: 'origin', branch: 'main' },
            detachedHeadLabel: 'Detached HEAD',
        });

        expect(dialog.title).toBe('Remote has newer commits');
        expect(dialog.body).toContain('Push to origin/main was rejected');
        expect(dialog.confirmText).toBe('Fetch');
        expect(dialog.cancelText).toBe('Not now');
    });
});
