import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { installSourceControlStatusCommonModuleMocks } from './sourceControlStatusTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let snapshotMock: any = null;

installSourceControlStatusCommonModuleMocks({
    storage: async (importOriginal) =>
        createPartialStorageModuleMock(importOriginal, {
            storage: {
                getState: () => ({
                    settings: {
                        preferredLanguage: 'en',
                    },
                }),
            },
            useSessionProjectScmSnapshot: () => snapshotMock,
        }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, values?: Record<string, unknown>) => {
                if (key === 'files.sourceControlStatus.changedFilesLabel') {
                    return `${String(values?.count ?? '')} files`;
                }
                return key;
            },
        });
    },
});

describe('SourceControlStatusBadge', () => {
    beforeEach(() => {
        snapshotMock = null;
    });

    it('renders nothing when no git snapshot is available', async () => {
        const { SourceControlStatusBadge } = await import('./SourceControlStatusBadge');
        const screen = await renderScreen(<SourceControlStatusBadge sessionId="session-1" />);
        expect(screen.tree.toJSON()).toBeNull();
    });

    it('shows combined staged + unstaged line deltas from snapshot totals', async () => {
        snapshotMock = {
            repo: { isRepo: true, rootPath: '/repo' },
            branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
            totals: {
                includedFiles: 1,
                pendingFiles: 1,
                untrackedFiles: 0,
                includedAdded: 10,
                includedRemoved: 5,
                pendingAdded: 8,
                pendingRemoved: 7,
            },
        };
        const { SourceControlStatusBadge } = await import('./SourceControlStatusBadge');
        const screen = await renderScreen(<SourceControlStatusBadge sessionId="session-1" />);
        const labels = screen.getTextContent();

        expect(labels).toContain('+18');
        expect(labels).toContain('-12');
    });

    it('shows changed file count when there are changes without line deltas', async () => {
        snapshotMock = {
            repo: { isRepo: true, rootPath: '/repo' },
            branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
            entries: [{}, {}],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 2,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };
        const { SourceControlStatusBadge } = await import('./SourceControlStatusBadge');
        const screen = await renderScreen(<SourceControlStatusBadge sessionId="session-1" />);
        const labels = screen.getTextContent();

        expect(labels).toContain('2 files');
    });
});
