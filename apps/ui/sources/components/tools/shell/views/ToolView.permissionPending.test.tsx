import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createUseSettingMock,
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
            Platform: {
                OS: 'ios',
                select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null,
            },
        }),
    text: async () =>
        (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                if (key === 'tools.common.elapsedSeconds') {
                    return `${params?.seconds}s`;
                }
                return key;
            },
        }),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({
                    values: {
                        toolViewDetailLevelDefault: 'summary',
                        toolViewDetailLevelDefaultLocalControl: 'title',
                        toolViewDetailLevelByToolName: {},
                        toolViewShowDebugByDefault: false,
                        permissionPromptSurface: 'transcript',
                    },
                    fallback: () => null,
                }),
            },
        }),
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 123.4,
}));

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

describe('ToolView (permission pending)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not show elapsed time while waiting for permission', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
            completedAt: null,
            permission: { id: 'perm1', status: 'pending' },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        expect(collectHostText(screen.tree)).not.toContain('123.4s');
    });

    it('shows elapsed time when running without pending permission', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
            completedAt: null,
            permission: undefined,
        });

        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        expect(collectHostText(screen.tree)).toContain('123.4s');
    });

    it('does not render PermissionFooter once the tool is completed', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'execute',
            state: 'completed',
            input: { command: 'pwd' },
            result: { stdout: '/tmp\n' },
            // Some providers can leave permission status stale; ToolView should not show action buttons in that case.
            permission: { id: 'perm1', status: 'pending' },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        expect(screen.findAllByType('PermissionFooter' as any)).toHaveLength(0);
    });

    it('renders the tool view but does not render PermissionFooter when the session is inactive', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
            completedAt: null,
            permission: { id: 'perm1', status: 'pending' },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, {
                tool,
                metadata: null,
                messages: [],
                sessionId: 's1',
                messageId: 'm1',
                interaction: { canSendMessages: false, canApprovePermissions: false, permissionDisabledReason: 'inactive' },
            }),
        );

        expect(screen.findAllByTestId('tool-view-header-primary')).toHaveLength(1);
        expect(screen.findAllByType('PermissionFooter' as any)).toHaveLength(0);
    });
});
