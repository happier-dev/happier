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
            AppState: {
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
                currentState: 'active',
            },
            Platform: {
                OS: 'ios',
                select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null,
            },
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
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'summary';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewTapAction') return 'expand';
                    if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
                    if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                    if (key === 'permissionPromptSurface') return 'transcript';
                    return null;
                },
            },
        }),
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Bash: {
            title: 'Bash',
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
    ToolError: ({ message }: any) => React.createElement('Text', null, message),
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => React.createElement('PermissionFooter', null),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: (agentId: string) => ({
        toolRendering: { hideUnknownToolsByDefault: false },
        permissions: { modeGroup: agentId === 'codex' ? 'codexLike' : 'cliLike' },
    }),
    resolveAgentIdFromFlavor: (flavor: any) => {
        if (flavor === 'claude' || flavor === 'codex') return flavor;
        return null;
    },
}));

describe('ToolView (permission denied)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps the inferred known tool title even when inference fallback is used', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            // Force inference fallback: tool name isn't known, but input.permission.toolName is.
            name: 'UnknownTool',
            description: 'execute',
            state: 'error',
            result: null,
            input: { permission: { toolName: 'Bash' } },
            permission: { id: 'perm1', status: 'denied', decision: 'denied' },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        const text = collectHostText(screen.tree);
        expect(text).toContain('Bash');
        expect(text).toContain('errors.permissionDenied');
        // The raw tool description should not replace the known tool title.
        expect(text).not.toContain('execute');
    });

    it('does not attribute denial to Read Only mode for non-codexLike providers', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Bash',
            description: 'Write',
            state: 'error',
            result: null,
            input: { command: "echo hi > /tmp/x" },
            permission: { id: 'perm1', status: 'denied' },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, {
                tool,
                metadata: { flavor: 'claude', permissionMode: 'read-only' } as any,
                messages: [],
                sessionId: 's1',
                messageId: 'm1',
            }),
        );

        const text = collectHostText(screen.tree).join('\n');
        expect(text).toContain('errors.permissionDenied');
        expect(text).not.toContain('errors.permissionDeniedReadOnlyMode');
    });

    it('attributes denial to Read Only mode for codexLike providers', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Bash',
            description: 'Write',
            state: 'error',
            result: null,
            input: { command: "echo hi > /tmp/x" },
            permission: { id: 'perm1', status: 'denied' },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, {
                tool,
                metadata: { flavor: 'codex', permissionMode: 'read-only' } as any,
                messages: [],
                sessionId: 's1',
                messageId: 'm1',
            }),
        );

        expect(collectHostText(screen.tree).join('\n')).toContain('errors.permissionDeniedReadOnlyMode');
    });
});
