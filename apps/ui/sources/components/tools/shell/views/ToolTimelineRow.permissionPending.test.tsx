import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn();

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
    },
}));

installToolShellCommonModuleMocks({
    expoRouter: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            TouchableOpacity: ({ children, ...props }: any) => React.createElement('TouchableOpacity', props, children),
            ActivityIndicator: 'ActivityIndicator',
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
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => settings[key],
            },
        }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Bash: { title: 'Bash' },
    },
}));

vi.mock('@/components/tools/normalization/core/normalizeToolCallForRendering', () => ({
    normalizeToolCallForRendering: (tool: any) => tool,
}));

vi.mock('@/components/tools/normalization/policy/toolNameInference', () => ({
    inferToolNameForRendering: ({ toolName }: any) => ({ normalizedToolName: toolName, source: 'original' }),
}));

vi.mock('@/components/tools/normalization/policy/resolveToolViewDetailLevel', () => ({
    resolveToolViewDetailLevel: () => 'summary',
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (name: string) => name,
    formatMCPSubtitle: () => null,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/shell/presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('host')(importOriginal);
});

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: (props: any) => React.createElement('CodeView', props),
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

vi.mock('@/components/ui/text/Text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock(),
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextSelectabilityScope: ({ children }: any) => children,
    };
});

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: (props: any) => React.createElement('PermissionFooter', props),
}));

vi.mock('../approvals/ApprovalPromptCard', () => ({
    ApprovalPromptCard: (props: any) => React.createElement('ApprovalPromptCard', props),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: ({ expanded, children }: any) =>
        expanded ? React.createElement(React.Fragment, null, children) : null,
}));

let settings: Record<string, unknown> = {};

describe('ToolTimelineRow (permission pending)', () => {
    beforeEach(() => {
        settings = {
            toolViewDetailLevelDefault: 'summary',
            toolViewDetailLevelDefaultLocalControl: 'summary',
            toolViewDetailLevelByToolName: {},
            toolViewExpandedDetailLevelDefault: 'full',
            toolViewExpandedDetailLevelByToolName: {},
            toolViewTimelineFeedDefaultExpanded: false,
            toolViewTapAction: 'expand',
            permissionPromptSurface: 'transcript',
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders PermissionFooter for pending permission requests in activity-feed rows', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'tool-1',
            name: 'Bash',
            state: 'running',
            input: { command: 'pwd' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'pwd',
            result: null,
            permission: { id: 'perm1', kind: 'command', status: 'pending' },
        };

        const screen = await renderScreen(
            <ToolTimelineRow
                tool={tool}
                metadata={null}
                sessionId="s1"
                messageId="m1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(screen.findAllByType('PermissionFooter' as any)).toHaveLength(1);
    });

    it('renders approval prompt cards linked to the current transcript tool call', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'tool-approval',
            name: 'session_list',
            state: 'running',
            input: { limit: 20 },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'List sessions',
            result: null,
        };

        const screen = await renderScreen(
            <ToolTimelineRow
                tool={tool}
                metadata={null}
                sessionId="s1"
                messageId="m-approval"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
                approvalRequests={[
                    {
                        artifact: { id: 'approval-1', header: {} } as any,
                        approval: {
                            v: 1,
                            status: 'open',
                            createdAtMs: 1,
                            updatedAtMs: 1,
                            createdBy: { surface: 'session_agent', sessionId: 's1' },
                            actionId: 'session.list',
                            actionArgs: {},
                            summary: 'List sessions',
                            origin: {
                                kind: 'transcript_tool_call',
                                sessionId: 's1',
                                messageId: 'm-approval',
                                toolCallId: 'tool-approval',
                                toolName: 'session_list',
                                toolInput: { limit: 20 },
                            },
                        },
                    },
                ]}
            />,
        );

        expect(screen.findAllByType('ApprovalPromptCard' as any)).toHaveLength(1);
    });

    it('does not render approval prompt cards when explicit origin message points at another tool row', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'tool-current',
            name: 'session_list',
            state: 'running',
            input: { limit: 20 },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'List sessions',
            result: null,
        };

        const screen = await renderScreen(
            <ToolTimelineRow
                tool={tool}
                metadata={null}
                sessionId="s1"
                messageId="m-current"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
                approvalRequests={[
                    {
                        artifact: { id: 'approval-other', header: {} } as any,
                        approval: {
                            v: 1,
                            status: 'open',
                            createdAtMs: 1,
                            updatedAtMs: 1,
                            createdBy: { surface: 'session_agent', sessionId: 's1' },
                            actionId: 'session.list',
                            actionArgs: {},
                            summary: 'List sessions',
                            origin: {
                                kind: 'transcript_tool_call',
                                sessionId: 's1',
                                messageId: 'm-other',
                                toolName: 'session_list',
                                toolInput: { limit: 20 },
                            },
                        },
                    },
                ]}
            />,
        );

        expect(screen.findAllByType('ApprovalPromptCard' as any)).toHaveLength(0);
    });

    it('does not render approval prompt cards when explicit origin tool id points at another tool row', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'tool-current',
            name: 'session_list',
            state: 'running',
            input: { limit: 20 },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'List sessions',
            result: null,
        };

        const screen = await renderScreen(
            <ToolTimelineRow
                tool={tool}
                metadata={null}
                sessionId="s1"
                messageId="m-current"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
                approvalRequests={[
                    {
                        artifact: { id: 'approval-other-tool', header: {} } as any,
                        approval: {
                            v: 1,
                            status: 'open',
                            createdAtMs: 1,
                            updatedAtMs: 1,
                            createdBy: { surface: 'session_agent', sessionId: 's1' },
                            actionId: 'session.list',
                            actionArgs: {},
                            summary: 'List sessions',
                            origin: {
                                kind: 'transcript_tool_call',
                                sessionId: 's1',
                                toolCallId: 'tool-other',
                                toolName: 'session_list',
                                toolInput: { limit: 20 },
                            },
                        },
                    },
                ]}
            />,
        );

        expect(screen.findAllByType('ApprovalPromptCard' as any)).toHaveLength(0);
    });

    it('renders PermissionFooter when transcript prompts are forced even if the global setting prefers the composer', async () => {
        settings.permissionPromptSurface = 'composer';

        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'tool-2',
            name: 'Bash',
            state: 'running',
            input: { command: 'pwd' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'pwd',
            result: null,
            permission: { id: 'perm2', kind: 'command', status: 'pending' },
        };

        const screen = await renderScreen(
            <ToolTimelineRow
                tool={tool}
                metadata={null}
                sessionId="s1"
                messageId="m2"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
                forcePermissionPromptsInTranscript={true}
            />,
        );

        expect(screen.findAllByType('PermissionFooter' as any)).toHaveLength(1);
    });

    it('renders the tool row but does not render PermissionFooter when the session is inactive', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'tool-inactive',
            name: 'Bash',
            state: 'running',
            input: { command: 'pwd' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'pwd',
            result: null,
            permission: { id: 'perm-inactive', kind: 'command', status: 'pending' },
        };

        const screen = await renderScreen(
            <ToolTimelineRow
                tool={tool}
                metadata={null}
                sessionId="s1"
                messageId="m1"
                interaction={{ canSendMessages: false, canApprovePermissions: false, permissionDisabledReason: 'inactive' }}
            />,
        );

        expect(screen.findAllByTestId('tool-timeline-row').length).toBeGreaterThan(0);
        expect(screen.findAllByType('PermissionFooter' as any)).toHaveLength(0);
    });
});
