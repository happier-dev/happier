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

installToolShellCommonModuleMocks({
    expoRouter: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios', select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null },
        }),
    text: async () =>
        (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
            translate: (key) => key,
        }),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewDetailLevelDefault') return 'summary';
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewShowDebugByDefault') return false;
                    if (key === 'toolViewTapAction') return 'expand';
                    if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
                    if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                    return null;
                },
            },
        }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0.1,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        CodeSearch: {
            title: () => 'Code Search',
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

describe('ToolView (description fallback)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('shows input.description as a subtitle when no tool subtitle is provided', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'running',
            input: { description: 'Search for foo' },
            description: null,
            result: null,
        });

        const screen = await renderScreen(React.createElement(ToolView, { tool, metadata: null, messages: [] }));

        const flattened = collectHostText(screen.tree);
        expect(flattened.join(' ')).toContain('Search for foo');
    });
});
