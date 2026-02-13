import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let gitWriteEnabled = true;
let searchParams: { id: string; sha: string } = { id: 'session-1', sha: 'abc123' };
let routerBack: ReturnType<typeof vi.fn> = vi.fn();
let isStorageDataReady = true;
let sessionById: Record<string, any> = {
    'session-1': {
        metadata: {
            path: '/repo',
        },
    },
};

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        View: 'View',
        ScrollView: ({ children }: any) => React.createElement('ScrollView', null, children),
        ActivityIndicator: 'ActivityIndicator',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        Platform: {
            ...actual.Platform,
            select: (value: any) => value?.default ?? null,
        },
        AppState: {
            ...((actual as any).AppState ?? {}),
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    };
});

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
    useLocalSearchParams: () => searchParams,
    useRouter: () => ({ back: routerBack }),
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

vi.mock('@/components/sessions/files/file/ScmDiffDisplay', () => ({
    ScmDiffDisplay: ({ diffContent }: any) => React.createElement('ScmDiffDisplay', { diffContent }),
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffCommit: vi.fn(async () => ({
        success: true,
        diff: 'diff --git a/a.ts b/a.ts',
    })),
    sessionScmCommitBackout: vi.fn(async () => ({
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
    useSessions: () => (isStorageDataReady ? [] : null),
    useSession: (id: string) => sessionById[id] ?? null,
    useSessionProjectScmInFlightOperation: () => null,
    useSessionProjectScmSnapshot: () => ({
        repo: { isRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    }),
    useSetting: () => true,
}));

vi.mock('@/scm/operations/safety', () => ({
    canRevertFromSnapshot: () => true,
}));

vi.mock('@/scm/core/operationPolicy', () => ({
    evaluateScmOperationPreflight: () => ({ allowed: true, message: '' }),
}));

vi.mock('@/scm/operations/userFacingErrors', () => ({
    getScmUserFacingError: ({ fallback }: any) => fallback,
}));

vi.mock('@/scm/operations/featureFlags', () => ({
    resolveScmWriteEnabled: () => gitWriteEnabled,
}));

vi.mock('@/scm/operations/revertFeedback', () => ({
    buildRevertConfirmBody: () => 'confirm',
}));

vi.mock('@/scm/operations/withOperationLock', () => ({
    withSessionProjectScmOperationLock: async ({ run }: any) => {
        await run();
        return { started: true };
    },
}));

vi.mock('@/scm/operations/reporting', () => ({
    reportSessionScmOperation: vi.fn(),
    trackBlockedScmOperation: vi.fn(),
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

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
    },
}));

describe('CommitScreen', () => {
    beforeEach(() => {
        gitWriteEnabled = true;
        searchParams = { id: 'session-1', sha: 'abc123' };
        routerBack = vi.fn();
        isStorageDataReady = true;
        sessionById = {
            'session-1': {
                metadata: {
                    path: '/repo',
                },
            },
        };
        vi.clearAllMocks();
    });

    it('loads commit diff after session path becomes available (deep-link hydration)', async () => {
        // Simulate a deep-link where storage isn't ready yet, then becomes ready with session metadata.
        isStorageDataReady = false;
        sessionById = {};

        const { sessionScmDiffCommit } = await import('@/sync/ops');
        const Screen = (await import('./commit')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        // Still loading; no diff call yet.
        expect(tree!.root.findAllByType('ActivityIndicator' as any).length).toBeGreaterThan(0);
        expect(vi.mocked(sessionScmDiffCommit)).not.toHaveBeenCalled();

        // Storage rehydrates.
        isStorageDataReady = true;
        sessionById = {
            'session-1': {
                metadata: {
                    path: '/repo',
                },
            },
        };

        await act(async () => {
            tree!.update(<Screen />);
        });
        await act(async () => {});

        expect(vi.mocked(sessionScmDiffCommit)).toHaveBeenCalled();
        const [sessionId, request] = vi.mocked(sessionScmDiffCommit).mock.calls.at(-1)!;
        expect(sessionId).toBe('session-1');
        expect(request.commit).toBe('abc123');
    });

    it('shows missing context error when storage is ready but session is unknown', async () => {
        isStorageDataReady = true;
        sessionById = {};
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
        expect(labels).toContain('Missing commit context');
    });

    it('strips accidental whitespace suffixes from commit refs passed via URL params', async () => {
        // This mirrors the UI bug where a commit "ref" string included the oneline subject.
        searchParams = { id: 'session-1', sha: '0338a0f chore: stage b.txt' };

        const { sessionScmDiffCommit } = await import('@/sync/ops');
        const Screen = (await import('./commit')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(vi.mocked(sessionScmDiffCommit)).toHaveBeenCalled();
        const [, request] = vi.mocked(sessionScmDiffCommit).mock.calls[0]!;
        expect(request.commit).toBe('0338a0f');
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
        const { sessionScmDiffCommit } = await import('@/sync/ops');
        vi.mocked(sessionScmDiffCommit).mockRejectedValueOnce(new Error('network down'));
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

    it('shows a back button when commit diff fails to load', async () => {
        const { sessionScmDiffCommit } = await import('@/sync/ops');
        vi.mocked(sessionScmDiffCommit).mockResolvedValueOnce({
            success: false,
            error: 'Commit reference must not contain whitespace',
        } as any);

        const Screen = (await import('./commit')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        const pressables = tree!.root.findAllByType('Pressable' as any);
        const backButton = pressables.find((node) => {
            const textNodes = node.findAllByType('Text' as any);
            return textNodes.some((textNode) => String(textNode.props.children) === 'Back');
        });
        expect(backButton).toBeTruthy();

        await act(async () => {
            backButton!.props.onPress();
        });
        expect(routerBack).toHaveBeenCalledTimes(1);
    });

    it('shows an error alert when revert throws unexpectedly', async () => {
        const { sessionScmCommitBackout } = await import('@/sync/ops');
        const { Modal } = await import('@/modal');
        vi.mocked(sessionScmCommitBackout).mockRejectedValueOnce(new Error('rpc unavailable'));
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
