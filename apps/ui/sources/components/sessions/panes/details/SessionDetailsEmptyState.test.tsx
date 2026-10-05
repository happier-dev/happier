import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';

let snapshot: unknown = null;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
    useSessionProjectScmSnapshot: () => snapshot,
}));

/** A real snapshot shape: the count is the canonical changed-file list (`selectScmChangedFiles`). */
const STATS = { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false };

function changedSnapshot(count: number, extraEntries: readonly unknown[] = []) {
    return {
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [] },
        capabilities: {},
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        totals: { includedFiles: 0, pendingFiles: count, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: count, pendingRemoved: 0 },
        entries: [
            ...Array.from({ length: count }, (_unused, index) => ({
                path: `src/file-${index}.ts`, previousPath: null, kind: 'modified', includeStatus: ' ', pendingStatus: 'M',
                hasIncludedDelta: false, hasPendingDelta: true, stats: STATS,
            })),
            ...extraEntries,
        ],
    };
}

describe('SessionDetailsEmptyState', () => {
    it('offers the host file browser alongside Review', async () => {
        snapshot = changedSnapshot(4);
        const onBrowseFiles = vi.fn();
        const { SessionDetailsEmptyState } = await import('./SessionDetailsEmptyState');
        const screen = await renderScreen(<SessionDetailsEmptyState sessionId="s1" openDetailsTab={vi.fn()} onBrowseFiles={onBrowseFiles} />);
        await screen.pressByTestIdAsync('pane-details-empty-state-secondary-action');
        expect(onBrowseFiles).toHaveBeenCalledOnce();
    });

    it('invites reading the session changes and opens Review', async () => {
        snapshot = changedSnapshot(4);
        const openDetailsTab = vi.fn();
        const { SessionDetailsEmptyState } = await import('./SessionDetailsEmptyState');
        const screen = await renderScreen(<SessionDetailsEmptyState sessionId="s1" openDetailsTab={openDetailsTab} />);
        await screen.pressByTestIdAsync('pane-details-empty-state-action');
        expect(openDetailsTab).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'scmReview:working', kind: 'scmReview' }),
            { intent: 'pinned' },
        );
    });

    it('explains Details without an action when nothing changed', async () => {
        snapshot = changedSnapshot(0);
        const { SessionDetailsEmptyState } = await import('./SessionDetailsEmptyState');
        const screen = await renderScreen(<SessionDetailsEmptyState sessionId="s1" openDetailsTab={vi.fn()} />);
        expect(screen.findByTestId('pane-details-empty-state-action')).toBeNull();
        expect(screen.getTextContent()).toContain('detailsSurface.chrome.emptyReason');
    });

    it('counts changed files the way every changed-files list does (a folder entry is not a change)', async () => {
        snapshot = changedSnapshot(2, [{
            path: 'vendor/', previousPath: null, kind: 'untracked', includeStatus: '?', pendingStatus: '?',
            hasIncludedDelta: false, hasPendingDelta: true, stats: STATS,
        }]);
        const { SessionDetailsEmptyState } = await import('./SessionDetailsEmptyState');
        const screen = await renderScreen(<SessionDetailsEmptyState sessionId="s1" openDetailsTab={vi.fn()} />);
        expect(screen.getTextContent()).toContain('detailsSurface.chrome.reviewChanges:{"count":2}');
    });
});
