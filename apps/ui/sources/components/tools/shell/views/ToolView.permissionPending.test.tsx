import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createUseSettingMock } from '@/dev/testkit/mocks/storage';
import {
    createTestSessionTranscriptSource,
    renderWithSessionTranscriptSource,
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

const elapsed = vi.hoisted(() => ({ seconds: 45.6 }));
vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => elapsed.seconds,
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
    PermissionFooter: (props: { canApprovePermissions?: boolean }) => React.createElement('PermissionFooter', props),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    resolveAgentIdFromFlavor: () => null,
}));

// Load the real owner after boundary setup so cold module evaluation is outside a test and its act lifetime.
const { ToolView } = await import('./ToolView');

describe('ToolView (permission pending)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('rejects a pending permission surface without its transcript source', async () => {
        const tool = makeToolCall({
            state: 'running',
            completedAt: null,
            permission: { id: 'perm1', status: 'pending' },
        });
        await expect(renderScreen(React.createElement(ToolView, {
            tool, metadata: null, messages: [], sessionId: 's1',
        }))).rejects.toMatchObject({ name: 'SessionTranscriptSourceMissingError' });
    });

    it('keeps pending permissions closed with a read-only source when the interaction prop is absent', async () => {
        const screen = await renderWithSessionTranscriptSource(React.createElement(ToolView, {
            tool: makeToolCall({ state: 'running', completedAt: null, permission: { id: 'perm1', status: 'pending' } }),
            metadata: null, messages: [], sessionId: 's1',
        }), createTestSessionTranscriptSource());
        const footers = screen.findAllByType('PermissionFooter');
        expect(footers).toHaveLength(1);
        expect(footers[0]?.props.canApprovePermissions).toBe(false);
    });

    it('marks a card waiting for the person with the one attention edge, and drops it once settled', async () => {
        // A viewer who can answer: the edge says the card needs them.
        const answering = createTestSessionTranscriptSource({
            interaction: { canSendMessages: true, canApprovePermissions: true },
            actions: { respondToPermission: async () => {}, answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {} },
        });
        const waiting = await renderWithSessionTranscriptSource(React.createElement(ToolView, {
            tool: makeToolCall({ name: 'execute', state: 'running', input: { command: 'pwd' }, result: null, completedAt: null,
                permission: { id: 'perm1', status: 'pending' } }),
            metadata: null, messages: [], sessionId: 's1', messageId: 'm1',
        }), answering);
        expect(waiting.findByTestId('tool-view-waiting-edge')).toBeTruthy();
        const settled = await renderWithSessionTranscriptSource(React.createElement(ToolView, {
            tool: makeToolCall({ name: 'execute', state: 'running', input: { command: 'pwd' }, result: null, completedAt: null,
                permission: { id: 'perm1', status: 'approved' } }),
            metadata: null, messages: [], sessionId: 's1', messageId: 'm1',
        }), answering);
        expect(settled.findByTestId('tool-view-waiting-edge')).toBeNull();
    });

    it('keeps the attention edge for people who can answer: a read-only viewer sees a quiet card', async () => {
        const viewer = await renderWithSessionTranscriptSource(React.createElement(ToolView, {
            tool: makeToolCall({ name: 'execute', state: 'running', input: { command: 'pwd' }, result: null, completedAt: null,
                permission: { id: 'perm1', status: 'pending' } }),
            metadata: null, messages: [], sessionId: 's1', messageId: 'm1',
            interaction: { canSendMessages: true, canApprovePermissions: false, permissionDisabledReason: 'readOnly' },
        }), createTestSessionTranscriptSource({
            interaction: { canSendMessages: true, canApprovePermissions: false, permissionDisabledReason: 'readOnly' },
            actions: { respondToPermission: async () => {}, answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {} },
        }));
        expect(viewer.findByTestId('tool-view-waiting-edge')).toBeNull();
    });

    it('does not show elapsed time while waiting for permission', async () => {
        const tool = makeToolCall({
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
            completedAt: null,
            permission: { id: 'perm1', status: 'pending' },
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        expect(collectHostText(screen.tree)).not.toContain('45s');
    });

    it('shows elapsed time when running without pending permission', async () => {
        const tool = makeToolCall({
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
            completedAt: null,
            permission: undefined,
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        // Under a minute: whole seconds, never a tenth.
        expect(collectHostText(screen.tree)).toContain('45s');
    });

    it('says a long-running tool in human units, never as a seconds counter', async () => {
        elapsed.seconds = 33689.0;
        const tool = makeToolCall({
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
            completedAt: null,
            permission: undefined,
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        const text = collectHostText(screen.tree);
        expect(text).not.toContain('33689');
        expect(text).toContain('machineVitals.alerts.durations.hoursMinutes');
        elapsed.seconds = 45.6;
    });

    it('does not render PermissionFooter once the tool is completed', async () => {
        const tool = makeToolCall({
            name: 'execute',
            state: 'completed',
            input: { command: 'pwd' },
            result: { stdout: '/tmp\n' },
            // Some providers can leave permission status stale; ToolView should not show action buttons in that case.
            permission: { id: 'perm1', status: 'pending' },
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        expect(screen.findAllByType('PermissionFooter' as any)).toHaveLength(0);
    });

    it('renders the tool view but does not render PermissionFooter when the session is inactive', async () => {
        const tool = makeToolCall({
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
            completedAt: null,
            permission: { id: 'perm1', status: 'pending' },
        });

        const screen = await renderWithSessionTranscriptSource(
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
