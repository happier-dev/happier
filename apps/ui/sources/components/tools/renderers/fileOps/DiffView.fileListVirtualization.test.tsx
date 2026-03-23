import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffFilesListSpy = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/components/ui/code/diff/DiffPresentationStyleToggleButton', () => ({
    DiffPresentationStyleToggleButton: 'DiffPresentationStyleToggleButton',
}));

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: any) => {
        diffFilesListSpy(props);
        return React.createElement('DiffFilesListView', props);
    },
}));

vi.mock('@/components/ui/code/model/diff/diffViewModel', () => ({
    buildDiffBlocks: () => [],
    buildDiffFileEntries: () => ([
        { key: 'a', filePath: 'a.ts', added: 2, removed: 1, unifiedDiff: null, oldText: null, newText: null, kind: null },
        { key: 'b', filePath: 'b.ts', added: 1, removed: 0, unifiedDiff: null, oldText: null, newText: null, kind: null },
    ]),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSetting: (key: string) => {
        if (key === 'showLineNumbersInToolViews') return false;
        if (key === 'wrapLinesInDiffs') return true;
        if (key === 'filesDiffFileListVirtualizationMinFiles') return 1;
        return undefined;
    },
    useSessionReviewCommentsDrafts: () => [],
    storage: { getState: () => ({ upsertSessionReviewCommentDraft: () => {}, deleteSessionReviewCommentDraft: () => {} }) },
});
});

vi.mock('@/sync/domains/settings/settings', () => ({
    settingsDefaults: {
        filesDiffFileListVirtualizationMinFiles: 20,
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

describe('DiffView (file list virtualization)', () => {
    it('enables file-list virtualization when file count exceeds threshold', async () => {
        diffFilesListSpy.mockClear();
        const { DiffView } = await import('./DiffView');

        const tool = makeToolCall({
            name: 'Diff',
            state: 'completed',
            input: { files: [] },
            result: null,
        });

        await renderScreen(React.createElement(DiffView, makeToolViewProps(tool, { detailLevel: 'full' })));

        expect(diffFilesListSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualizeFileList: true }));
    });
});
