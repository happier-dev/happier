import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import type { Session, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const commitSessionId = 's1';
const commitSha = 'abc';
const diffFilesListSpy = vi.fn();

const sessionScmDiffCommitSpy = vi.fn(async (_sessionId: string, _request: { commit: string }) => ({
    success: true,
    diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 0000000..1111111 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,1 +1,1 @@',
        '-export const a = 1;',
        '+export const a = 2;',
        '',
    ].join('\n'),
    error: null,
}));

const sessionScmCommitBackoutSpy = vi.fn(async () => ({ success: true }));

let reviewCommentsEnabled = false;
let sessionsMock: Session[] | null = [];
let sessionMock: Session | null = createCommitSessionFixture();
let prefetchAheadCount = 1;
let prefetchBehindCount = 1;
const mountedTrees: renderer.ReactTestRenderer[] = [];
let SessionCommitDetailsViewComponent: typeof import('./SessionCommitDetailsView').SessionCommitDetailsView | null = null;

const stableSnapshot: ScmWorkingSnapshot = {
    projectKey: 'project-1',
    fetchedAt: 1,
    repo: {
        isRepo: true,
        rootPath: '/repo',
        backendId: 'git',
        mode: '.git',
        worktrees: [],
    },
    branch: {
        head: 'main',
        upstream: null,
        ahead: 0,
        behind: 0,
        detached: false,
    },
    hasConflicts: false,
    entries: [],
    totals: {
        includedFiles: 0,
        pendingFiles: 0,
        untrackedFiles: 0,
        includedAdded: 0,
        includedRemoved: 0,
        pendingAdded: 0,
        pendingRemoved: 0,
    },
};

function createCommitSessionFixture(): Session {
    return createSessionFixture({
        metadata: {
            path: '/repo',
            host: 'tester.local',
            homeDir: '/Users/tester',
            machineId: 'machine-1',
        } as Session['metadata'],
    });
}

function resetCommitDetailsStorageState(): void {
    sessionsMock = [];
    sessionMock = createCommitSessionFixture();
    prefetchAheadCount = 1;
    prefetchBehindCount = 1;
}

function getLastDiffFilesListProps(): Record<string, unknown> | null {
    return (diffFilesListSpy.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined) ?? null;
}

async function settleCommitDetailsView(): Promise<void> {
    await flushHookEffects({ cycles: 2 });
}

async function loadSessionCommitDetailsViewComponent(): Promise<typeof import('./SessionCommitDetailsView').SessionCommitDetailsView> {
    if (!SessionCommitDetailsViewComponent) {
        const module = await import('./SessionCommitDetailsView');
        SessionCommitDetailsViewComponent = module.SessionCommitDetailsView;
    }
    return SessionCommitDetailsViewComponent;
}

async function renderCommitDetailsView(): Promise<renderer.ReactTestRenderer> {
    const SessionCommitDetailsView = await loadSessionCommitDetailsViewComponent();
    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SessionCommitDetailsView sessionId={commitSessionId} sha={commitSha} />)).tree;
    await settleCommitDetailsView();
    mountedTrees.push(tree);
    return tree;
}

installSessionFilesViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ActivityIndicator: 'ActivityIndicator',
            Pressable: 'Pressable',
            ScrollView: 'ScrollView',
            Dimensions: {
                get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            },
            Platform: {
                OS: 'web',
                select: (value: Record<string, unknown>) => value?.web ?? value?.default ?? null,
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => false),
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: createStorageStoreMock({
                upsertSessionReviewCommentDraft: () => {},
                deleteSessionReviewCommentDraft: () => {},
            }),
            useSessions: () => sessionsMock,
            useSession: () => sessionMock,
            useProjectForSession: () => null,
            useSessionProjectScmSnapshot: () => stableSnapshot,
            useSessionProjectScmInFlightOperation: () => null,
            useSessionReviewCommentsDrafts: () => [],
            useSetting: (key: string) => {
                if (key === 'wrapLinesInDiffs') return true;
                if (key === 'showLineNumbers') return true;
                if (key === 'scmReviewMaxFiles') return 1;
                if (key === 'scmReviewMaxChangedLines') return 2000;
                if (key === 'scmReviewPrefetchAheadCountWeb') return prefetchAheadCount;
                if (key === 'scmReviewPrefetchBehindCountWeb') return prefetchBehindCount;
                if (key === 'scmReviewPrefetchDebounceMs') return 0;
                return undefined;
            },
            importOriginal,
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffCommit: (...args: Parameters<typeof sessionScmDiffCommitSpy>) => sessionScmDiffCommitSpy(...args),
    sessionScmCommitBackout: (...args: Parameters<typeof sessionScmCommitBackoutSpy>) => sessionScmCommitBackoutSpy(...args),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => (featureId === 'files.reviewComments' ? reviewCommentsEnabled : false),
}));

vi.mock('@/track', () => ({
    tracking: null,
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
    },
}));

vi.mock('@/scm/operations/safety', () => ({
    canRevertFromSnapshot: () => true,
}));

vi.mock('@/scm/core/operationPolicy', () => ({
    evaluateScmOperationPreflight: () => ({ allowed: true, message: '' }),
}));

vi.mock('@/scm/operations/userFacingErrors', () => ({
    getScmUserFacingError: ({ fallback }: { fallback: string }) => fallback,
}));

vi.mock('@/scm/operations/revertFeedback', () => ({
    buildRevertConfirmBody: () => 'body',
}));

vi.mock('@/scm/operations/withOperationLock', () => ({
    withSessionProjectScmOperationLock: async ({ run }: { run: () => Promise<void> }) => {
        await run();
        return { started: true, message: '' };
    },
}));

vi.mock('@/scm/operations/reporting', () => ({
    reportSessionScmOperation: vi.fn(),
    trackBlockedScmOperation: vi.fn(),
}));

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: Record<string, unknown>) => {
        diffFilesListSpy(props);
        return React.createElement('DiffFilesListView', props);
    },
}));

vi.mock('@/components/ui/code/diff/DiffPresentationStyleToggleButton', () => ({
    DiffPresentationStyleToggleButton: 'DiffPresentationStyleToggleButton',
}));

vi.mock('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer', () => ({
    DiffReviewCommentsViewer: 'DiffReviewCommentsViewer',
}));

describe('SessionCommitDetailsView', () => {
    afterEach(async () => {
        while (mountedTrees.length > 0) {
            const tree = mountedTrees.pop();
            if (!tree) continue;
            await act(async () => {
                tree.unmount();
            });
        }
    });

    beforeEach(() => {
        reviewCommentsEnabled = false;
        sessionScmDiffCommitSpy.mockClear();
        sessionScmCommitBackoutSpy.mockClear();
        diffFilesListSpy.mockClear();
        resetCommitDetailsStorageState();
    });

    it('renders the diff file list using virtualization', async () => {
        const tree = await renderCommitDetailsView();

        expect(sessionScmDiffCommitSpy).toHaveBeenCalled();
        expect(diffFilesListSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualizeFileList: true }));
        expect(tree.findAllByType('DiffPresentationStyleToggleButton' as any)).toHaveLength(1);
        expect(tree.findAllByType('ScrollView' as any)).toHaveLength(0);
    });

    it('does not auto-collapse diffs that are already above the viewport (prevents scroll snapping)', async () => {
        sessionScmDiffCommitSpy.mockResolvedValueOnce({
            success: true,
            diff: [
                'diff --git a/src/a.ts b/src/a.ts',
                'index 0000000..1111111 100644',
                '--- a/src/a.ts',
                '+++ b/src/a.ts',
                '@@ -1,1 +1,1 @@',
                '-export const a = 1;',
                '+export const a = 2;',
                '',
                'diff --git a/src/b.ts b/src/b.ts',
                'index 0000000..1111111 100644',
                '--- a/src/b.ts',
                '+++ b/src/b.ts',
                '@@ -1,1 +1,1 @@',
                '-export const b = 1;',
                '+export const b = 2;',
                '',
                'diff --git a/src/c.ts b/src/c.ts',
                'index 0000000..1111111 100644',
                '--- a/src/c.ts',
                '+++ b/src/c.ts',
                '@@ -1,1 +1,1 @@',
                '-export const c = 1;',
                '+export const c = 2;',
                '',
            ].join('\n'),
            error: null,
        });
        prefetchAheadCount = 0;
        prefetchBehindCount = 0;
        const tree = await renderCommitDetailsView();
        const firstRenderProps = getLastDiffFilesListProps();
        expect(firstRenderProps).toBeTruthy();

        const firstKeys = Array.from((firstRenderProps as { expandedKeys: ReadonlySet<string> }).expandedKeys);
        expect(firstKeys).toHaveLength(1);

        const files = (firstRenderProps as { files: Array<{ key: string }> }).files;
        expect(files).toHaveLength(3);

        await act(async () => {
            (firstRenderProps as { onViewableItemsChanged?: (info: { viewableItems: Array<{ index: number }> }) => void })
                .onViewableItemsChanged?.({
                    viewableItems: [{ index: 1 }],
                });
        });
        await settleCommitDetailsView();

        const secondRenderProps = getLastDiffFilesListProps();
        const expandedKeys = (secondRenderProps as { expandedKeys: ReadonlySet<string> }).expandedKeys;
        expect(expandedKeys.has(files[0].key)).toBe(true);
        expect(expandedKeys.has(files[1].key)).toBe(true);

        expect(tree.findAllByType('DiffPresentationStyleToggleButton' as any)).toHaveLength(1);
    });

    it('does not refetch the diff when the session object identity changes', async () => {
        const tree = await renderCommitDetailsView();
        const SessionCommitDetailsView = await loadSessionCommitDetailsViewComponent();

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);

        sessionMock = createCommitSessionFixture();

        await act(async () => {
            tree.update(<SessionCommitDetailsView sessionId={commitSessionId} sha={commitSha} />);
        });
        await settleCommitDetailsView();

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps rendering the loaded diff if session metadata temporarily becomes unavailable', async () => {
        const tree = await renderCommitDetailsView();
        const SessionCommitDetailsView = await loadSessionCommitDetailsViewComponent();

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);
        expect(diffFilesListSpy).toHaveBeenCalled();
        expect(tree.findAllByType('DiffPresentationStyleToggleButton' as any)).toHaveLength(1);

        sessionMock = null;
        await act(async () => {
            tree.update(<SessionCommitDetailsView sessionId={commitSessionId} sha={commitSha} />);
        });
        await settleCommitDetailsView();

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);
        expect(tree.findAllByType('DiffPresentationStyleToggleButton' as any)).toHaveLength(1);
    });

    it('does not refetch the diff when sessions storage readiness toggles after the diff loads', async () => {
        const tree = await renderCommitDetailsView();
        const SessionCommitDetailsView = await loadSessionCommitDetailsViewComponent();

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);

        sessionsMock = null;
        await act(async () => {
            tree.update(<SessionCommitDetailsView sessionId={commitSessionId} sha={commitSha} />);
        });
        await settleCommitDetailsView();

        sessionsMock = [];
        await act(async () => {
            tree.update(<SessionCommitDetailsView sessionId={commitSessionId} sha={commitSha} />);
        });
        await settleCommitDetailsView();

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);
    });

    it('enables review comments rendering for inline diffs when the feature is enabled', async () => {
        reviewCommentsEnabled = true;
        await renderCommitDetailsView();

        const props = getLastDiffFilesListProps() as {
            renderInlineUnifiedDiff?: (input: {
                file: { key: string };
                virtualized: boolean;
                maxVirtualizedHeight: number;
                wrapLines: boolean;
                showLineNumbers: boolean;
                showPrefix: boolean;
            }) => { type?: unknown } | null;
            files: Array<{ key: string }>;
        };

        if (typeof props.renderInlineUnifiedDiff !== 'function') {
            throw new Error('Expected renderInlineUnifiedDiff to be a function');
        }

        const node = props.renderInlineUnifiedDiff({
            file: props.files[0],
            virtualized: false,
            maxVirtualizedHeight: 123,
            wrapLines: true,
            showLineNumbers: true,
            showPrefix: true,
        });

        expect(node?.type).toBe('DiffReviewCommentsViewer');
    });

    it('auto-expands the first review window for large commits using the same settings as the working tree review', async () => {
        sessionScmDiffCommitSpy.mockImplementationOnce(async () => ({
            success: true,
            diff: [
                'diff --git a/src/a.ts b/src/a.ts',
                '--- a/src/a.ts',
                '+++ b/src/a.ts',
                '@@ -1 +1 @@',
                '-a',
                '+a2',
                '',
                'diff --git a/src/b.ts b/src/b.ts',
                '--- a/src/b.ts',
                '+++ b/src/b.ts',
                '@@ -1 +1 @@',
                '-b',
                '+b2',
                '',
                'diff --git a/src/c.ts b/src/c.ts',
                '--- a/src/c.ts',
                '+++ b/src/c.ts',
                '@@ -1 +1 @@',
                '-c',
                '+c2',
                '',
                'diff --git a/src/d.ts b/src/d.ts',
                '--- a/src/d.ts',
                '+++ b/src/d.ts',
                '@@ -1 +1 @@',
                '-d',
                '+d2',
                '',
            ].join('\n'),
            error: null,
        }));
        prefetchAheadCount = 1;
        prefetchBehindCount = 1;
        await renderCommitDetailsView();

        const props = getLastDiffFilesListProps() as { files: Array<{ key: string }>; expandedKeys: ReadonlySet<string> };
        expect(props).toBeTruthy();

        const keys = props.files.map((file) => file.key);
        const expandedKeys = Array.from(props.expandedKeys);
        expandedKeys.sort();
        const expected = keys.slice(0, 3).slice().sort(); // ahead(1)+behind(1)+1 = 3
        expect(expandedKeys).toEqual(expected);
        expect(typeof (getLastDiffFilesListProps() as { onViewableItemsChanged?: unknown }).onViewableItemsChanged).toBe('function');
    });

    it('does not auto-expand diffs above the first visible file (prevents scroll snap-back)', async () => {
        sessionScmDiffCommitSpy.mockImplementationOnce(async () => ({
            success: true,
            diff: Array.from({ length: 8 }, (_v, i) => ([
                `diff --git a/src/f${i}.ts b/src/f${i}.ts`,
                `--- a/src/f${i}.ts`,
                `+++ b/src/f${i}.ts`,
                '@@ -1 +1 @@',
                `-v${i}`,
                `+v${i + 1}`,
                '',
            ].join('\n'))).join('\n'),
            error: null,
        }));
        prefetchAheadCount = 1;
        prefetchBehindCount = 2;
        await renderCommitDetailsView();

        const initialProps = getLastDiffFilesListProps() as {
            files: Array<{ key: string }>;
            expandedKeys: ReadonlySet<string>;
            onViewableItemsChanged?: (info: { viewableItems: Array<{ index: number }> }) => void;
        };
        expect(initialProps).toBeTruthy();

        const files = initialProps.files;
        expect(files).toHaveLength(8);

        await act(async () => {
            initialProps.onViewableItemsChanged?.({ viewableItems: [{ index: 5 }] });
        });

        const afterProps = getLastDiffFilesListProps() as {
            expandedKeys: ReadonlySet<string>;
        };
        const expandedKeys = afterProps.expandedKeys;

        // Index 4 is above the first visible index 5. Expanding it would change height above the viewport
        // and make scrolling down feel like it's fighting the user.
        expect(expandedKeys.has(files[4].key)).toBe(false);
        expect(expandedKeys.has(files[5].key)).toBe(true);
    });
});
