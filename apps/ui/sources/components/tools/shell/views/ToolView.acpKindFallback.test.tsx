import React from 'react';
import {
    afterEach,
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

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

installToolShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewDetailLevelDefault') return 'summary';
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewShowDebugByDefault') return false;
                    return null;
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const renderedSpecificToolViewSpy = vi.fn();
const getToolViewComponentSpy = vi.fn((toolName: string) =>
    toolName === 'execute'
        ? (props: any) => {
              renderedSpecificToolViewSpy(props);
              return React.createElement('SpecificToolView', { resolvedName: props.tool?.name });
          }
        : null,
);

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: getToolViewComponentSpy,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        execute: {
            title: 'Terminal',
        },
    },
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: () => 'MCP',
    formatMCPSubtitle: () => '',
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('fragment')(importOriginal);
});

vi.mock('../presentation/ToolError', () => ({
    ToolError: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => React.createElement('PermissionFooter', null),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    resolveAgentIdFromFlavor: () => null,
}));

afterEach(() => {
    standardCleanup();
});

describe('ToolView (ACP kind fallback)', () => {
    it('uses tool.input._acp.kind to pick a specific view when tool.name is not a stable key', async () => {
        renderedSpecificToolViewSpy.mockReset();
        getToolViewComponentSpy.mockClear();
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Run echo hello',
            input: { _acp: { kind: 'execute', title: 'Run echo hello' }, command: ['/bin/zsh', '-lc', 'echo hello'] },
            result: { stdout: 'hello\n', stderr: '' },
            description: 'Run echo hello',
        });

        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        const specificViews = screen.findAllByType('SpecificToolView' as any);
        expect(specificViews).toHaveLength(1);
        expect(specificViews[0].props.resolvedName).toBe('Run echo hello');
        expect(getToolViewComponentSpy).toHaveBeenCalledWith('execute');
        expect(renderedSpecificToolViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                tool: expect.objectContaining({ name: 'Run echo hello' }),
            }),
        );
    });
});
