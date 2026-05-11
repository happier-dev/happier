import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const { toolErrorSpy } = vi.hoisted(() => ({
    toolErrorSpy: vi.fn(),
}));

installToolShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            NativeModules: {},
            Platform: {
                OS: 'ios',
                select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
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

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
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
    ToolError: (props: any) => {
        toolErrorSpy(props);
        return null;
    },
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

describe('ToolView (error message formatting)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('passes a JSON string to ToolError when the tool result is an object', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'SomeUnknownTool',
            state: 'error',
            input: { anything: true },
            result: { error: 'Tool call failed', status: 'failed' },
        });

        await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        expect(toolErrorSpy).toHaveBeenCalledTimes(1);
        const args = toolErrorSpy.mock.calls[0][0];
        expect(typeof args.message).toBe('string');
        expect(args.message).toContain('"error"');
        expect(args.message).toContain('"status"');
        expect(args.message).toContain('Tool call failed');
    });
});
