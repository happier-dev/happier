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
    StyleSheet: {
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        groupped: { sectionTitle: '#aaa' },
                        textSecondary: '#999',
                        gitAddedText: '#0f0',
                        gitRemovedText: '#f00',
                    },
                })
                : value,
    },
}));

describe('ProjectGitStatus', () => {
    beforeEach(() => {
        snapshotMock = null;
    });

    it('renders changed file count when there are non-line changes', async () => {
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
        const { ProjectGitStatus } = await import('./ProjectGitStatus');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ProjectGitStatus sessionId="session-1" />);
        });
        const labels = tree!.root.findAllByType('Text' as any).map((node) => String(node.props.children));
        expect(labels).toContain('2 files');
    });
});
