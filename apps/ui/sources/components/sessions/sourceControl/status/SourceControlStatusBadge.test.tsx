import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let snapshotMock: any = null;

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => ({
            settings: {
                preferredLanguage: 'en',
            },
        }),
    },
    useSessionProjectScmSnapshot: () => snapshotMock,
});
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                button: { secondary: { tint: '#999' } },
                gitAddedText: '#0f0',
                gitRemovedText: '#f00',
                shadow: { color: '#000', opacity: 0.1 },
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, values?: Record<string, unknown>) => {
        if (key === 'files.sourceControlStatus.changedFilesLabel') {
            return `${String(values?.count ?? '')} files`;
        }
        return key;
    } });
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
