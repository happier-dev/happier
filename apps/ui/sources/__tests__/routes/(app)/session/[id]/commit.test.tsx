import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let scmWriteEnabled = true;
let searchParams: { id: string; sha: string } = { id: 'session-1', sha: 'abc123' };
let routerBack: ReturnType<typeof vi.fn> = vi.fn();
const storageFixture = vi.hoisted(() => ({
    isStorageDataReady: true,
    sessionById: {
        'session-1': {
            metadata: {
                path: '/repo',
            },
        },
    } as Record<string, any>,
}));

const codeLinesSpy = vi.fn();
const syntaxHookSpy = vi.fn();

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        ScrollView: ({ children }: any) => React.createElement('ScrollView', null, children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        Platform: { ...rn.Platform, OS: 'web', select: (value: any) => value?.default ?? null },
        useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
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

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: any) => {
        codeLinesSpy(props);
        return React.createElement('CodeLinesView', props);
    },
}));

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: any) => React.createElement('DiffFilesListView', props),
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    useCodeLinesSyntaxHighlighting: (filePath: string | null) => {
        syntaxHookSpy(filePath);
        return {
            mode: 'simple',
            language: filePath?.endsWith('.ts') ? 'typescript' : 'text',
            maxBytes: 250_000,
            maxLines: 5_000,
            maxLineLength: 2_000,
        };
    },
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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        ...actual,
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
        useSessions: () => (storageFixture.isStorageDataReady ? [] : null),
        useSession: (id: string) => storageFixture.sessionById[id] ?? null,
        useSessionProjectScmInFlightOperation: () => null,
        useSessionProjectScmSnapshot: () => ({
            repo: { isRepo: true, rootPath: '/repo' },
            branch: { head: 'main', detached: false },
            hasConflicts: false,
            totals: { includedFiles: 0, pendingFiles: 0 },
        }),
        useSetting: () => true,
        useLocalSetting: () => null,
    };
});

vi.mock('@/scm/operations/safety', () => ({
    canRevertFromSnapshot: () => true,
}));

vi.mock('@/scm/core/operationPolicy', () => ({
    evaluateScmOperationPreflight: () => ({ allowed: true, message: '' }),
}));

vi.mock('@/scm/operations/userFacingErrors', () => ({
    getScmUserFacingError: ({ fallback }: any) => fallback,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => scmWriteEnabled,
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
        scmWriteEnabled = true;
        searchParams = { id: 'session-1', sha: 'abc123' };
        routerBack = vi.fn();
        storageFixture.isStorageDataReady = true;
        storageFixture.sessionById = {
            'session-1': {
                metadata: {
                    path: '/repo',
                },
            },
        };
        codeLinesSpy.mockClear();
        syntaxHookSpy.mockClear();
        vi.clearAllMocks();
    });

    it('renders commit diffs per file with syntax highlighting per filePath', async () => {
        const { sessionScmDiffCommit } = await import('@/sync/ops');
        vi.mocked(sessionScmDiffCommit).mockResolvedValueOnce({
            success: true,
            diff: [
                'diff --git a/foo.ts b/foo.ts',
                '--- a/foo.ts',
                '+++ b/foo.ts',
                '@@ -1 +1 @@',
                '-old',
                '+new',
                'diff --git a/bar.ts b/bar.ts',
                '--- a/bar.ts',
                '+++ b/bar.ts',
                '@@ -1 +1 @@',
                '-a',
                '+b',
            ].join('\n'),
        } as any);

        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<AppPaneProvider><Screen /></AppPaneProvider>);
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        const list = tree!.root.findByType('DiffFilesListView' as any);
        expect(list.props.files).toHaveLength(2);
        const filePaths = (list.props.files ?? []).map((f: any) => String(f.filePath ?? ''));
        expect(filePaths).toContain('foo.ts');
        expect(filePaths).toContain('bar.ts');
    });

    it('loads commit diff after session path becomes available (deep-link hydration)', async () => {
        // Simulate a deep-link where storage isn't ready yet, then becomes ready with session metadata.
        storageFixture.isStorageDataReady = false;
        storageFixture.sessionById = {};

        const { sessionScmDiffCommit } = await import('@/sync/ops');
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

          let tree: renderer.ReactTestRenderer | null = null;
          await act(async () => {
              tree = renderer.create(<AppPaneProvider><Screen /></AppPaneProvider>);
          });
        await act(async () => {});

        // Still loading; no diff call yet.
        expect(tree!.root.findAllByType('ActivityIndicator' as any).length).toBeGreaterThan(0);
        expect(vi.mocked(sessionScmDiffCommit)).not.toHaveBeenCalled();

        // Storage rehydrates.
        storageFixture.isStorageDataReady = true;
        storageFixture.sessionById = {
            'session-1': {
                metadata: {
                    path: '/repo',
                },
            },
        };

          await act(async () => {
              tree!.update(<AppPaneProvider><Screen /></AppPaneProvider>);
          });
        await act(async () => {});

        expect(vi.mocked(sessionScmDiffCommit)).toHaveBeenCalled();
        const [, request] = vi.mocked(sessionScmDiffCommit).mock.calls.at(-1)!;
        expect(request.cwd).toBeUndefined();
        expect(request.commit).toBe('abc123');
    });

    it('shows missing context error when storage is ready but session is unknown', async () => {
        storageFixture.isStorageDataReady = true;
        storageFixture.sessionById = {};
        searchParams = { id: 'session-unknown', sha: 'abc123' } as any;
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

          let tree: renderer.ReactTestRenderer | null = null;
          await act(async () => {
              tree = renderer.create(<AppPaneProvider><Screen /></AppPaneProvider>);
          });
        await act(async () => {});

        const labels = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => String(node.props.children));
        expect(labels).toContain('files.commitDetails.missingContext');
    });

    it('strips accidental whitespace suffixes from commit refs passed via URL params', async () => {
        // This mirrors the UI bug where a commit "ref" string included the oneline subject.
        searchParams = { id: 'session-1', sha: '0338a0f chore: stage b.txt' };

        const { sessionScmDiffCommit } = await import('@/sync/ops');
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

          await act(async () => {
              renderer.create(<AppPaneProvider><Screen /></AppPaneProvider>);
          });
        await act(async () => {});

        expect(vi.mocked(sessionScmDiffCommit)).toHaveBeenCalled();
        const [, request] = vi.mocked(sessionScmDiffCommit).mock.calls[0]!;
        expect(request.commit).toBe('0338a0f');
    });

    it('hides revert action when git write operations are disabled', async () => {
        scmWriteEnabled = false;
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

          let tree: renderer.ReactTestRenderer | null = null;
          await act(async () => {
              tree = renderer.create(<AppPaneProvider><Screen /></AppPaneProvider>);
          });
        await act(async () => {});

        const labels = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => String(node.props.children));
        expect(labels).not.toContain('files.commitDetails.revert.button');
    });

    it('shows revert action when git write operations are enabled', async () => {
        scmWriteEnabled = true;
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

          let tree: renderer.ReactTestRenderer | null = null;
          await act(async () => {
              tree = renderer.create(<AppPaneProvider><Screen /></AppPaneProvider>);
          });
        await act(async () => {});

        const labels = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => String(node.props.children));
        expect(labels).toContain('files.commitDetails.revert.button');
    });

    it('shows a fallback error when loading commit diff throws', async () => {
        const { sessionScmDiffCommit } = await import('@/sync/ops');
        vi.mocked(sessionScmDiffCommit).mockRejectedValueOnce(new Error('network down'));
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

          let tree: renderer.ReactTestRenderer | null = null;
          await act(async () => {
              tree = renderer.create(<AppPaneProvider><Screen /></AppPaneProvider>);
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

        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

          let tree: renderer.ReactTestRenderer | null = null;
          await act(async () => {
              tree = renderer.create(<AppPaneProvider><Screen /></AppPaneProvider>);
          });
        await act(async () => {});

        const pressables = tree!.root.findAllByType('Pressable' as any);
        const backButton = pressables.find((node) => {
            const textNodes = node.findAllByType('Text' as any);
            return textNodes.some((textNode) => String(textNode.props.children) === 'common.back');
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
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

          let tree: renderer.ReactTestRenderer | null = null;
          await act(async () => {
              tree = renderer.create(<AppPaneProvider><Screen /></AppPaneProvider>);
          });
        await act(async () => {});

        const pressables = tree!.root.findAllByType('Pressable' as any);
        const revertButton = pressables.find((node) => {
            const textNodes = node.findAllByType('Text' as any);
            return textNodes.some((textNode) => String(textNode.props.children) === 'files.commitDetails.revert.button');
        });
        expect(revertButton).toBeTruthy();

        await act(async () => {
            await revertButton!.props.onPress();
        });

        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'rpc unavailable');
    });
});
