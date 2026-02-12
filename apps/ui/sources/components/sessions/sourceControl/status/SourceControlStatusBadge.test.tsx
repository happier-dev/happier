import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let snapshotMock: any = null;

vi.mock('@/sync/domains/state/storage', () => ({
    useSessionProjectScmSnapshot: () => snapshotMock,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                button: { secondary: { tint: '#999' } },
                gitAddedText: '#0f0',
                gitRemovedText: '#f00',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

describe('SourceControlStatusBadge', () => {
    beforeEach(() => {
        snapshotMock = null;
    });

    it('renders nothing when no git snapshot is available', async () => {
        const { SourceControlStatusBadge } = await import('./SourceControlStatusBadge');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SourceControlStatusBadge sessionId="session-1" />);
        });
        expect(tree!.toJSON()).toBeNull();
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
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SourceControlStatusBadge sessionId="session-1" />);
        });
        const labels = tree!.root.findAllByType('Text' as any).map((node) => {
            const value = node.props.children;
            return Array.isArray(value) ? value.join('') : String(value);
        });

        expect(labels).toContain('+18');
        expect(labels).toContain('-12');
    });

    it('shows changed file count when there are changes without line deltas', async () => {
        snapshotMock = {
            repo: { isRepo: true, rootPath: '/repo' },
            branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
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
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SourceControlStatusBadge sessionId="session-1" />);
        });
        const labels = tree!.root.findAllByType('Text' as any).map((node) => {
            const value = node.props.children;
            return Array.isArray(value) ? value.join('') : String(value);
        });

        expect(labels).toContain('2 files');
    });
});
