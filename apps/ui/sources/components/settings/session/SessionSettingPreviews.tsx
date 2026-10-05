import * as React from 'react';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import { UserMessageBubble } from '@/components/sessions/transcript/UserMessageBubble';
import type { Theme } from '@/theme';
import { ToolCallsGroupViewWithSessionCommon } from '@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView';
import type {
    TranscriptForkCommon,
    TranscriptMessageDisplayCommon,
    TranscriptToolChromeCommon,
    TranscriptToolRouteCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import type { ToolViewDisplaySettings } from '@/components/tools/shell/views/toolViewDisplaySettings';
import { createAgentSelectionActionChip } from '@/components/sessions/agentInput/definitions/createAgentSelectionActionChip';
import { createPermissionActionChip } from '@/components/sessions/agentInput/definitions/createPermissionActionChip';
import { AgentInputFolderChip, type AgentInputFolderChipState } from '@/components/sessions/agentInput/definitions/AgentInputFolderChip';
import { AgentInputSubmitButton } from '@/components/sessions/agentInput/components/AgentInputSubmitButton';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from '@/components/ui/forms/multiTextInputTypography';

const PREVIEW_FOLDER_STATE: AgentInputFolderChipState = { kind: 'folder', path: '~/happier' };
import { createActionMenuTriggerChip } from '@/components/sessions/agentInput/definitions/createActionMenuTriggerChip';
import {
    AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE,
    AGENT_INPUT_ACTION_CHIP_STYLE,
    resolveAgentInputActionChipTextStyle,
    resolveAgentInputPanelStyle,
} from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { Text } from '@/components/ui/text/Text';
import type { AgentTextMessage, Message, ToolCallMessage, UserTextMessage } from "@happier-dev/session-core/messages";
import type { Settings } from '@/sync/domains/settings/settings';
import { getPermissionModeLabelForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { t } from '@/text';
import { resolveThinkingDisplayChoiceDelta, type ThinkingDisplayChoice } from '@/components/settings/session/thinkingDisplayChoice';

/**
 * Previews for the visual choices on the transcript and composer settings pages. Each tile renders
 * the real transcript rows (`MessageViewWithSessionCommon`, `ToolCallsGroupViewWithSessionCommon`)
 * and the real composer chips inside the real composer panel, at static props: sample messages
 * built here, the option under preview and fixed tool display settings in place of the session's
 * and account's settings, and a read-only interaction so no row offers an action. Nothing reads a
 * session or a display setting. The rows lay out at a normal
 * width and the tile shows them scaled down.
 */

const PREVIEW_SESSION_ID = 'settings-preview';
const CANVAS_WIDTH = 320;
const CANVAS_SCALE = 0.34;
const READ_ONLY_INTERACTION = { canSendMessages: false, canApprovePermissions: false } as const;
const PREVIEW_SOURCE = createReadOnlySessionTranscriptSource({ sessionId: PREVIEW_SESSION_ID, messages: [], metadata: null, agentState: null, reducerState: null });
const NOOP = () => {};

const FORK_COMMON: TranscriptForkCommon = {
    sessionReplayEnabled: false,
    sessionReplayMaxSeedChars: 0,
    sessionReplayStrategy: 'recent_messages',
    sessionReplaySummaryRunnerV1: null,
    executionRunsEnabled: false,
    agentSwitchingEnabled: false,
    sessionForkSupportSource: null,
};

const TOOL_ROUTE_COMMON: TranscriptToolRouteCommon = { messagesById: {}, reducerState: null };

type ThinkingDisplay = Pick<Settings, 'sessionThinkingDisplayMode' | 'sessionThinkingInlinePresentation' | 'sessionThinkingInlineChrome'>;
type ToolChromeMode = TranscriptToolChromeCommon['toolViewTimelineChromeMode'];

function messageDisplayCommon(thinking: ThinkingDisplay): TranscriptMessageDisplayCommon {
    return {
        ...thinking,
        transcriptMessageTimestampDisplayMode: 'never',
        transcriptMessageSelectionEnabled: false,
        transcriptMessageCopyActionEnabled: false,
        transcriptMessageForkActionEnabled: false,
        transcriptMessageRollbackActionEnabled: false,
        transcriptMessagePinActionEnabled: false,
        transcriptMessageSavePromptActionEnabled: false,
        transcriptMessageMakeRepeatableActionEnabled: false,
        transcriptMessagePluginActionsEnabled: false,
        transcriptMessageSendToSessionEnabled: false,
        transcriptStreamingMarkdownRenderingEnabled: true,
        transcriptStreamingPartialOutputEnabled: true,
        transcriptStreamingSettleDelayMs: 0,
        transcriptStreamingSmoothingEnabled: false,
        workspacePath: null,
        debugInformationEnabled: false,
    };
}

/** How a tool call reads in a preview: each style's own default detail level, rows collapsed. */
const PREVIEW_TOOL_DISPLAY_SETTINGS: ToolViewDisplaySettings = {
    toolViewDetailLevelDefault: 'default',
    toolViewDetailLevelDefaultLocalControl: 'title',
    toolViewDetailLevelByToolName: {},
    toolViewExpandedDetailLevelDefault: 'default',
    toolViewExpandedDetailLevelByToolName: {},
    toolViewTimelineFeedDefaultExpanded: false,
    toolViewTapAction: 'expand',
    permissionPromptSurface: 'composer',
};

function toolChromeCommon(mode: ToolChromeMode): TranscriptToolChromeCommon {
    return {
        toolViewTimelineChromeMode: mode,
        transcriptToolCallsCollapsedPreviewCount: 0,
        transcriptToolCallsGroupShowBackground: false,
        toolDisplaySettings: PREVIEW_TOOL_DISPLAY_SETTINGS,
    };
}

const DEFAULT_THINKING: ThinkingDisplay = {
    sessionThinkingDisplayMode: 'inline',
    sessionThinkingInlinePresentation: 'summary',
    sessionThinkingInlineChrome: 'plain',
};

function userMessage(): UserTextMessage {
    return { kind: 'user-text', id: 'preview-user', localId: null, createdAt: 0, text: t('settingsSessionPages.preview.userMessage') };
}

function agentMessage(): AgentTextMessage {
    return { kind: 'agent-text', id: 'preview-agent', localId: null, createdAt: 0, text: t('settingsSessionPages.preview.agentReply') };
}

function thinkingMessage(): AgentTextMessage {
    return { kind: 'agent-text', id: 'preview-thinking', localId: null, createdAt: 0, text: t('settingsSessionPages.preview.thinking'), isThinking: true };
}

function toolMessage(id: string, command: string): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 0,
        children: [],
        tool: {
            name: 'Bash',
            state: 'completed',
            input: { command },
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            description: null,
            result: '',
        },
    };
}

/** A normal-width stage for real rows, shown scaled down inside the tile. */
function PreviewStage(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <SessionTranscriptSourceProvider source={PREVIEW_SOURCE}>
        <View style={{ flex: 1, overflow: 'hidden' }} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            <View style={{ width: CANVAS_WIDTH, transform: [{ scale: CANVAS_SCALE }], transformOrigin: 'top left', paddingTop: 12 }}>
                {props.children}
            </View>
        </View>
        </SessionTranscriptSourceProvider>
    );
}

function TranscriptRow(props: Readonly<{ message: Message; thinking?: ThinkingDisplay; toolChrome?: ToolChromeMode }>) {
    const display = React.useMemo(() => messageDisplayCommon(props.thinking ?? DEFAULT_THINKING), [props.thinking]);
    const chrome = React.useMemo(() => toolChromeCommon(props.toolChrome ?? 'cards'), [props.toolChrome]);
    return (
        <MessageViewWithSessionCommon
            message={props.message}
            metadata={null}
            sessionId={PREVIEW_SESSION_ID}
            interaction={READ_ONLY_INTERACTION}
            forkCommon={FORK_COMMON}
            messageDisplayCommon={display}
            toolChromeCommon={chrome}
            toolRouteCommon={TOOL_ROUTE_COMMON}
        />
    );
}

export const TranscriptLayoutPreview = React.memo(function TranscriptLayoutPreview(props: Readonly<{ layout: 'linear' | 'turns' }>) {
    const tools = React.useMemo(() => [toolMessage('preview-tool-1', 'yarn test'), toolMessage('preview-tool-2', 'git diff')], []);
    const display = React.useMemo(() => messageDisplayCommon(DEFAULT_THINKING), []);
    const chrome = React.useMemo(() => toolChromeCommon('activity_feed'), []);
    return (
        <PreviewStage>
            <TranscriptRow message={userMessage()} />
            {props.layout === 'turns' ? (
                // Turns gather a turn's tool calls into one group, as the transcript does.
                <ToolCallsGroupViewWithSessionCommon
                    id="preview-group"
                    status="completed"
                    toolMessages={tools}
                    metadata={null}
                    sessionId={PREVIEW_SESSION_ID}
                    expanded={false}
                    setExpanded={NOOP}
                    interaction={READ_ONLY_INTERACTION}
                    forkCommon={FORK_COMMON}
                    messageDisplayCommon={display}
                    toolChromeCommon={chrome}
                    toolRouteCommon={TOOL_ROUTE_COMMON}
                />
            ) : (
                tools.map((tool) => <TranscriptRow key={tool.id} message={tool} toolChrome="activity_feed" />)
            )}
            <TranscriptRow message={agentMessage()} />
        </PreviewStage>
    );
});

export type ThinkingDisplayPreviewMode = ThinkingDisplayChoice;

/** The fields a thinking choice stores, from its one owner; a static preview still names a presentation. */
function thinkingFieldsForChoice(choice: ThinkingDisplayChoice): Omit<ThinkingDisplay, 'sessionThinkingInlineChrome'> {
    return { sessionThinkingInlinePresentation: 'summary', ...resolveThinkingDisplayChoiceDelta(choice) };
}

export const ThinkingDisplayPreview = React.memo(function ThinkingDisplayPreview(props: Readonly<{
    mode: ThinkingDisplayPreviewMode;
    /** The page's current thinking-card choice, so inline previews show the chrome the user has. */
    inlineChrome: Settings['sessionThinkingInlineChrome'];
}>) {
    const thinking = React.useMemo<ThinkingDisplay>(
        () => ({ ...thinkingFieldsForChoice(props.mode), sessionThinkingInlineChrome: props.inlineChrome }),
        [props.inlineChrome, props.mode],
    );
    return (
        <PreviewStage>
            <TranscriptRow message={userMessage()} />
            <TranscriptRow message={thinkingMessage()} thinking={thinking} />
            <TranscriptRow message={agentMessage()} />
        </PreviewStage>
    );
});

export const ToolStylePreview = React.memo(function ToolStylePreview(props: Readonly<{ style: ToolChromeMode }>) {
    const tools = React.useMemo(() => [
        toolMessage('preview-tool-1', 'yarn test'),
        toolMessage('preview-tool-2', 'git diff'),
        toolMessage('preview-tool-3', 'yarn lint'),
        toolMessage('preview-tool-4', 'git status'),
    ], []);
    return (
        <PreviewStage>
            {tools.map((tool) => <TranscriptRow key={tool.id} message={tool} toolChrome={props.style} />)}
        </PreviewStage>
    );
});

function readToolMessage(id: string, path: string): ToolCallMessage {
    return {
        kind: 'tool-call', id, localId: null, createdAt: 0, children: [],
        tool: { name: 'Read', state: 'completed', input: { file_path: path }, createdAt: 0, startedAt: 0, completedAt: 0, description: null, result: '' },
    };
}

function editToolMessage(id: string, path: string): ToolCallMessage {
    return {
        kind: 'tool-call', id, localId: null, createdAt: 0, children: [],
        tool: {
            name: 'Edit', state: 'completed', createdAt: 0, startedAt: 0, completedAt: 0, description: null, result: '',
            input: { file_path: path, old_string: 'retryTimer = setTimeout(retry, delay);', new_string: 'clearTimeout(retryTimer);\nretryTimer = setTimeout(retry, delay);' },
        },
    };
}

/**
 * A two-turn session at full size for a larger preview stage (Personalize Happier): the same real
 * rows and the same sample as the tiles above, under the transcript choices being previewed. Static
 * props only — no session, subscription or RPC.
 */
export const SessionTranscriptSample = React.memo(function SessionTranscriptSample(props: Readonly<{
    layout: 'linear' | 'turns';
    thinking: ThinkingDisplayPreviewMode;
    toolChrome: ToolChromeMode;
    toolDetail: ToolViewDisplaySettings['toolViewDetailLevelDefault'];
    width: number;
}>) {
    const thinking = React.useMemo<ThinkingDisplay>(() => ({ ...thinkingFieldsForChoice(props.thinking), sessionThinkingInlineChrome: 'plain' }), [props.thinking]);
    const display = React.useMemo(() => messageDisplayCommon(thinking), [thinking]);
    const chrome = React.useMemo<TranscriptToolChromeCommon>(() => ({
        ...toolChromeCommon(props.toolChrome),
        toolDisplaySettings: { ...PREVIEW_TOOL_DISPLAY_SETTINGS, toolViewDetailLevelDefault: props.toolDetail },
    }), [props.toolChrome, props.toolDetail]);
    const tools = React.useMemo(() => [
        readToolMessage('sample-read', 'relay/reconnect.ts'),
        editToolMessage('sample-edit', 'relay/reconnect.ts'),
        toolMessage('sample-test', 'yarn test reconnect'),
    ], []);
    const row = (message: Message) => (
        <MessageViewWithSessionCommon
            key={message.id}
            message={message}
            metadata={null}
            sessionId={PREVIEW_SESSION_ID}
            interaction={READ_ONLY_INTERACTION}
            forkCommon={FORK_COMMON}
            messageDisplayCommon={display}
            toolChromeCommon={chrome}
            toolRouteCommon={TOOL_ROUTE_COMMON}
        />
    );
    return (
        <SessionTranscriptSourceProvider source={PREVIEW_SOURCE}>
            <View style={{ width: props.width }} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                {row(userMessage())}
                {row(thinkingMessage())}
                {props.layout === 'turns' ? (
                    <ToolCallsGroupViewWithSessionCommon
                        id="sample-group"
                        status="completed"
                        toolMessages={tools}
                        metadata={null}
                        sessionId={PREVIEW_SESSION_ID}
                        expanded
                        setExpanded={NOOP}
                        interaction={READ_ONLY_INTERACTION}
                        forkCommon={FORK_COMMON}
                        messageDisplayCommon={display}
                        toolChromeCommon={chrome}
                        toolRouteCommon={TOOL_ROUTE_COMMON}
                    />
                ) : tools.map(row)}
                {row(agentMessage())}
            </View>
        </SessionTranscriptSourceProvider>
    );
});

type ChipLabels = 'all' | 'core' | 'none';

/** The composer panel with the real action chips, as `AgentInput` lays them out. */
export function SessionComposerSample(props: Readonly<{ layout: 'wrap' | 'scroll' | 'collapsed'; labels: ChipLabels; width?: number }>) {
    const { theme } = useUnistyles();
    const tint = theme.colors.composer.chipTint;
    const textStyle = React.useMemo(() => resolveAgentInputActionChipTextStyle(theme), [theme]);
    const panelStyle = React.useMemo(() => resolveAgentInputPanelStyle(theme), [theme]);
    const coreChipStyle = React.useCallback(() => (
        props.labels === 'none' ? [AGENT_INPUT_ACTION_CHIP_STYLE, AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE] : AGENT_INPUT_ACTION_CHIP_STYLE
    ), [props.labels]);
    // Auto keeps labels on the core chips and drops them from the extra ones, as `AgentInput` does.
    const extraChipStyle = React.useCallback(() => (
        props.labels === 'all' ? AGENT_INPUT_ACTION_CHIP_STYLE : [AGENT_INPUT_ACTION_CHIP_STYLE, AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE]
    ), [props.labels]);
    const anchor = React.useRef<View | null>(null);
    const chips = props.layout === 'collapsed'
        ? [
            createActionMenuTriggerChip({ anchorRef: anchor, tint, showLabel: props.labels !== 'none', chipStyle: coreChipStyle, textStyle, onPress: NOOP }),
        ]
        : [
            createAgentSelectionActionChip({ anchorRef: anchor, agentId: 'claude', tint, showLabel: props.labels !== 'none', label: 'Claude', chipStyle: coreChipStyle, textStyle, onPress: NOOP }),
            createPermissionActionChip({ anchorRef: anchor, tint, showLabel: props.labels !== 'none', label: getPermissionModeLabelForAgentType('claude', 'default'), chipStyle: coreChipStyle, textStyle, onPress: NOOP }),
            <AgentInputFolderChip key="path" anchorRef={anchor} state={PREVIEW_FOLDER_STATE} tint={tint} chipStyle={extraChipStyle} textStyle={textStyle} onPress={NOOP} />,
            createActionMenuTriggerChip({ anchorRef: anchor, tint, showLabel: props.labels === 'all', chipStyle: extraChipStyle, textStyle, onPress: NOOP }),
        ];
    return (
        <View style={{ flex: props.width === undefined ? 1 : undefined, overflow: 'hidden', justifyContent: 'flex-end' }} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            <View style={{ width: props.width ?? CANVAS_WIDTH, transform: [{ scale: props.width === undefined ? CANVAS_SCALE : 1 }], transformOrigin: 'bottom left', padding: 10 }}>
                <View style={panelStyle}>
                    <Text style={{ paddingHorizontal: 8, paddingVertical: 10, color: theme.colors.input.placeholder, fontSize: 15 }}>
                        {t('session.inputPlaceholder')}
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: props.layout === 'scroll' ? 'nowrap' : 'wrap', columnGap: 6, rowGap: 2 }}>
                        {chips}
                    </View>
                </View>
            </View>
        </View>
    );
}

export const ComposerActionBarPreview = React.memo(function ComposerActionBarPreview(props: Readonly<{
    layout: 'auto' | 'wrap' | 'scroll' | 'collapsed';
}>) {
    // Auto wraps on wide screens (where this page is usually read) and scrolls on phones.
    return <SessionComposerSample layout={props.layout === 'auto' ? 'wrap' : props.layout} labels="all" />;
});

export const ComposerChipDensityPreview = React.memo(function ComposerChipDensityPreview(props: Readonly<{
    density: 'auto' | 'labels' | 'icons';
}>) {
    return <SessionComposerSample layout="wrap" labels={props.density === 'labels' ? 'all' : props.density === 'icons' ? 'none' : 'core'} />;
});

const EMBEDDED_CHAT_CANVAS_WIDTH = 340;
const EMBEDDED_CHAT_HEIGHT = 168;

/**
 * The preset/corner miniature: the live bubble and composer pieces at static appearance props.
 * The empty-state illustration uses the isolated live preview route instead.
 */
export const EmbeddedChatPreview = React.memo(function EmbeddedChatPreview(props: Readonly<{ appearance?: Theme }>) {
    const { theme: currentTheme } = useUnistyles();
    const theme = props.appearance ?? currentTheme;
    const scale = CANVAS_SCALE;
    const tint = theme.colors.composer.chipTint;
    const textStyle = React.useMemo(() => resolveAgentInputActionChipTextStyle(theme), [theme]);
    const panelStyle = React.useMemo(() => resolveAgentInputPanelStyle(theme), [theme]);
    const anchor = React.useRef<View | null>(null);
    return (
        <SessionTranscriptSourceProvider source={PREVIEW_SOURCE}>
            <View
                testID="embedded-chat-preview"
                style={{
                    width: EMBEDDED_CHAT_CANVAS_WIDTH * scale,
                    height: EMBEDDED_CHAT_HEIGHT * scale,
                    overflow: 'hidden',
                    justifyContent: 'flex-end',
                    borderRadius: theme.borderRadius.lg,
                    borderWidth: 0,
                    borderColor: theme.colors.border.default,
                    backgroundColor: theme.colors.background.canvas,
                }}
                pointerEvents="none"
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
            >
                <View style={{ width: EMBEDDED_CHAT_CANVAS_WIDTH, transform: [{ scale }], transformOrigin: 'bottom left', padding: 10, gap: 10 }}>
                    <View style={{ alignSelf: 'flex-end', maxWidth: '100%' }}>
                        <UserMessageBubble theme={theme}>
                            <Text style={{ color: theme.colors.message.user.foreground }}>{t('settingsSessionPages.preview.userMessage')}</Text>
                        </UserMessageBubble>
                    </View>
                    <View style={panelStyle}>
                        <Text style={{ paddingHorizontal: 8, paddingVertical: 10, color: theme.colors.input.placeholder, fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE }}>
                            {t('session.inputPlaceholder')}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                            {createAgentSelectionActionChip({ anchorRef: anchor, agentId: 'claude', tint, showLabel: true, label: 'Claude', chipStyle: () => AGENT_INPUT_ACTION_CHIP_STYLE, textStyle, onPress: NOOP })}
                            <AgentInputSubmitButton
                                appearance={props.appearance}
                                testID="embedded-chat-preview-send"
                                disabled
                                hasSendableContent={false}
                                dictationStatus="idle"
                                onSend={NOOP}
                            />
                        </View>
                    </View>
                </View>
            </View>
        </SessionTranscriptSourceProvider>
    );
});
