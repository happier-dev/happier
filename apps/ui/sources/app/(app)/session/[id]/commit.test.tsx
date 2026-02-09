import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let gitWriteEnabled = true;

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: ({ children }: any) => React.createElement('ScrollView', null, children),
    ActivityIndicator: 'ActivityIndicator',
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    Platform: { select: (value: any) => value?.default ?? null },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#111',
                surfaceHigh: '#222',
                divider: '#333',
                text: '#fff',
                textSecondary: '#aaa',
                textDestructive: '#f33',
                warning: '#f80',
            },
        },
    }),
    StyleSheet: { create: (value: any) => value },
}));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: 'session-1', sha: 'abc123' }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 999 },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/components/git/diff/GitDiffDisplay', () => ({
    GitDiffDisplay: ({ diffContent }: any) => React.createElement('GitDiffDisplay', { diffContent }),
}));

vi.mock('@/sync/ops', () => ({
    sessionGitDiffCommit: vi.fn(async () => ({
        success: true,
        diff: 'diff --git a/a.ts b/a.ts',
    })),
    sessionGitCommitRevert: vi.fn(async () => ({
        success: true,
    })),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            sessions: {
                'session-1': {
                    metadata: {
                        path: '/repo',
                    },
                },
            },
        }),
    },
    useSessionProjectGitInFlightOperation: () => null,
    useSessionProjectGitSnapshot: () => ({
        repo: { isGitRepo: true, rootPath: '/repo' },
        branch: { head: 'main', detached: false },
        hasConflicts: false,
        totals: { stagedFiles: 0, unstagedFiles: 0 },
    }),
    useSetting: () => true,
}));

vi.mock('@/sync/git/operations/safety', () => ({
    canRevertFromSnapshot: () => true,
}));

vi.mock('@/sync/git/operations/policy', () => ({
    evaluateGitOperationPreflight: () => ({ allowed: true, message: '' }),
}));

vi.mock('@/sync/git/operations/userFacingErrors', () => ({
    getGitUserFacingError: ({ fallback }: any) => fallback,
}));

vi.mock('@/sync/git/operations/featureFlags', () => ({
    resolveGitWriteEnabled: () => gitWriteEnabled,
}));

vi.mock('@/sync/git/operations/revertFeedback', () => ({
    buildRevertConfirmBody: () => 'confirm',
}));

vi.mock('@/sync/git/operations/withOperationLock', () => ({
    withSessionProjectGitOperationLock: async ({ run }: any) => {
        await run();
        return { started: true };
    },
}));

vi.mock('@/sync/git/operations/reporting', () => ({
    reportSessionGitOperation: vi.fn(),
    trackBlockedGitOperation: vi.fn(),
}));

vi.mock('@/track', () => ({
    tracking: {},
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: vi.fn(async () => true),
    },
}));

vi.mock('@/sync/git/gitStatusSync', () => ({
    gitStatusSync: {
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
    },
}));

describe('CommitScreen', () => {
    beforeEach(() => {
        gitWriteEnabled = true;
        vi.clearAllMocks();
    });

    it('hides revert action when git write operations are disabled', async () => {
        gitWriteEnabled = false;
        const Screen = (await import('./commit')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        const labels = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => String(node.props.children));
        expect(labels).not.toContain('Revert commit');
    });

    it('shows revert action when git write operations are enabled', async () => {
        gitWriteEnabled = true;
        const Screen = (await import('./commit')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        const labels = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => String(node.props.children));
        expect(labels).toContain('Revert commit');
    });

    it('shows a fallback error when loading commit diff throws', async () => {
        const { sessionGitDiffCommit } = await import('@/sync/ops');
        vi.mocked(sessionGitDiffCommit).mockRejectedValueOnce(new Error('network down'));
        const Screen = (await import('./commit')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        const labels = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => String(node.props.children));
        expect(labels).toContain('network down');
    });

    it('shows an error alert when revert throws unexpectedly', async () => {
        const { sessionGitCommitRevert } = await import('@/sync/ops');
        const { Modal } = await import('@/modal');
        vi.mocked(sessionGitCommitRevert).mockRejectedValueOnce(new Error('rpc unavailable'));
        const Screen = (await import('./commit')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        const pressables = tree!.root.findAllByType('Pressable' as any);
        const revertButton = pressables.find((node) => {
            const textNodes = node.findAllByType('Text' as any);
            return textNodes.some((textNode) => String(textNode.props.children) === 'Revert commit');
        });
        expect(revertButton).toBeTruthy();

        await act(async () => {
            await revertButton!.props.onPress();
        });

        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'rpc unavailable');
    });
});
