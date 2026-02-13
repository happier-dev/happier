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
                        surfaceHighest: '#222',
                        textSecondary: '#999',
                        gitAddedText: '#0f0',
                        gitRemovedText: '#f00',
                    },
                })
                : value,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('CompactGitStatus', () => {
    beforeEach(() => {
        snapshotMock = null;
    });

    it('renders compact file count when there are non-line changes', async () => {
        snapshotMock = {
            repo: { isRepo: true, rootPath: '/repo' },
            branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
            totals: {
                untrackedFiles: 3,
                includedFiles: 0,
                pendingFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };
        const { CompactGitStatus } = await import('./CompactGitStatus');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<CompactGitStatus sessionId="session-1" />);
        });
        const labels = tree!.root.findAllByType('Text' as any).map((node) => String(node.props.children));
        expect(labels).toContain('3');
    });
});
