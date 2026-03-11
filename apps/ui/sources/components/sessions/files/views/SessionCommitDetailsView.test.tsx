import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SessionCommitDetailsView } from './SessionCommitDetailsView';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffFilesListSpy = vi.fn();

const sessionScmDiffCommitSpy = vi.fn(async (..._args: any[]) => ({
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

let sessionsMock: any = {};
let sessionMock: any = { metadata: { path: '/repo' } };
const stableSnapshot = { branch: { head: 'main', detached: false } };
let prefetchAheadCount = 1;
let prefetchBehindCount = 1;

vi.mock('react-native', () => ({
    View: 'View',
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Dimensions: { get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }) },
    Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                surface: '#fff',
                surfaceHigh: '#fff',
                divider: '#ddd',
                text: '#111',
                textSecondary: '#666',
                warning: '#f00',
                textLink: '#00f',
                groupped: { background: '#fff' },
            },
        },
    }),
    StyleSheet: { create: (fn: any) => fn({ colors: { divider: '#ddd' } }) },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

let reviewCommentsEnabled = false;

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => reviewCommentsEnabled,
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffCommit: (...args: any[]) => sessionScmDiffCommitSpy(...args),
    sessionScmCommitBackout: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ upsertSessionReviewCommentDraft: () => {}, deleteSessionReviewCommentDraft: () => {} }) },
    useSessions: () => sessionsMock,
    useSession: () => sessionMock,
    useProjectForSession: () => ({ key: { machineId: 'm1', path: '/repo' } }),
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
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: vi.fn(async () => false),
    },
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
    getScmUserFacingError: ({ fallback }: any) => fallback,
}));

vi.mock('@/scm/operations/revertFeedback', () => ({
    buildRevertConfirmBody: () => 'body',
}));

vi.mock('@/scm/operations/withOperationLock', () => ({
    withSessionProjectScmOperationLock: async ({ run }: any) => {
        await run();
        return { started: true, message: '' };
    },
}));

vi.mock('@/scm/operations/reporting', () => ({
    reportSessionScmOperation: vi.fn(),
    trackBlockedScmOperation: vi.fn(),
}));

vi.mock('@/track', () => ({
    tracking: null,
}));

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: any) => {
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
    it('renders the diff file list using virtualization', async () => {
        reviewCommentsEnabled = false;
        sessionScmDiffCommitSpy.mockClear();
        diffFilesListSpy.mockClear();
        sessionsMock = {};
        sessionMock = { metadata: { path: '/repo' } };
        prefetchAheadCount = 1;
        prefetchBehindCount = 1;

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (diffFilesListSpy.mock.calls.length > 0) break;
        }

        expect(sessionScmDiffCommitSpy).toHaveBeenCalled();
        expect(diffFilesListSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualizeFileList: true }));
        expect(tree.root.findAllByType('DiffPresentationStyleToggleButton' as any)).toHaveLength(1);
        expect(tree.root.findAllByType('ScrollView' as any)).toHaveLength(0);
    });

    it('does not auto-collapse diffs that are already above the viewport (prevents scroll snapping)', async () => {
        reviewCommentsEnabled = false;
        sessionScmDiffCommitSpy.mockClear();
        diffFilesListSpy.mockClear();
        sessionsMock = {};
        sessionMock = { metadata: { path: '/repo' } };
        prefetchAheadCount = 0;
        prefetchBehindCount = 0;

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

        await act(async () => {
            renderer.create(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (diffFilesListSpy.mock.calls.length > 0) break;
        }

        const firstRenderProps = diffFilesListSpy.mock.calls.at(-1)?.[0];
        expect(firstRenderProps).toBeTruthy();
        const firstKeys = Array.from((firstRenderProps as any).expandedKeys as Set<string>);
        expect(firstKeys).toHaveLength(1);

        const files = (firstRenderProps as any).files as Array<{ key: string }>;
        expect(files).toHaveLength(3);

        await act(async () => {
            (firstRenderProps as any).onViewableItemsChanged?.({
                viewableItems: [{ index: 1 }],
            });
        });

        await act(async () => {
            await Promise.resolve();
        });

        const secondRenderProps = diffFilesListSpy.mock.calls.at(-1)?.[0];
        const expandedKeys = (secondRenderProps as any).expandedKeys as Set<string>;
        expect(expandedKeys.has(files[0].key)).toBe(true);
        expect(expandedKeys.has(files[1].key)).toBe(true);
    });

    it('does not refetch the diff when the session object identity changes', async () => {
        reviewCommentsEnabled = false;
        sessionScmDiffCommitSpy.mockClear();
        diffFilesListSpy.mockClear();
        sessionsMock = {};
        sessionMock = { metadata: { path: '/repo' } };
        prefetchAheadCount = 1;
        prefetchBehindCount = 1;

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (diffFilesListSpy.mock.calls.length > 0) break;
        }

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);

        sessionMock = { metadata: { path: '/repo' } };
        await act(async () => {
            tree.update(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        await act(async () => {
            await Promise.resolve();
        });

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps rendering the loaded diff if session metadata temporarily becomes unavailable', async () => {
        reviewCommentsEnabled = false;
        sessionScmDiffCommitSpy.mockClear();
        diffFilesListSpy.mockClear();
        sessionsMock = {};
        sessionMock = { metadata: { path: '/repo' } };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (
                diffFilesListSpy.mock.calls.length > 0
                && tree.root.findAllByType('DiffPresentationStyleToggleButton' as any).length > 0
            ) {
                break;
            }
        }

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);
        expect(diffFilesListSpy).toHaveBeenCalled();
        expect(tree.root.findAllByType('DiffPresentationStyleToggleButton' as any)).toHaveLength(1);

        // Simulate a transient store reset where the session object is not present.
        sessionMock = null;
        await act(async () => {
            tree.update(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);
        expect(tree.root.findAllByType('DiffPresentationStyleToggleButton' as any)).toHaveLength(1);
    });

    it('does not refetch the diff when sessions storage readiness toggles after the diff loads', async () => {
        reviewCommentsEnabled = false;
        sessionScmDiffCommitSpy.mockClear();
        diffFilesListSpy.mockClear();
        sessionsMock = {};
        sessionMock = { metadata: { path: '/repo' } };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (diffFilesListSpy.mock.calls.length > 0) break;
        }

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);

        // Simulate the sync layer temporarily reporting "not ready" and then ready again.
        sessionsMock = null;
        await act(async () => {
            tree.update(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        sessionsMock = {};
        await act(async () => {
            tree.update(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        await act(async () => {
            await Promise.resolve();
        });

        expect(sessionScmDiffCommitSpy).toHaveBeenCalledTimes(1);
    });

    it('enables review comments rendering for inline diffs when the feature is enabled', async () => {
        reviewCommentsEnabled = true;
        sessionScmDiffCommitSpy.mockClear();
        diffFilesListSpy.mockClear();
        sessionsMock = {};
        sessionMock = { metadata: { path: '/repo' } };

        await act(async () => {
            renderer.create(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (diffFilesListSpy.mock.calls.length > 0) break;
        }

        const props = diffFilesListSpy.mock.calls[0]?.[0];
        expect(typeof props?.renderInlineUnifiedDiff).toBe('function');

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
        reviewCommentsEnabled = false;
        sessionScmDiffCommitSpy.mockClear();
        diffFilesListSpy.mockClear();
        sessionsMock = {};
        sessionMock = { metadata: { path: '/repo' } };

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

        await act(async () => {
            renderer.create(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (diffFilesListSpy.mock.calls.length > 0) break;
        }

        const props = diffFilesListSpy.mock.calls[0]?.[0];
        expect(props).toBeTruthy();

        const keys = (props.files as any[]).map((f) => f.key);
        const expandedKeys = Array.from(props.expandedKeys as Set<string>);
        expandedKeys.sort();
        const expected = keys.slice(0, 3).slice().sort(); // ahead(1)+behind(1)+1 = 3
        expect(expandedKeys).toEqual(expected);
        expect(typeof props.onViewableItemsChanged).toBe('function');
    });

    it('does not auto-expand diffs above the first visible file (prevents scroll snap-back)', async () => {
        reviewCommentsEnabled = false;
        sessionScmDiffCommitSpy.mockClear();
        diffFilesListSpy.mockClear();
        sessionsMock = {};
        sessionMock = { metadata: { path: '/repo' } };
        prefetchAheadCount = 1;
        prefetchBehindCount = 2;

        const filesDiff = Array.from({ length: 8 }, (_v, i) => ([
            `diff --git a/src/f${i}.ts b/src/f${i}.ts`,
            `--- a/src/f${i}.ts`,
            `+++ b/src/f${i}.ts`,
            '@@ -1 +1 @@',
            `-v${i}`,
            `+v${i + 1}`,
            '',
        ].join('\n'))).join('\n');

        sessionScmDiffCommitSpy.mockImplementationOnce(async () => ({
            success: true,
            diff: filesDiff,
            error: null,
        }));

        await act(async () => {
            renderer.create(<SessionCommitDetailsView sessionId="s1" sha="abc" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (diffFilesListSpy.mock.calls.length > 0) break;
        }

        const initialProps = diffFilesListSpy.mock.calls.at(-1)?.[0] as any;
        expect(initialProps).toBeTruthy();

        const files = initialProps.files as Array<{ key: string }>;
        expect(files).toHaveLength(8);

        await act(async () => {
            initialProps.onViewableItemsChanged?.({ viewableItems: [{ index: 5 }] });
        });
        await act(async () => {
            await Promise.resolve();
        });

        const afterProps = diffFilesListSpy.mock.calls.at(-1)?.[0] as any;
        const expandedKeys = afterProps.expandedKeys as Set<string>;

        // Index 4 is above the first visible index 5. Expanding it would change height above the viewport
        // and make scrolling down feel like it's fighting the user.
        expect(expandedKeys.has(files[4].key)).toBe(false);
        expect(expandedKeys.has(files[5].key)).toBe(true);
    });
});
