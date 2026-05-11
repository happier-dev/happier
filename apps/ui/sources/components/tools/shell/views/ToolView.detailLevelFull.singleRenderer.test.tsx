import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    installToolShellCommonModuleMocks,
    makeToolCall,
} from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Read: { title: 'Read' },
    },
}));

const renderedToolViewSpy = vi.fn();

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => (props: any) => {
        renderedToolViewSpy(props);
        return React.createElement('SpecificToolView', null);
    },
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

installToolShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ScrollView: 'ScrollView',
            Platform: {
                OS: 'ios',
                select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null,
            },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewDetailLevelDefault') return 'full';
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'full';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewTapAction') return 'expand';
                    if (key === 'toolViewExpandedDetailLevelDefault') return 'full';
                    if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                    return null;
                },
            },
        });
    },
});

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (t: string) => t,
    formatMCPSubtitle: () => '',
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('null')(importOriginal);
});

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

describe('ToolView (detail level: full)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders via the single tool renderer and passes detailLevel without calling getToolFullViewComponent', async () => {
        renderedToolViewSpy.mockReset();

        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        const screen = await renderScreen(React.createElement(ToolView, { tool, metadata: null }));

        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(1);
        expect(renderedToolViewSpy).toHaveBeenCalledWith(expect.objectContaining({ detailLevel: 'full' }));
    });

    it('keeps inline Task renderer in summary detail level', async () => {
        renderedToolViewSpy.mockReset();

        const { ToolView } = await import('./ToolView');
        const taskTool = makeToolCall({
            name: 'Task',
            input: { operation: 'run', description: 'Explore' },
            result: null,
        });

        const screen = await renderScreen(React.createElement(ToolView, { tool: taskTool, metadata: null }));

        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(1);
        expect(renderedToolViewSpy).toHaveBeenCalledWith(expect.objectContaining({ detailLevel: 'summary' }));
    });
});
