import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let snapshotMock: any = null;

vi.mock('@/sync/domains/state/storage', () => ({
    useSessionProjectGitSnapshot: () => snapshotMock,
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

describe('GitStatusBadge', () => {
    beforeEach(() => {
        snapshotMock = null;
    });

    it('renders nothing when no git snapshot is available', async () => {
        const { GitStatusBadge } = await import('./GitStatusBadge');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<GitStatusBadge sessionId="session-1" />);
        });
        expect(tree!.toJSON()).toBeNull();
    });

    it('shows combined staged + unstaged line deltas from snapshot totals', async () => {
        snapshotMock = {
            repo: { isGitRepo: true, rootPath: '/repo' },
            branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
            totals: {
                stagedFiles: 1,
                unstagedFiles: 1,
                untrackedFiles: 0,
                stagedAdded: 10,
                stagedRemoved: 5,
                unstagedAdded: 8,
                unstagedRemoved: 7,
            },
        };
        const { GitStatusBadge } = await import('./GitStatusBadge');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<GitStatusBadge sessionId="session-1" />);
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
            repo: { isGitRepo: true, rootPath: '/repo' },
            branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
            totals: {
                stagedFiles: 0,
                unstagedFiles: 0,
                untrackedFiles: 2,
                stagedAdded: 0,
                stagedRemoved: 0,
                unstagedAdded: 0,
                unstagedRemoved: 0,
            },
        };
        const { GitStatusBadge } = await import('./GitStatusBadge');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<GitStatusBadge sessionId="session-1" />);
        });
        const labels = tree!.root.findAllByType('Text' as any).map((node) => {
            const value = node.props.children;
            return Array.isArray(value) ? value.join('') : String(value);
        });

        expect(labels).toContain('2 files');
    });
});
