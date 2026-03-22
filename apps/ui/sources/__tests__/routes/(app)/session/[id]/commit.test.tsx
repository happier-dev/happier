import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

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
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                        ScrollView: ({ children }: any) => React.createElement('ScrollView', null, children),
                                        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                                        Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
                                        useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
                                    }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
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
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        params: searchParams as any,
        router: {
            back: (...args: unknown[]) => routerBack(...args),
            push: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        },
    });
    return {
        ...routerMock.module,
        useLocalSearchParams: () => searchParams,
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

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

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionScmDiffCommit: vi.fn(async () => ({
                success: true,
                diff: 'diff --git a/a.ts b/a.ts',
            })),
            sessionScmCommitBackout: vi.fn(async () => ({
                success: true,
            })),
        },
    });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            storage: {
                getState: () => ({
                    sessions: {
                        'session-1': {
                            metadata: {
                                path: '/repo',
                                host: 'localhost',
                            },
                        } as any,
                    },
                }),
            } as any,
            useSessions: () => (storageFixture.isStorageDataReady ? [] : null),
            useSession: (id: string) => storageFixture.sessionById[id] ?? null,
            useSessionProjectScmInFlightOperation: () => null,
            // Narrow test fixture: this route only reads repo/branch/totals from the snapshot.
            useSessionProjectScmSnapshot: (() => ({
                projectKey: 'session-1',
                fetchedAt: 0,
                entries: [],
                repo: { isRepo: true, rootPath: '/repo' },
                branch: { head: 'main', detached: false },
                hasConflicts: false,
                totals: { includedFiles: 0, pendingFiles: 0 },
            })) as any,
            useSetting: () => true,
            useLocalSetting: (() => null) as any,
        },
    });
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

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        confirmResult: true,
    }).module;
});

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
                    host: 'localhost',
                },
            },
        };
        codeLinesSpy.mockClear();
        syntaxHookSpy.mockClear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        standardCleanup();
    });

    const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
        <AppPaneProvider>{children ?? null}</AppPaneProvider>
    );

    async function renderCommitScreen(Screen: React.ComponentType<any>) {
        return renderScreen(
            <Screen />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );
    }

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
        const screen = await renderCommitScreen(Screen);

        const list = screen.root.findByType('DiffFilesListView' as any);
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

        const screen = await renderCommitScreen(Screen);

        // Still loading; no diff call yet.
        expect(screen.root.findAllByType('ActivityIndicator' as any).length).toBeGreaterThan(0);
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

        await screen.update(<Screen />);
        await flushHookEffects();

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
        const screen = await renderCommitScreen(Screen);
        expect(screen.findByTestId('scm-commit-details-error-message')?.props.children).toBe('files.commitDetails.missingContext');
    });

    it('strips accidental whitespace suffixes from commit refs passed via URL params', async () => {
        // This mirrors the UI bug where a commit "ref" string included the oneline subject.
        searchParams = { id: 'session-1', sha: '0338a0f chore: stage b.txt' };

        const { sessionScmDiffCommit } = await import('@/sync/ops');
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;

        await renderCommitScreen(Screen);

        expect(vi.mocked(sessionScmDiffCommit)).toHaveBeenCalled();
        const [, request] = vi.mocked(sessionScmDiffCommit).mock.calls[0]!;
        expect(request.commit).toBe('0338a0f');
    });

    it('hides revert action when git write operations are disabled', async () => {
        scmWriteEnabled = false;
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        expect(screen.findAllByTestId('scm-commit-details-revert')).toHaveLength(0);
    });

    it('shows revert action when git write operations are enabled', async () => {
        scmWriteEnabled = true;
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        expect(screen.findByTestId('scm-commit-details-revert')).toBeTruthy();
    });

    it('shows a fallback error when loading commit diff throws', async () => {
        const { sessionScmDiffCommit } = await import('@/sync/ops');
        vi.mocked(sessionScmDiffCommit).mockRejectedValueOnce(new Error('network down'));
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        expect(screen.findByTestId('scm-commit-details-error-message')?.props.children).toBe('network down');
    });

    it('shows a back button when commit diff fails to load', async () => {
        const { sessionScmDiffCommit } = await import('@/sync/ops');
        vi.mocked(sessionScmDiffCommit).mockResolvedValueOnce({
            success: false,
            error: 'Commit reference must not contain whitespace',
        } as any);

        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        expect(screen.findByTestId('scm-commit-details-back')).toBeTruthy();

        await act(async () => {
            screen.pressByTestId('scm-commit-details-back');
        });
        expect(routerBack).toHaveBeenCalledTimes(1);
    });

    it('shows an error alert when revert throws unexpectedly', async () => {
        const { sessionScmCommitBackout } = await import('@/sync/ops');
        const { Modal } = await import('@/modal');
        vi.mocked(sessionScmCommitBackout).mockRejectedValueOnce(new Error('rpc unavailable'));
        const Screen = (await import('@/app/(app)/session/[id]/commit')).default;
        const screen = await renderCommitScreen(Screen);
        const revertButton = screen.findByTestId('scm-commit-details-revert');
        expect(revertButton).toBeTruthy();

        await act(async () => {
            await revertButton?.props.onPress();
        });
        await flushHookEffects();

        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'rpc unavailable');
    });
});
