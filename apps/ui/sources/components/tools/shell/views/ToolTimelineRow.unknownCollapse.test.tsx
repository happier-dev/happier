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
import { makeToolCall } from './ToolView.testHelpers';

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
                                        Platform: { OS: 'web' },
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

vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                text: '#111',
                textSecondary: '#555',
                textLink: '#09f',
                textDestructive: '#c00',
                divider: '#ddd',
                shadow: { color: '#000' },
                surfaceHigh: '#eee',
                surfaceHighest: '#fff',
                surfacePressedOverlay: '#ddd',
                warning: '#f90',
            },
        },
    }));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/ui/text/Text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock(),
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
    };
});

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: (props: any) => React.createElement('CodeView', props),
}));

vi.mock('@/components/tools/shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement('ToolSectionView', null, children),
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

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        resolveAgentIdFromFlavor: () => null,
        getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    };
});

let settings: Record<string, any> = {};
vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: (key: string) => settings[key],
        },
    }));

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
