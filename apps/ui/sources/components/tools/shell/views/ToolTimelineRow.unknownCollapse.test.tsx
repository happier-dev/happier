import React from 'react';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn();

let settings: Record<string, unknown> = {};

installToolShellCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => settings[key],
            },
        });
    },
});

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
    },
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/ui/text/Text', async () => {
    return {
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
    };
});

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: (props: any) => React.createElement('CodeView', props),
}));

vi.mock('@/components/tools/shell/presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('host')(importOriginal);
});

vi.mock('@/components/tools/shell/presentation/ToolHeaderActionsContext', () => ({
    ToolHeaderActionsContext: { Provider: ({ children }: any) => children },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => React.createElement('StructuredResultView'),
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/tools/shell/presentation/ToolError', () => ({
    ToolError: () => React.createElement('ToolError'),
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        resolveAgentIdFromFlavor: () => null,
        getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    };
});

describe('ToolTimelineRow (unknown tool collapse)', () => {
    beforeEach(() => {
        settings = {
            toolViewDetailLevelDefault: 'summary',
            toolViewDetailLevelDefaultLocalControl: 'summary',
            toolViewDetailLevelByToolName: {},
            toolViewExpandedDetailLevelDefault: 'full',
            toolViewExpandedDetailLevelByToolName: {},
            toolViewTimelineFeedDefaultExpanded: false,
            toolViewTapAction: 'expand',
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('collapses completed unknown tools to title-only by default', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool = makeToolCall({
            name: 'TotallyUnknownTool',
            state: 'completed',
            input: { a: 1 },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            result: { ok: true },
        });

        const screen = await renderScreen(React.createElement(ToolTimelineRow, { tool, metadata: null }));

        expect(screen.findByTestId('tool-timeline-body')).toBeNull();
    });
});
