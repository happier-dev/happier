import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    collectHostText,
    installToolShellCommonModuleMocks,
    makeToolCall,
} from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: ({ expanded, children }: any) =>
        expanded ? React.createElement(React.Fragment, null, children) : null,
}));

installToolShellCommonModuleMocks({
    expoRouter: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Text: 'Text',
            TouchableOpacity: 'TouchableOpacity',
            ActivityIndicator: 'ActivityIndicator',
            NativeModules: {},
            Platform: { OS: 'ios', select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null },
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
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
        }),
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Bash: {
            title: 'Terminal',
            minimal: true,
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

describe('ToolView (minimal tools)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders a structured fallback view for minimal tools without a specific view', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Bash',
            input: { command: 'echo hello' },
            result: { stdout: 'hello\n', stderr: '' },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        const flattened = collectHostText(screen.tree);
        expect(flattened.some((item) => item.includes('stdout'))).toBe(true);
        expect(flattened).not.toContain('toolView.input');
        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(0);
    });

    it('hides body for minimal tools with no output payload', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Bash',
            state: 'completed',
            input: { command: 'echo hello' },
            result: null,
        });

        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        const flattened = collectHostText(screen.tree);
        expect(flattened).not.toContain('stdout');
        expect(flattened).not.toContain('toolView.input');
    });
});
