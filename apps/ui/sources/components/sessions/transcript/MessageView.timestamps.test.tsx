import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessageStructuredPresentationV1 } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';
import type {
    PluginProjectionAction,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { PluginContributedActionCurrentSnapshot } from '@/components/plugins/actions/pluginContributedActionController';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios',
}));

let timestampDisplayMode = 'hover_web_hidden_mobile';
let copyButtonsVisible = false;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (values: Record<string, unknown>) =>
                    values?.[platformState.os] ?? values?.default,
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'transcriptMessageTimestampDisplayMode') return timestampDisplayMode;
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    if (key === 'sessionThinkingInlinePresentation') return 'summary';
                    if (key === 'sessionThinkingInlineChrome') return 'plain';
                    if (key === 'toolViewTimelineChromeMode') return 'cards';
                    return null;
                } }),
                useSessionForkSupportSource: () => null,
                useSessionWorkspacePath: () => null,
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => ({} as any),
            },
        });
    },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@/components/sessions/transcript/transcriptRowActionVisibility', () => ({
    shouldShowTranscriptRowActions: () => copyButtonsVisible,
    shouldShowTranscriptRowPinAction: () => copyButtonsVisible,
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: () => null,
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: () => null,
}));

vi.mock('@/components/sessions/transcript/thinking/ThinkingTimelineRow', () => ({
    ThinkingTimelineRow: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/attachments/messages/AttachmentsMessageRow', () => ({
    AttachmentsMessageRow: () => null,
}));

vi.mock('@/components/sessions/attachments/messages/AttachmentsInlineImages', () => ({
    AttachmentsInlineImages: () => null,
}));

vi.mock('@/components/sessions/media/SessionMediaInlineImages', () => ({
    SessionMediaInlineImages: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('MessageView timestamps', () => {
    beforeEach(() => {
        platformState.os = 'web';
        timestampDisplayMode = 'hover_web_hidden_mobile';
        copyButtonsVisible = false;
        vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('legacy locale string');
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => ({
            format: () => 'May 19, 2026, 4:30 PM',
        })) as unknown as typeof Intl.DateTimeFormat);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        standardCleanup();
    });

    it('does not render message timestamps by default before web hover actions are visible', async () => {
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'm1', localId: 'local-1', createdAt: 1, text: 'hello' }}
            />,
        );

        expect(screen.findAllByTestId('transcript-message-timestamp:m1')).toHaveLength(0);
    });

    it('projects eligible whole-message Actions through user, assistant, and structured MessageActionRows', async () => {
        vi.resetModules();
        const { MessageView } = await import('./MessageView');
        const {
            createPluginMessageActionHost,
            PluginMessageActionHostProvider,
        } = await import('./messageActions/PluginMessageActions');
        const action: PluginProjectionAction = {
            id: 'open-preview',
            title: 'Open preview',
            description: null,
            icon: null,
            scopes: ['message'],
            surfaces: ['ui'],
            placementBindings: ['rowAction'],
            inputHints: null,
            inputSchema: null,
            priority: null,
            dangerLevel: 'safe',
            confirmation: null,
            available: true,
        };
        const entry: PluginProjectionEntry = {
            pluginId: 'acme.preview',
            title: 'Preview',
            description: null,
            version: '1.0.0',
            enabled: true,
            generation: 7,
            generationLabel: '7',
            status: null,
            provenance: null,
            diagnostics: [],
            actions: [action],
            resources: [],
            editableSettingsGroups: [],
        };
        const actionSnapshot: PluginContributedActionCurrentSnapshot = {
            pluginProjectionById: { 'acme.preview': entry },
            host: {
                machineId: 'machine-1',
                serverId: 'server-1',
                expectedGeneration: 7,
                sessionId: 's1',
                isCurrent: () => true,
            },
        };
        const host = createPluginMessageActionHost({
            resolveCurrent: () => actionSnapshot,
            sessionId: 's1',
        });

        const rows = [
            {
                kind: 'user-text' as const,
                id: 'user-row',
                localId: 'local-user-row',
                createdAt: 1,
                text: 'user message',
            },
            {
                kind: 'agent-text' as const,
                id: 'assistant-row',
                localId: 'local-assistant-row',
                createdAt: 2,
                text: 'assistant message',
            },
            {
                kind: 'agent-text' as const,
                id: 'structured-row',
                localId: 'local-structured-row',
                createdAt: 3,
                text: '',
                structuredPresentation: createMessageStructuredPresentationV1({
                    owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                    snapshot: { kind: 'status', label: 'Report', value: 'Ready' },
                }),
            },
        ];

        for (const row of rows) {
            const screen = await renderScreen(
                <PluginMessageActionHostProvider host={host}>
                    <MessageView
                        sessionId="s1"
                        metadata={null}
                        message={{
                            ...row,
                            messageActionReference: {
                                v: 1,
                                sessionId: 's1',
                                messageId: row.id,
                                observedRevision: 'revision-1',
                            },
                        }}
                    />
                </PluginMessageActionHostProvider>,
            );

            expect(screen.findByTestId('plugin-message-action:acme.preview/open-preview')).toBeTruthy();
        }
    });

    it('exports transcript message views through React memo boundaries', async () => {
        vi.resetModules();
        const { MessageView, MessageViewWithSessionCommon } = await import('./MessageView');

        expect(typeof (MessageView as any).$$typeof).toBe('symbol');
        expect(String((MessageView as any).$$typeof)).toContain('react.memo');
        expect(typeof (MessageViewWithSessionCommon as any).$$typeof).toBe('symbol');
        expect(String((MessageViewWithSessionCommon as any).$$typeof)).toContain('react.memo');
    });

    it('renders message timestamps with web hover actions in the default mode', async () => {
        copyButtonsVisible = true;
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const userScreen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'u1', localId: 'local-u1', createdAt: 1, text: 'hello' }}
            />,
        );
        const agentScreen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'agent-text', id: 'a1', localId: 'local-a1', createdAt: 2, text: 'reply' }}
            />,
        );

        expect(userScreen.findByTestId('transcript-message-timestamp:u1')?.props.children).toBe('May 19, 2026, 4:30 PM');
        expect(agentScreen.findByTestId('transcript-message-timestamp:a1')?.props.children).toBe('May 19, 2026, 4:30 PM');
        expect(Intl.DateTimeFormat).toHaveBeenCalledWith(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    });

    it('renders always-visible web timestamps after hover action space', async () => {
        timestampDisplayMode = 'always';
        copyButtonsVisible = false;
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'always-u1', localId: 'local-u1', createdAt: 1, text: 'hello' }}
            />,
        );

        const timestamp = screen.findByTestId('transcript-message-timestamp:always-u1');
        const row = screen.findByTestId('transcript-message-actions-row:always-u1');
        const actionContainer = screen.findByTestId('transcript-message-actions:always-u1');

        expect(timestamp?.props.children).toBe('May 19, 2026, 4:30 PM');
        expect(row?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ flexDirection: 'row-reverse' })]));
        expect(actionContainer?.props.accessibilityElementsHidden).toBeUndefined();
        expect(flattenStyle(actionContainer?.props.style).pointerEvents).toBe('none');
    });

    it('does not render message timestamps in never mode even when actions are visible', async () => {
        timestampDisplayMode = 'never';
        copyButtonsVisible = true;
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'never-u1', localId: 'local-u1', createdAt: 1, text: 'hello' }}
            />,
        );

        expect(screen.findAllByTestId('transcript-message-timestamp:never-u1')).toHaveLength(0);
    });

    it('omits invalid message timestamps instead of throwing during render', async () => {
        timestampDisplayMode = 'always';
        vi.restoreAllMocks();
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'u1', localId: 'local-u1', createdAt: 1e100, text: 'hello' }}
            />,
        );

        expect(screen.findAllByTestId('transcript-message-timestamp:u1')).toHaveLength(0);
    });

    it('renders native message actions inline so text selection does not depend on long press', async () => {
        platformState.os = 'ios';
        timestampDisplayMode = 'hover_web_always_mobile';
        copyButtonsVisible = true;
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'native-u1', localId: 'local-u1', createdAt: 1, text: 'hello' }}
            />,
        );

        expect(screen.findByTestId('transcript-message-timestamp:native-u1')?.props.children).toBe('May 19, 2026, 4:30 PM');
        expect(screen.findByTestId('transcript-message-copy:native-u1')).toBeTruthy();
    });

    it('renders timestamps from parent-provided transcript session common', async () => {
        vi.resetModules();
        const { MessageViewWithSessionCommon } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'parent-common-u1', localId: 'local-u1', createdAt: 1, text: 'hello' }}
                messageDisplayCommon={{
                    sessionThinkingDisplayMode: 'inline',
                    sessionThinkingInlineChrome: 'plain',
                    sessionThinkingInlinePresentation: 'summary',
                    transcriptMessageTimestampDisplayMode: 'always',
                    transcriptMessageSelectionEnabled: false,
                    transcriptMessageSendToSessionEnabled: false,
                    transcriptStreamingMarkdownRenderingEnabled: false,
                    transcriptStreamingPartialOutputEnabled: true,
                    transcriptStreamingSettleDelayMs: 0,
                    transcriptStreamingSmoothingEnabled: false,
                    debugInformationEnabled: false,
                    workspacePath: null,
                }}
                forkCommon={{
                    executionRunsEnabled: false,
                    sessionForkSupportSource: null,
                    sessionReplayEnabled: false,
                    sessionReplayMaxSeedChars: 120_000,
                    sessionReplayStrategy: 'recent_messages',
                    sessionReplaySummaryRunnerV1: null,
                }}
                toolChromeCommon={{
                    toolViewTimelineChromeMode: 'cards',
                    transcriptToolCallsCollapsedPreviewCount: 1,
                    transcriptToolCallsGroupShowBackground: false,
                }}
                toolRouteCommon={{
                    messagesById: {},
                    reducerState: null,
                }}
            />,
        );

        expect(screen.findByTestId('transcript-message-timestamp:parent-common-u1')?.props.children).toBe('May 19, 2026, 4:30 PM');
    });
});
