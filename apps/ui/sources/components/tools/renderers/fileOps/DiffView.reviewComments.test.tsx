import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import { installFileOpsRendererCommonModuleMocks } from './fileOpsRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffFilesListSpy = vi.fn();
const headerActionsSpy = vi.fn();
const upsertSessionReviewCommentDraftSpy = vi.fn();
const deleteSessionReviewCommentDraftSpy = vi.fn();
const upsertWorkspaceReviewCommentDraftSpy = vi.fn();
const deleteWorkspaceReviewCommentDraftSpy = vi.fn();
let lastInlineRendererConfig: any = null;
const workspaceScopeState = vi.hoisted(() => ({
    current: { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' } as any,
}));

installFileOpsRendererCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'showLineNumbersInToolViews') return false;
                if (key === 'wrapLinesInDiffs') return true;
                if (key === 'filesDiffFileListVirtualizationMinFiles') return 999;
                return undefined;
            },
            useSessionReviewCommentsDrafts: () => [{ id: 'session-draft', filePath: 'src/a.ts', source: 'diff', anchor: { kind: 'diffLine', startLine: 1, side: 'after', oldLine: null, newLine: 1 }, snapshot: { selectedLines: [], beforeContext: [], afterContext: [] }, body: 'session', createdAt: 1 }],
            useWorkspaceReviewCommentsDrafts: () => [{ id: 'workspace-draft', filePath: 'src/a.ts', source: 'diff', anchor: { kind: 'diffLine', startLine: 1, side: 'after', oldLine: null, newLine: 1 }, snapshot: { selectedLines: [], beforeContext: [], afterContext: [] }, body: 'workspace', createdAt: 1 }],
            storage: {
                getState: () => ({
                    upsertSessionReviewCommentDraft: (...args: unknown[]) => upsertSessionReviewCommentDraftSpy(...args),
                    deleteSessionReviewCommentDraft: (...args: unknown[]) => deleteSessionReviewCommentDraftSpy(...args),
                    upsertWorkspaceReviewCommentDraft: (...args: unknown[]) => upsertWorkspaceReviewCommentDraftSpy(...args),
                    deleteWorkspaceReviewCommentDraft: (...args: unknown[]) => deleteWorkspaceReviewCommentDraftSpy(...args),
                }),
            },
        });
    },
});

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: any) => {
        diffFilesListSpy(props);
        return React.createElement('DiffFilesListView', props);
    },
}));

vi.mock('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer', () => ({
    DiffReviewCommentsViewer: 'DiffReviewCommentsViewer',
}));

vi.mock('@/components/tools/shell/presentation/ToolHeaderActionsContext', () => ({
    useToolHeaderActions: (node: React.ReactNode) => headerActionsSpy(node),
}));

vi.mock('@/components/ui/code/WrapLinesToggleButton', () => ({
    WrapLinesToggleButton: 'WrapLinesToggleButton',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'files.reviewComments',
}));

vi.mock('@/sync/domains/session/resolveWorkspaceScopeForSession', () => ({
    resolveWorkspaceScopeForSession: () => workspaceScopeState.current,
    useWorkspaceScopeForSession: () => workspaceScopeState.current,
}));

vi.mock('@/components/ui/code/model/diff/diffViewModel', () => ({
    buildDiffBlocks: () => [],
    buildDiffFileEntries: () => ([
        {
            key: 'a',
            filePath: 'src/a.ts',
            added: 1,
            removed: 1,
            unifiedDiff: 'diff --git a/src/a.ts b/src/a.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n',
            oldText: null,
            newText: null,
            kind: null,
        },
    ]),
}));

vi.mock('@/sync/domains/settings/settings', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        settingsDefaults: {
            ...actual.settingsDefaults,
            filesDiffFileListVirtualizationMinFiles: 20,
        },
    };
});

vi.mock('@/components/ui/code/diff/reviewComments/useInlineUnifiedDiffReviewCommentsRenderer', () => ({
    useInlineUnifiedDiffReviewCommentsRenderer: (config: any) => {
        lastInlineRendererConfig = config;
        return ({ file }: { file: { filePath?: string } }) =>
            React.createElement('DiffReviewCommentsViewer', { filePath: file?.filePath ?? '' });
    },
}));

describe('DiffView (review comments)', () => {
    beforeEach(() => {
        headerActionsSpy.mockClear();
        workspaceScopeState.current = { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' };
    });

    it('offers wrapping in expanded diff headers without overloading summary headers', async () => {
        const { DiffView } = await import('./DiffView');
        const tool = makeToolCall({
            name: 'Diff',
            state: 'completed',
            input: { unified_diff: 'diff --git a/src/a.ts b/src/a.ts' },
            result: null,
        });
        const screen = await renderScreen(React.createElement(DiffView, makeToolViewProps(tool, { detailLevel: 'full' })));
        const fullHeader = await renderScreen(headerActionsSpy.mock.calls.at(-1)?.[0]);
        expect(fullHeader.findAllByType('WrapLinesToggleButton' as never)).toHaveLength(1);

        await screen.update(React.createElement(DiffView, makeToolViewProps(tool, { detailLevel: 'summary' })));
        const summaryHeader = await renderScreen(headerActionsSpy.mock.calls.at(-1)?.[0]);
        expect(summaryHeader.findAllByType('WrapLinesToggleButton' as never)).toHaveLength(0);
    });

    it('passes a renderInlineUnifiedDiff override when review comments are enabled and sessionId is available', async () => {
        diffFilesListSpy.mockClear();
        upsertSessionReviewCommentDraftSpy.mockClear();
        deleteSessionReviewCommentDraftSpy.mockClear();
        upsertWorkspaceReviewCommentDraftSpy.mockClear();
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        lastInlineRendererConfig = null;
        const { DiffView } = await import('./DiffView');

        const tool = makeToolCall({
            name: 'Diff',
            state: 'completed',
            input: { unified_diff: 'diff --git a/src/a.ts b/src/a.ts' },
            result: null,
        });

        await renderScreen(React.createElement(DiffView, makeToolViewProps(tool, { sessionId: 's1', detailLevel: 'full' })));

        const props = diffFilesListSpy.mock.calls[0]?.[0];
        expect(typeof props?.renderInlineUnifiedDiff).toBe('function');

        expect(lastInlineRendererConfig?.enabled).toBe(true);
        expect(lastInlineRendererConfig?.reviewCommentDrafts?.[0]?.id).toBe('workspace-draft');

        lastInlineRendererConfig.onUpsertReviewCommentDraft({
            id: 'draft-1',
            filePath: 'src/a.ts',
            source: 'diff',
            anchor: { kind: 'diffLine', startLine: 1, side: 'after', oldLine: null, newLine: 1 },
            snapshot: { selectedLines: [], beforeContext: [], afterContext: [] },
            body: 'hello',
            createdAt: 1,
        });
        expect(upsertWorkspaceReviewCommentDraftSpy).toHaveBeenCalledWith(
            'server-1:m1:/repo',
            expect.objectContaining({ id: 'draft-1' }),
        );
        expect(upsertSessionReviewCommentDraftSpy).toHaveBeenCalledTimes(0);

        lastInlineRendererConfig.onDeleteReviewCommentDraft('draft-1');
        expect(deleteWorkspaceReviewCommentDraftSpy).toHaveBeenCalledWith('server-1:m1:/repo', 'draft-1');
        expect(deleteSessionReviewCommentDraftSpy).toHaveBeenCalledTimes(0);

        const node = props.renderInlineUnifiedDiff({
            file: props.files[0],
            virtualized: false,
            maxVirtualizedHeight: 123,
            wrapLines: true,
            showLineNumbers: true,
            showPrefix: true,
        });

        expect(node?.type).toBe('DiffReviewCommentsViewer');
        expect(node?.props?.filePath).toBe('src/a.ts');
    });

    it('enables review comments after the session workspace state loads without changing sessions', async () => {
        workspaceScopeState.current = null;
        diffFilesListSpy.mockClear();
        lastInlineRendererConfig = null;
        const { DiffView } = await import('./DiffView');

        const tool = makeToolCall({
            name: 'Diff',
            state: 'completed',
            input: { unified_diff: 'diff --git a/src/a.ts b/src/a.ts' },
            result: null,
        });
        const element = React.createElement(DiffView, makeToolViewProps(tool, { sessionId: 's1', detailLevel: 'full' }));

        const screen = await renderScreen(element);

        expect(lastInlineRendererConfig?.enabled).toBe(false);

        workspaceScopeState.current = { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' };

        await screen.update(React.createElement(DiffView, makeToolViewProps(tool, { sessionId: 's1', detailLevel: 'summary' })));

        expect(lastInlineRendererConfig?.enabled).toBe(true);
    });
});
