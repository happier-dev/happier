import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';

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

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (name: string) => name,
    formatMCPSubtitle: () => null,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/shell/presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('host')(importOriginal);
});

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: (props: any) => React.createElement('CodeView', props),
}));

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

vi.mock('@/components/ui/text/Text', async () => {
    return {
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
    };
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

describe('ToolTimelineRow (title fallback)', () => {
    beforeEach(() => {
        settings = {
            toolViewDetailLevelDefault: 'summary',
            toolViewDetailLevelDefaultLocalControl: 'summary',
            toolViewDetailLevelByToolName: {},
            toolViewExpandedDetailLevelDefault: 'summary',
            toolViewExpandedDetailLevelByToolName: {},
            toolViewTimelineFeedDefaultExpanded: false,
            toolViewTapAction: 'expand',
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('does not use description as title when inference did not fall back', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            name: 'UnknownTool',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: 'Execute',
            result: {},
        };

        const screen = await renderScreen(React.createElement(ToolTimelineRow, { tool, metadata: null }));

        expect(screen.getTextContent()).toContain('UnknownTool');
        expect(screen.getTextContent()).not.toContain('Execute');
    });

    it('uses description as title when inference fell back and tool is unknown', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            name: 'UnknownTool',
            state: 'completed',
            input: { _acp: { kind: 'SomeInferredTool' } },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: 'Search files',
            result: {},
        };

        const screen = await renderScreen(React.createElement(ToolTimelineRow, { tool, metadata: null }));

        expect(screen.getTextContent()).toContain('Search files');
    });
});
