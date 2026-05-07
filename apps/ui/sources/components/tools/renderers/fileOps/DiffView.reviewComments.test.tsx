import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import { installFileOpsRendererCommonModuleMocks } from './fileOpsRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffFilesListSpy = vi.fn();
const storageState = vi.hoisted(() => ({
    current: {
        sessions: {},
        machines: {},
        sessionListViewDataByServerId: {},
        getProjectForSession: () => null,
        upsertWorkspaceReviewCommentDraft: () => {},
        deleteWorkspaceReviewCommentDraft: () => {},
    } as any,
    store: undefined as any,
}));
storageState.store = Object.assign(
    ((selector?: (value: any) => unknown) => (
        typeof selector === 'function' ? selector(storageState.current) : storageState.current
    )),
    {
        getState: () => storageState.current,
        getInitialState: () => storageState.current,
        setState: () => undefined,
        subscribe: () => () => undefined,
        destroy: () => undefined,
    },
);

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
            useWorkspaceReviewCommentsDrafts: () => [],
            storage: storageState.store,
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
    useToolHeaderActions: () => {},
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'files.reviewComments',
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

describe('DiffView (review comments)', () => {
    beforeEach(() => {
        storageState.current = {
            sessions: {
                s1: {
                    id: 's1',
                    active: true,
                    serverId: 'server-1',
                    metadata: { machineId: 'machine-1', path: '/repo' },
                },
            },
            machines: {},
            sessionListViewDataByServerId: {},
            getProjectForSession: () => null,
            upsertWorkspaceReviewCommentDraft: () => {},
            deleteWorkspaceReviewCommentDraft: () => {},
        };
    });

    it('passes a renderInlineUnifiedDiff override when review comments are enabled and sessionId is available', async () => {
        diffFilesListSpy.mockClear();
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
        storageState.current = {
            sessions: {},
            machines: {},
            sessionListViewDataByServerId: {},
            getProjectForSession: () => null,
            upsertWorkspaceReviewCommentDraft: () => {},
            deleteWorkspaceReviewCommentDraft: () => {},
        };
        diffFilesListSpy.mockClear();
        const { DiffView } = await import('./DiffView');

        const tool = makeToolCall({
            name: 'Diff',
            state: 'completed',
            input: { unified_diff: 'diff --git a/src/a.ts b/src/a.ts' },
            result: null,
        });
        const element = React.createElement(DiffView, makeToolViewProps(tool, { sessionId: 's1', detailLevel: 'full' }));

        const screen = await renderScreen(element);

        expect(diffFilesListSpy.mock.calls.at(-1)?.[0]?.renderInlineUnifiedDiff).toBeUndefined();

        storageState.current = {
            sessions: {
                s1: {
                    id: 's1',
                    active: true,
                    serverId: 'server-1',
                    metadata: { machineId: 'machine-1', path: '/repo' },
                },
            },
            machines: {},
            sessionListViewDataByServerId: {},
            getProjectForSession: () => null,
            upsertWorkspaceReviewCommentDraft: () => {},
            deleteWorkspaceReviewCommentDraft: () => {},
        };

        await screen.update(React.createElement(DiffView, makeToolViewProps(tool, { sessionId: 's1', detailLevel: 'summary' })));

        expect(typeof diffFilesListSpy.mock.calls.at(-1)?.[0]?.renderInlineUnifiedDiff).toBe('function');
    });
});
