import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

import { makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let toolViewDetailLevelDefaultSetting: any = 'summary';

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                        Platform: { OS: 'ios', select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null },
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

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0.1,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        edit: {
            title: 'Edit',
            extractSubtitle: () => 'file.ts',
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

vi.mock('../presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('../presentation/ToolError', () => ({
    ToolError: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => React.createElement('PermissionFooter', null),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: ({ expanded, children }: any) =>
        expanded ? React.createElement(React.Fragment, null, children) : null,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key) => key,
    });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: (key: string) => {
                if (key === 'toolViewDetailLevelDefault') return toolViewDetailLevelDefaultSetting;
                if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
                if (key === 'toolViewDetailLevelByToolName') return {};
                if (key === 'toolViewShowDebugByDefault') return false;
                if (key === 'toolViewTapAction') return 'expand';
                if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
                if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                if (key === 'permissionPromptSurface') return 'transcript';
                return null;
            },
        },
    });
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    resolveAgentIdFromFlavor: () => null,
}));

describe('ToolView (card density)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders a separate subtitle line in comfortable density', async () => {
        toolViewDetailLevelDefaultSetting = 'summary';
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({ name: 'edit', state: 'running', input: {}, description: null, result: null });

        const screen = await renderScreen(React.createElement(ToolView, { tool, metadata: null, messages: [] }));

        expect(screen.findAllByTestId('tool-card-subtitle').length).toBeGreaterThan(0);
    });

    it('does not render a separate subtitle line in compact density', async () => {
        toolViewDetailLevelDefaultSetting = 'compact';
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({ name: 'edit', state: 'running', input: {}, description: null, result: null });

        const screen = await renderScreen(React.createElement(ToolView, { tool, metadata: null, messages: [] }));

        expect(screen.findAllByTestId('tool-card-subtitle')).toHaveLength(0);
    });
});
