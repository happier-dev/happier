import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn();

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                                        Animated: {
                                            Value: class {
                                                constructor(_value: unknown) {}
                                                setValue(_value: unknown) {}
                                                interpolate(_config: unknown) {
                                                    return 0;
                                                }
                                            },
                                            timing: () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }) }),
                                            View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
                                        },
                                        Easing: {
                                            bezier: () => (t: number) => t,
                                            linear: (t: number) => t,
                                        },
                                    }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/normalization/core/normalizeToolCallForRendering', () => ({
    normalizeToolCallForRendering: (tool: any) => tool,
}));

let inferred = { normalizedToolName: 'UnknownTool', source: 'original' };
vi.mock('@/components/tools/normalization/policy/toolNameInference', () => ({
    inferToolNameForRendering: () => inferred,
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (name: string) => name,
    formatMCPSubtitle: () => null,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement('ToolSectionView', null, children),
}));

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
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock(),
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

let settings: Record<string, unknown> = {};
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: (key: string) => settings[key],
        },
    });
});

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
        inferred = { normalizedToolName: 'UnknownTool', source: 'original' };
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
        inferred = { normalizedToolName: 'SomeInferredTool', source: 'description' };

        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            name: 'UnknownTool',
            state: 'completed',
            input: {},
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
