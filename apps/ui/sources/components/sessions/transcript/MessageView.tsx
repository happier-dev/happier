import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from "react";
import { View, Pressable, Platform } from 'react-native';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { useTranscriptFindActive, useTranscriptFindRow } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@happier-dev/session-core/messages";
import { Metadata } from '@happier-dev/session-core/state';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { useLayoutMaxWidthStyle } from "@/components/ui/layout/layout";
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { buildMessageRouteId, resolveMessageRouteIdForDisplay } from "@happier-dev/session-core/messages";
import { readUnsupportedContentMeta } from "@happier-dev/session-core/messages";
import {
  resolveUnsupportedContentPresentation,
  type UnsupportedContentPresentation,
} from "@happier-dev/session-core/messages";
import type { Option, OptionLongPressHandler } from '@/components/markdown/MarkdownView';
import { isCommittedMessageDiscarded } from "@/utils/sessions/discardedCommittedMessages";
import { shouldShowTranscriptRowActions, shouldShowTranscriptRowPinAction } from '@/components/sessions/transcript/transcriptRowActionVisibility';
import { MessageSelectionCheckbox } from '@/components/sessions/transcript/messageSelection/MessageSelectionCheckbox';
import { useOptionalTranscriptSelectionRow } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import {
  resolveSelectableMessageText,
} from '@/components/sessions/transcript/messageSelection/resolveSelectableMessageText';
import { prepareTranscriptMessageBody, readTranscriptAttachmentsMeta, resolveTranscriptMessageDisplayText } from '@/components/sessions/transcript/messageDisplayText';
import { renderStructuredMessage } from '@/components/sessions/transcript/structured/StructuredMessageBlock';
import type { StructuredMessageRendererParams } from '@/components/sessions/transcript/structured/structuredMessageRegistry';
import { buildSessionFileDeepLink } from '@/utils/url/sessionFileDeepLink';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { useMessageStructuredReferences } from '@/components/sessions/transcript/references/messageStructuredReferences';
import { StructuredReferencesRow } from '@/components/sessions/transcript/references/StructuredReferencesRow';
import { ComposerAttachmentFallbackRow } from '@/components/sessions/transcript/composerAttachments/ComposerAttachmentFallbackRow';
import { useMessageComposerAttachments } from '@/components/sessions/transcript/composerAttachments/messageComposerAttachments';
import { useTranscriptMotion } from '@/components/sessions/transcript/motion/TranscriptMotionContext';
import { ThinkingTimelineRow } from '@/components/sessions/transcript/thinking/ThinkingTimelineRow';
import { TranscriptEventRow } from '@/components/sessions/transcript/events/TranscriptEventRow';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import { parseHappierMetaEnvelope } from '@/components/sessions/transcript/structured/happierMetaEnvelope';
import { AttachmentsMessageRow } from '@/components/sessions/attachments/messages/AttachmentsMessageRow';
import { AttachmentsInlineImages } from '@/components/sessions/attachments/messages/AttachmentsInlineImages';
import { parseSessionMediaMessageMeta } from '@/sync/domains/session/media/sessionMediaMessageMeta';
import { SessionMediaInlineImages } from '@/components/sessions/media/SessionMediaInlineImages';
import { resolveSessionMediaInlineRenderableImageMimeType } from '@/components/sessions/media/presentation';
import { readSessionMessageProvenance } from '@happier-dev/protocol';
import type { TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import { CommittedMessageActions } from '@/components/sessions/transcript/messageActions/CommittedMessageActions';
import { RowActionRevealSlot } from '@/components/sessions/transcript/messageActions/RowActionRevealSlot';
import { readCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { resolveMessagePinAvailability } from '@/components/sessions/transcript/messageActions/resolveMessagePinAvailability';
import type { PersistedSessionMessagePinV1 } from "@happier-dev/session-core/pins";
import { resolveToolRowPinAction } from '@/components/sessions/transcript/toolCalls/ToolCallPinAction';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useStreamingTextSmoothing } from '@/components/sessions/transcript/streaming/useStreamingTextSmoothing';
import { readStreamSegmentMetaV1 } from "@happier-dev/session-core/reducer";
import { resolveTranscriptMessageServerId } from '@/components/sessions/transcript/source/resolveTranscriptMessageServerId';
import { resolveTranscriptMarkdownFileLink } from '@/components/sessions/transcript/resolveTranscriptMarkdownFileLink';
import {
  deriveTranscriptForkCommonForInteraction,
  type TranscriptForkCommon,
  type TranscriptMessageDisplayCommon,
  type TranscriptToolChromeCommon,
  type TranscriptToolRouteCommon,
  useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { TranscriptJumpAttention } from '@/components/sessions/transcript/navigation/TranscriptJumpHighlightOverlay';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { UserMessageBubble } from './UserMessageBubble';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { isRecoveredHistoryTranscriptObservation } from "@happier-dev/session-core/messages";
import type { TranscriptEventEmphasis } from '@/components/sessions/transcript/events/transcriptEventEmphasis';
import { Icon } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { SessionMessageAccountByline } from './SessionMessageAccountByline';
import type { ToolViewDisplaySettings } from '@/components/tools/shell/views/toolViewDisplaySettings';
import { TranscriptTurnChangesCard } from '@/components/sessions/files/turnChanges/TranscriptTurnChangesCard';
import { deriveToolMessageDisplay } from '@/components/sessions/transcript/toolCalls/deriveToolMessageDisplay';

const TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_TOP = 0;
// The jump-landing ring inherits the radius of the element it paints, so each
// archetype hands its own corner radius to the shared attention surface.
const TRANSCRIPT_MESSAGE_HIGHLIGHT_RADIUS = 12;
const TRANSCRIPT_AGENT_BLOCK_HIGHLIGHT_RADIUS = 16;
const TRANSCRIPT_EVENT_ROW_HIGHLIGHT_RADIUS = 10;
const TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_RIGHT = 0;
const TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_Z_INDEX = 2;

function shouldEnableFallbackTextNativeSelection(platformOS: typeof Platform.OS): boolean {
  return platformOS !== 'ios';
}

function resolveMessageUnsupportedContentPresentation(
  message: Message,
  debugInformationEnabled: boolean,
): UnsupportedContentPresentation | null {
  const kind = readUnsupportedContentMeta(message.meta);
  return kind ? resolveUnsupportedContentPresentation({ kind, debugInformationEnabled }) : null;
}

function shouldHideVoiceAgentTurnMessage(message: Message): boolean {
    if (message.kind !== 'user-text' && message.kind !== 'agent-text') return false;
    if (message.kind === 'user-text' && message.displayText !== undefined) return false;
    const prepared = prepareTranscriptMessageBody(message);
    return prepared.isVoiceAgentTurn && (prepared.text == null || prepared.text.trim().length === 0);
}

function formatTranscriptMessageTimestamp(createdAt: number): string | null {
  if (!Number.isFinite(createdAt) || createdAt < 0) return null;
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return formatWithCachedDateTimeFormatter(date, undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function RecoveredHistoryIndicator(props: Readonly<{ message: Message }>) {
  if (!isRecoveredHistoryTranscriptObservation(props.message)) return null;
  const label = t('message.recoveredHistory');
  const sourceTimestamp = props.message.sourceCreatedAt === undefined
    ? null
    : formatTranscriptMessageTimestamp(props.message.sourceCreatedAt);
  const accessibleText = sourceTimestamp ? `${label} · ${sourceTimestamp}` : label;
  return (
    <Text
      testID={`transcript-recovered-history:${props.message.id}`}
      accessibilityRole="text"
      accessibilityLabel={accessibleText}
      style={styles.recoveredHistoryIndicator}
    >
      {accessibleText}
    </Text>
  );
}

/**
 * The descriptive byline for one durable plugin-mediated message.
 *
 * `SessionMessageProvenanceV1` already carries the external sender and the
 * content provenance the mediating plugin stamped at `session.send`, so this
 * reads them rather than adding a plugin-specific byline: every plugin that
 * mediates an external conversation gets the same descriptive line.
 *
 * `forwarded` is not decoration. It changes WHO authored the message, so the
 * plain "From <sender>" wording would be a false statement about authorship.
 */
function readPluginMessageAttributionLabel(
  provenance: Readonly<{
    pluginId: string;
    externalActor?: Readonly<{ kind: 'human' | 'bot'; displayNameSnapshot?: string }>;
    contentProvenance?: 'original' | 'forwarded' | 'viaBot';
  }>,
): string {
  const externalActor = provenance.externalActor;
  if (!externalActor) {
    return t('message.pluginAttribution', { pluginId: provenance.pluginId });
  }
  const sender = externalActor.displayNameSnapshot
    ?? (externalActor.kind === 'bot'
      ? t('message.pluginAttributionExternalBot')
      : t('message.pluginAttributionExternalSender'));
  return provenance.contentProvenance === 'forwarded'
    ? t('message.pluginAttributionExternalForwarded', { sender, pluginId: provenance.pluginId })
    : t('message.pluginAttributionExternal', { sender, pluginId: provenance.pluginId });
}

function MessageProvenanceAttributionLabel(props: Readonly<{ testID: string; label: string }>) {
  return (
    <Text
      testID={props.testID}
      accessibilityRole="text"
      accessibilityLabel={props.label}
      numberOfLines={1}
      ellipsizeMode="tail"
      style={styles.messageProvenanceAttribution}
    >
      {props.label}
    </Text>
  );
}

function SessionMessageProvenanceAttribution(props: Readonly<{
  messageId: string;
  sourceSessionId: string;
  serverId?: string | null;
}>) {
  // Only Session-produced messages subscribe, and only to the fields that can
  // change the source title. The transcript Home qualifies the source identity.
  const source = useSessionDisplayNameSource(props.sourceSessionId, props.serverId);
  const sourceName = source ? getSessionName(source, props.serverId) : t('message.provenanceSession');
  return (
    <MessageProvenanceAttributionLabel
      testID={`transcript-provenance-attribution:${props.messageId}`}
      label={t('message.provenanceFrom', { source: sourceName })}
    />
  );
}

function MessageProvenanceAttribution(props: Readonly<{ message: Message; serverId?: string | null }>) {
  const provenance = React.useMemo(() => props.message.kind === 'user-text'
    ? readSessionMessageProvenance(props.message.meta)
    : null, [props.message]);
  // Authenticated Account actors and descriptive producer provenance are
  // independent: producer metadata never invents or suppresses a human actor.
  if (!provenance || provenance.kind === 'host') return null;
  if (provenance.kind === 'happierSession') {
    return (
      <SessionMessageProvenanceAttribution
        messageId={props.message.id}
        sourceSessionId={provenance.sourceSessionId}
        serverId={props.serverId}
      />
    );
  }
  const label = provenance.kind === 'pluginSession'
    ? readPluginMessageAttributionLabel(provenance)
    : t('message.provenanceFrom', {
      source: provenance.kind === 'automation' ? t('message.provenanceAutomation') : t('message.provenanceWorkflow'),
    });
  return (
    <MessageProvenanceAttributionLabel
      testID={provenance.kind === 'pluginSession'
        ? `transcript-plugin-attribution:${props.message.id}`
        : `transcript-provenance-attribution:${props.message.id}`}
      label={label}
    />
  );
}

type TranscriptMessageTimestampDisplayMode = TranscriptMessageDisplayCommon['transcriptMessageTimestampDisplayMode'];
type SessionMessagePinToggleHandler = (pin: PersistedSessionMessagePinV1) => void;

function resolveTranscriptMessageSeq(message: Message): number | null {
  if (typeof message.seq !== 'number' || !Number.isFinite(message.seq)) return null;
  const normalized = Math.trunc(message.seq);
  return normalized >= 0 ? normalized : null;
}

function resolveTranscriptMessageBlockIndex(message: Message): number | null {
  if (typeof message.transcriptBlockIndex !== 'number' || !Number.isFinite(message.transcriptBlockIndex)) return null;
  const normalized = Math.trunc(message.transcriptBlockIndex);
  return normalized >= 0 ? normalized : null;
}

function buildMessageMarkdownRenderCacheKey(messageId: string, revision: number | null | undefined): string {
  const normalizedRevision = typeof revision === 'number' && Number.isFinite(revision)
    ? Math.trunc(revision)
    : 'legacy';
  return `${messageId}:${normalizedRevision}`;
}

function resolveMessageTimestampPresentation(input: {
  displayMode: TranscriptMessageTimestampDisplayMode;
  isWeb: boolean;
  showActions: boolean;
}): { showTimestamp: boolean; invertTimestampAndActions: boolean } {
  switch (input.displayMode) {
    case 'always':
      return { showTimestamp: true, invertTimestampAndActions: input.isWeb };
    case 'hover_web_always_mobile':
      return { showTimestamp: input.isWeb ? input.showActions : true, invertTimestampAndActions: false };
    case 'never':
      return { showTimestamp: false, invertTimestampAndActions: false };
    case 'hover_web_hidden_mobile':
    default:
      return { showTimestamp: input.isWeb ? input.showActions : false, invertTimestampAndActions: false };
  }
}

type SessionFileDeepLinkParams = Parameters<typeof buildSessionFileDeepLink>[0];
type SessionFileDeepLinkNavigate = ((href: string) => void) | null;

function pushSessionFileDeepLink(
  navigate: SessionFileDeepLinkNavigate,
  params: SessionFileDeepLinkParams,
): void {
  const href = buildSessionFileDeepLink(params);
  navigate?.(href);
}

function useStructuredMessageJumpHandler(
  sessionId: string,
  serverId: string | null | undefined,
  enabled: boolean,
): StructuredMessageRendererParams['onJumpToAnchor'] {
  const transcriptSource = useSessionTranscriptSource();
  const navigateRef = React.useRef(transcriptSource.navigate);
  React.useLayoutEffect(() => {
    navigateRef.current = transcriptSource.navigate;
  }, [transcriptSource.navigate]);

  const handler = React.useCallback((target: Parameters<NonNullable<StructuredMessageRendererParams['onJumpToAnchor']>>[0]) => {
    pushSessionFileDeepLink(navigateRef.current, {
      sessionId,
      ...(serverId ? { serverId } : {}),
      filePath: target.filePath,
      source: target.source,
      anchor: target.anchor,
    });
  }, [serverId, sessionId]);
  return enabled && transcriptSource.navigate !== null ? handler : undefined;
}

type MessageViewProps = {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  serverId?: string | null;
  layoutContext?: 'transcript' | 'tool_calls_group';
  forcePermissionPromptsInTranscript?: boolean;
  approvalRequests?: readonly OpenApprovalArtifactForSession[];
  activeThinkingMessageId?: string | null;
  thinkingExpanded?: boolean;
  onThinkingExpandedChange?: (next: boolean) => void;
  getMessageById?: (id: string) => Message | null;
  rollbackAction?: TranscriptRollbackAction | null;
  messagePins?: readonly PersistedSessionMessagePinV1[];
  messageRevision?: number | null;
  onToggleMessagePin?: SessionMessagePinToggleHandler;
  onToggleToolPin?: SessionMessagePinToggleHandler;
  historical?: boolean;
  eventEmphasis?: TranscriptEventEmphasis;
  /** On the worker update that opens a context-only wake: how many updates woke the session. */
  hostWakeCount?: number;
  interaction?: TranscriptInteraction;
};

export const MessageView = React.memo(function MessageView(props: MessageViewProps) {
  const transcriptSessionCommon = useTranscriptSessionCommon();
  // Subscription width: this is a per-row hook, so a whole-record subscription made every
  // mounted row re-render on turn-lifecycle churn. `presence` was passed but
  // `deriveTranscriptInteractionFromSession` never reads it, so the narrow source drops it.
  const transcriptSource = useSessionTranscriptSource();
  const sessionInteraction = transcriptSource.useInteraction();
  return (
    <MessageViewWithSessionCommon
      {...props}
      interaction={props.interaction ?? sessionInteraction}
      forkCommon={transcriptSessionCommon.fork}
      messageDisplayCommon={transcriptSessionCommon.messageDisplay}
      toolChromeCommon={transcriptSessionCommon.toolChrome}
      toolRouteCommon={transcriptSessionCommon.toolRoute}
    />
  );
});

export const MessageViewWithSessionCommon = React.memo(function MessageViewWithSessionCommon(props: MessageViewProps & {
  forkCommon: TranscriptForkCommon;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
  toolChromeCommon: TranscriptToolChromeCommon;
  toolRouteCommon: TranscriptToolRouteCommon;
}) {
  const transcriptSource = useSessionTranscriptSource();
  const sourceInteraction = transcriptSource.useInteraction();
  const interaction = props.interaction ?? sourceInteraction;
  const canFork = interaction.canFork === true;
  const committedCanForkRef = React.useRef(canFork);
  React.useLayoutEffect(() => {
    committedCanForkRef.current = canFork;
  }, [canFork]);
  const isForkAllowed = React.useCallback(() => committedCanForkRef.current, []);
  const forkCommon = React.useMemo(
    () => deriveTranscriptForkCommonForInteraction(props.forkCommon, interaction),
    [interaction, props.forkCommon],
  );
  // Read at render time: the row stylesheet evaluates once, so a baked-in
  // `layout.maxWidth` would pin the transcript to whatever content-width mode was
  // active at first evaluation.
  const messageContentMaxWidthStyle = useLayoutMaxWidthStyle();
  const messageContentStyle = React.useMemo(
    () => [styles.messageContent, messageContentMaxWidthStyle],
    [messageContentMaxWidthStyle],
  );
  if (shouldHideVoiceAgentTurnMessage(props.message)) return null;
  // Placeholders for content we could not render are dropped here rather than inside the message
  // blocks, so toggling developer diagnostics never changes the hook order of a mounted row.
  if (resolveMessageUnsupportedContentPresentation(
    props.message,
    props.messageDisplayCommon.debugInformationEnabled,
  ) === 'hidden') return null;
  return (
    <View style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
      <View style={messageContentStyle}>
        <RecoveredHistoryIndicator message={props.message} />
        {props.message.kind === 'user-text' && (
          <SessionMessageAccountByline
            messageId={props.message.id}
            actor={props.message.accountActor}
            viewerScope={props.messageDisplayCommon.accountActorViewerScope ?? null}
            hasOtherNamedCollaborator={props.messageDisplayCommon.hasOtherNamedCollaborator === true}
          />
        )}
        <MessageProvenanceAttribution
          message={props.message}
          serverId={resolveTranscriptMessageServerId(props.sessionId, props.serverId, props.forkCommon.sessionForkSupportSource?.serverId)}
        />
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          layoutContext={props.layoutContext ?? 'transcript'}
          forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
          approvalRequests={props.approvalRequests}
          activeThinkingMessageId={props.activeThinkingMessageId ?? null}
          thinkingExpanded={props.thinkingExpanded}
          onThinkingExpandedChange={props.onThinkingExpandedChange}
          getMessageById={props.getMessageById}
          rollbackAction={props.rollbackAction}
          messagePins={props.messagePins}
          messageRevision={props.messageRevision}
          onToggleMessagePin={props.onToggleMessagePin}
          onToggleToolPin={props.onToggleToolPin}
          historical={props.historical}
          eventEmphasis={props.eventEmphasis}
          hostWakeCount={props.hostWakeCount}
          interaction={interaction}
          canFork={canFork}
          forkCommon={forkCommon}
          isForkAllowed={isForkAllowed}
          messageDisplayCommon={props.messageDisplayCommon}
          toolChromeCommon={props.toolChromeCommon}
          toolRouteCommon={props.toolRouteCommon}
        />
      </View>
    </View>
  );
});

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  serverId?: string | null;
  layoutContext: 'transcript' | 'tool_calls_group';
  forcePermissionPromptsInTranscript?: boolean;
  approvalRequests?: readonly OpenApprovalArtifactForSession[];
  activeThinkingMessageId: string | null;
  thinkingExpanded?: boolean;
  onThinkingExpandedChange?: (next: boolean) => void;
  getMessageById?: (id: string) => Message | null;
  interaction: TranscriptInteraction;
  canFork: boolean;
  rollbackAction?: TranscriptRollbackAction | null;
  messagePins?: readonly PersistedSessionMessagePinV1[];
  messageRevision?: number | null;
  onToggleMessagePin?: SessionMessagePinToggleHandler;
  onToggleToolPin?: SessionMessagePinToggleHandler;
  historical?: boolean;
  eventEmphasis?: TranscriptEventEmphasis;
  hostWakeCount?: number;
  forkCommon: TranscriptForkCommon;
  isForkAllowed: () => boolean;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
  toolChromeCommon: TranscriptToolChromeCommon;
  toolRouteCommon: TranscriptToolRouteCommon;
}): React.ReactElement | null {
  const transcriptSource = useSessionTranscriptSource();
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          serverId={props.toolChromeCommon.serverId}
          interaction={props.interaction}
          canSendMessages={props.interaction.canSendMessages === true}
          canOpenFiles={props.interaction.canOpenFiles === true}
          canPreviewMedia={props.interaction.canPreviewMedia === true}
          canFork={props.canFork}
          rollbackAction={props.rollbackAction}
          messagePins={props.messagePins}
          messageRevision={props.messageRevision}
          onToggleMessagePin={props.onToggleMessagePin}
          historical={props.historical}
          forkCommon={props.forkCommon}
          isForkAllowed={props.isForkAllowed}
          messageDisplayCommon={props.messageDisplayCommon}
        />
      );

    case 'agent-text':
      return (
        <AgentTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          serverId={props.toolChromeCommon.serverId}
          interaction={props.interaction}
          canSendMessages={props.interaction.canSendMessages === true}
          canOpenFiles={props.interaction.canOpenFiles === true}
          canPreviewMedia={props.interaction.canPreviewMedia === true}
          canFork={props.canFork}
          activeThinkingMessageId={props.activeThinkingMessageId}
          thinkingExpanded={props.thinkingExpanded}
          onThinkingExpandedChange={props.onThinkingExpandedChange}
          rollbackAction={props.rollbackAction}
          messagePins={props.messagePins}
          messageRevision={props.messageRevision}
          onToggleMessagePin={props.onToggleMessagePin}
          historical={props.historical}
          forkCommon={props.forkCommon}
          isForkAllowed={props.isForkAllowed}
          messageDisplayCommon={props.messageDisplayCommon}
          toolDisplaySettings={props.toolChromeCommon.toolDisplaySettings}
        />
      );

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        layoutContext={props.layoutContext}
        forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
        approvalRequests={props.approvalRequests}
        activeThinkingMessageId={props.activeThinkingMessageId}
        getMessageById={props.getMessageById}
        interaction={props.interaction}
        rollbackAction={props.rollbackAction}
        historical={props.historical}
        messagePins={props.messagePins}
        onToggleToolPin={props.onToggleToolPin}
        messageDisplayCommon={props.messageDisplayCommon}
        toolChromeCommon={props.toolChromeCommon}
        toolRouteCommon={props.toolRouteCommon}
      />;

    case 'agent-event':
      return (
        <TranscriptJumpAttention
          sessionAddress={transcriptSource.sessionId === props.sessionId ? normalizeSessionAddress(transcriptSource.serverId, props.sessionId) : null}
          routeMessageId={buildMessageRouteId(props.message)}
          seq={resolveTranscriptMessageSeq(props.message)}
          radius={TRANSCRIPT_EVENT_ROW_HIGHLIGHT_RADIUS}
          style={styles.eventHighlightSurface}
        >
          <TranscriptEventRow
            event={props.message.event}
            localId={props.message.localId}
            sessionId={props.sessionId}
            serverId={props.serverId}
            emphasis={props.eventEmphasis}
            hostWakeCount={props.hostWakeCount}
            createdAt={props.message.createdAt}
            navigationEnabled={props.interaction.permissionDisabledReason !== 'public' && transcriptSource.navigate !== null}
          />
        </TranscriptJumpAttention>
      );


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function UserTextBlock(props: {
  message: UserTextMessage;
  metadata: Metadata | null;
  sessionId: string;
  serverId?: string | null;
  interaction: TranscriptInteraction;
  canSendMessages: boolean;
  canOpenFiles: boolean;
  canPreviewMedia: boolean;
  canFork: boolean;
  rollbackAction?: TranscriptRollbackAction | null;
  messagePins?: readonly PersistedSessionMessagePinV1[];
  messageRevision?: number | null;
  onToggleMessagePin?: SessionMessagePinToggleHandler;
  historical?: boolean;
  forkCommon: TranscriptForkCommon;
  isForkAllowed: () => boolean;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
}) {
  const find = useTranscriptFindRow(props.message.id);
  const findActive = useTranscriptFindActive();
  const findSourceRanges = find?.blocks.find((block) => block.id === 'text')?.sourceRanges;
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const [isActionRowFocused, setIsActionRowFocused] = React.useState(false);
  const handleActionsFocus = React.useCallback(() => setIsActionRowFocused(true), []);
  const handleActionsBlur = React.useCallback(() => setIsActionRowFocused(false), []);
  const isWeb = Platform.OS === 'web';
	  const transcriptSource = useSessionTranscriptSource();
  const sourceCanSendMessages = transcriptSource.useInteraction().canSendMessages;
	  const isDiscarded = isCommittedMessageDiscarded(props.metadata, props.message.localId);
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId, props.serverId, props.canOpenFiles);

  const messageDisplay = React.useMemo(() => resolveTranscriptMessageDisplayText(props.message, {
    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
  }), [props.message, props.messageDisplayCommon.debugInformationEnabled]);
  const isVoiceAgentTurn = messageDisplay.isVoiceAgentTurn;

  const structuredNode = renderStructuredMessage({
	    message: props.message,
	    sessionId: props.sessionId,
        serverId: props.serverId,
        interaction: props.interaction,
	    onJumpToAnchor: handleJumpToAnchor,
	    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
	  });
  const sessionMediaMeta = React.useMemo(() => {
    const primaryEnvelope = parseHappierMetaEnvelope(props.message.meta);
    const envelope = primaryEnvelope?.kind === 'session_media.v1'
      ? primaryEnvelope
      : parseHappierMetaEnvelope(props.message.meta, 'happierMedia');
    return parseSessionMediaMessageMeta(envelope);
  }, [props.message.meta]);
  const isStructuredOnly = structuredNode != null;

  const attachmentsMeta = React.useMemo(() => readTranscriptAttachmentsMeta(props.message.meta), [props.message.meta]);

  const nonImageAttachments = React.useMemo(() => {
    if (!attachmentsMeta) return [];
    return attachmentsMeta.attachments.filter((a) => {
      return resolveSessionMediaInlineRenderableImageMimeType(a) == null;
    });
  }, [attachmentsMeta]);
	  const handleOpenAttachmentPath = React.useCallback((filePath: string) => {
	    pushSessionFileDeepLink(transcriptSource.navigate, { sessionId: props.sessionId, serverId: props.serverId, filePath });
	  }, [props.serverId, props.sessionId, transcriptSource]);

  const unsupportedContentMeta = React.useMemo(
    () => readUnsupportedContentMeta(props.message.meta),
    [props.message.meta],
  );
  const unsupportedContentText = messageDisplay.unsupportedContentText;
  const markdownText = messageDisplay.text;
  const renderedMarkdownText = markdownText ?? props.message.displayText ?? props.message.text;

  // One projection for both branches (D-6). Sessions come only from the envelope (INV-5);
  // files additionally keep the permanent text scan (D-5).
  const structuredReferences = useMessageStructuredReferences({
    meta: props.message.meta,
    text: renderedMarkdownText,
  });
  const composerAttachments = useMessageComposerAttachments(props.message.meta);

  const handleOptionPress = React.useCallback((option: Option) => {
    fireAndForget((async () => {
      try {
        if (!props.canSendMessages || !sourceCanSendMessages || transcriptSource.actions === null) {
          Modal.alert(t('session.sharing.viewOnly'), t('session.sharing.noEditPermission'));
          return;
        }
        await transcriptSource.actions.submitMessage(option.title, {
          callerSurface: 'message_option',
        });
      } catch (e) {
        Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
      }
    })(), { tag: 'MessageView.handleOptionPress.userMessage' });
  }, [props.canSendMessages, props.sessionId, sourceCanSendMessages, transcriptSource.actions]);
  const handleOptionLongPress = React.useCallback<OptionLongPressHandler>(async (option) => {
    const ok = await setClipboardStringSafe(option.title);
    if (!ok) {
      Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
      return false;
    }
    return true;
  }, []);

  const selectableMessage = isDiscarded ? null : (() => {
    const base = resolveSelectableMessageText({
      message: props.message,
      isStructuredOnly,
      hasAttachmentBlockToStrip: attachmentsMeta != null,
    });
    return base && unsupportedContentText != null ? { ...base, text: unsupportedContentText } : base;
  })();
  const selectionEnabled = props.messageDisplayCommon.transcriptMessageSelectionEnabled === true && selectableMessage != null;
  const selectionRow = useOptionalTranscriptSelectionRow(props.message.id);
  const selectionModeActionsVisible = selectionEnabled && selectionRow.isSelectionMode;
  const messagePinAvailability = React.useMemo(() => resolveMessagePinAvailability({
    sessionId: props.sessionId,
    seq: resolveTranscriptMessageSeq(props.message),
    transcriptBlockIndex: resolveTranscriptMessageBlockIndex(props.message),
    routeMessageId: buildMessageRouteId(props.message),
    role: 'user',
    pins: props.messagePins ?? [],
  }), [props.message, props.messagePins, props.sessionId]);
  const rowActionVisibilityInput = {
    platformOS: Platform.OS,
    isRowHovered: isMessageHovered,
    isActionHovered: isCopyButtonHovered,
    isRowFocused: isActionRowFocused,
    coarsePrimaryPointer: readCoarsePrimaryPointer(),
    selectionModeActive: selectionModeActionsVisible,
  } as const;
  const hasPinButton = props.onToggleMessagePin != null && messagePinAvailability.status === 'available';
  const showMessageActions = shouldShowTranscriptRowActions(rowActionVisibilityInput);
  const showPinButton = hasPinButton && shouldShowTranscriptRowPinAction({
    ...rowActionVisibilityInput,
    pinned: messagePinAvailability.status === 'available' && messagePinAvailability.pinned,
  });
  const copyText = selectableMessage?.text ?? (isStructuredOnly ? props.message.text : (markdownText ?? props.message.displayText ?? props.message.text));
  const timestampPresentation = resolveMessageTimestampPresentation({
    displayMode: props.messageDisplayCommon.transcriptMessageTimestampDisplayMode,
    isWeb,
    showActions: showMessageActions,
  });
  const timestampText = timestampPresentation.showTimestamp
    ? formatTranscriptMessageTimestamp(props.message.createdAt)
    : null;

  const workspacePath = props.messageDisplayCommon.workspacePath;
	  const handleMarkdownLinkPress = React.useCallback((url: string) => {
	    if (!props.canOpenFiles) return false;
	    const resolved = resolveTranscriptMarkdownFileLink({ url, workspacePath });
	    if (!resolved) return false;
	    const anchor = resolved.anchor ?? null;
	    pushSessionFileDeepLink(transcriptSource.navigate, {
	      sessionId: props.sessionId,
	      serverId: props.serverId,
	      filePath: resolved.filePath,
	      ...(anchor ? { source: 'file' as const, anchor } : {}),
	    });
	    return true;
	  }, [props.canOpenFiles, props.serverId, props.sessionId, transcriptSource, workspacePath]);


  if (isVoiceAgentTurn && (markdownText == null || markdownText.trim().length === 0)) {
    return null;
  }

  // Structured user messages should render as standalone blocks (tool-card style),
  // not inside a chat bubble background, and without echoing displayText fallback.
  if (isStructuredOnly) {
    return (
      <CommittedMessageActions
      message={props.message} sessionId={props.sessionId} serverId={props.serverId}
      selectableText={selectableMessage} copyText={copyText} isStructuredOnly={isStructuredOnly} hasUnsupportedContent={unsupportedContentMeta != null}
      canFork={props.canFork} forkCommon={props.forkCommon} isForkAllowed={props.isForkAllowed}
      settings={props.messageDisplayCommon} rollbackAction={props.rollbackAction}
      messagePins={props.messagePins} onToggleMessagePin={props.onToggleMessagePin}
      showActions={showMessageActions} showPinAction={showPinButton}
      timestampText={timestampText} invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
      onActionsFocus={handleActionsFocus} onActionsBlur={handleActionsBlur}
      onActionHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
      onActionHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
      onHoverIn={isWeb ? () => setIsMessageHovered(true) : undefined}
      onHoverOut={isWeb ? () => setIsMessageHovered(false) : undefined}
>
      {(actionsRow) => (
        <View
          collapsable={false}
          style={[styles.structuredUserMessageContainer, props.historical ? styles.historicalMessageContainer : null]}
        >
          {selectionEnabled && selectableMessage ? (
            <View style={styles.messageSelectionCheckboxSlot}>
              <MessageSelectionCheckbox
                messageId={props.message.id}
                role={selectableMessage.role}
                previewText={selectableMessage.text}
                testID={`transcript-message-select-checkbox:${props.message.id}`}
              />
            </View>
          ) : null}
          <TranscriptJumpAttention
            sessionAddress={transcriptSource.sessionId === props.sessionId ? normalizeSessionAddress(transcriptSource.serverId, props.sessionId) : null}
            routeMessageId={buildMessageRouteId(props.message)}
            seq={resolveTranscriptMessageSeq(props.message)}
            radius={TRANSCRIPT_MESSAGE_HIGHLIGHT_RADIUS}
            style={styles.structuredUserMessageContent}
          >
            {structuredNode}
            {attachmentsMeta ? (
              <AttachmentsInlineImages
                sessionId={props.sessionId}
                attachments={attachmentsMeta.attachments}
                onOpenPath={handleOpenAttachmentPath}
                fileOpenEnabled={props.canOpenFiles}
                mediaPreviewEnabled={props.canPreviewMedia}
              />
            ) : null}
            {sessionMediaMeta ? (
              <SessionMediaInlineImages
                sessionId={props.sessionId}
                media={sessionMediaMeta.inlineMedia}
                onOpenPath={handleOpenAttachmentPath}
                fileOpenEnabled={props.canOpenFiles}
                mediaPreviewEnabled={props.canPreviewMedia}
              />
            ) : null}
            {nonImageAttachments.length > 0 ? (
              <AttachmentsMessageRow
                attachments={nonImageAttachments}
                onOpenPath={props.canOpenFiles ? handleOpenAttachmentPath : undefined}
              />
            ) : null}
            <ComposerAttachmentFallbackRow
              messageId={props.message.id}
              attachments={composerAttachments}
            />
            {structuredReferences.length > 0 ? (
              <StructuredReferencesRow
                sessionId={props.sessionId}
                serverId={props.serverId ?? props.forkCommon.sessionForkSupportSource?.serverId}
                references={structuredReferences}
                fileOpenEnabled={props.canOpenFiles}
              />
            ) : null}
            {isDiscarded ? (
              <Text selectable style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
            ) : null}
          </TranscriptJumpAttention>
          {actionsRow}
        </View>
      )}
    </CommittedMessageActions>
    );
  }

  return (
    <CommittedMessageActions
      message={props.message} sessionId={props.sessionId} serverId={props.serverId}
      selectableText={selectableMessage} copyText={copyText} isStructuredOnly={isStructuredOnly} hasUnsupportedContent={unsupportedContentMeta != null}
      canFork={props.canFork} forkCommon={props.forkCommon} isForkAllowed={props.isForkAllowed}
      settings={props.messageDisplayCommon} rollbackAction={props.rollbackAction}
      messagePins={props.messagePins} onToggleMessagePin={props.onToggleMessagePin}
      showActions={showMessageActions} showPinAction={showPinButton}
      timestampText={timestampText} invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
      onActionsFocus={handleActionsFocus} onActionsBlur={handleActionsBlur}
      onActionHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
      onActionHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
      onHoverIn={isWeb ? () => setIsMessageHovered(true) : undefined}
      onHoverOut={isWeb ? () => setIsMessageHovered(false) : undefined}
>
      {(actionsRow) => (
      <View
        collapsable={false}
        style={[styles.userMessageContainer, props.historical ? styles.historicalMessageContainer : null]}
      >
        {selectionEnabled && selectableMessage ? (
          <View style={styles.messageSelectionCheckboxSlot}>
            <MessageSelectionCheckbox
              messageId={props.message.id}
              role={selectableMessage.role}
              previewText={selectableMessage.text}
              testID={`transcript-message-select-checkbox:${props.message.id}`}
            />
          </View>
        ) : null}
        <View
          style={styles.userMessageWrapper}
          {...(isWeb ? {} : { pointerEvents: 'box-none' as const })}
        >
          <View style={styles.userMessageBubbleAligner}>
          <UserMessageBubble
            discarded={isDiscarded}
            attention={{ sessionAddress: transcriptSource.sessionId === props.sessionId ? normalizeSessionAddress(transcriptSource.serverId, props.sessionId) : null, routeMessageId: buildMessageRouteId(props.message), seq: resolveTranscriptMessageSeq(props.message), radius: TRANSCRIPT_MESSAGE_HIGHLIGHT_RADIUS }}
          >
            <MarkdownView markdown={renderedMarkdownText} findActive={findActive} findSourceRanges={findSourceRanges} renderCacheKey={buildMessageMarkdownRenderCacheKey(props.message.id, props.messageRevision)} onOptionPress={handleOptionPress} onOptionLongPress={handleOptionLongPress} onLinkPress={handleMarkdownLinkPress} selectable={true} profile="transcript" textStyle={styles.transcriptMarkdownText} />
            {attachmentsMeta ? (
              <AttachmentsInlineImages
                sessionId={props.sessionId}
                attachments={attachmentsMeta.attachments}
                onOpenPath={handleOpenAttachmentPath}
                fileOpenEnabled={props.canOpenFiles}
                mediaPreviewEnabled={props.canPreviewMedia}
              />
            ) : null}
            {sessionMediaMeta ? (
              <SessionMediaInlineImages
                sessionId={props.sessionId}
                media={sessionMediaMeta.inlineMedia}
                onOpenPath={handleOpenAttachmentPath}
                fileOpenEnabled={props.canOpenFiles}
                mediaPreviewEnabled={props.canPreviewMedia}
              />
            ) : null}
            {nonImageAttachments.length > 0 ? (
              <AttachmentsMessageRow
                attachments={nonImageAttachments}
                onOpenPath={props.canOpenFiles ? handleOpenAttachmentPath : undefined}
              />
            ) : null}
            <ComposerAttachmentFallbackRow
              messageId={props.message.id}
              attachments={composerAttachments}
            />
            {structuredReferences.length > 0 ? (
              <StructuredReferencesRow
                sessionId={props.sessionId}
                serverId={props.serverId ?? props.forkCommon.sessionForkSupportSource?.serverId}
                references={structuredReferences}
                fileOpenEnabled={props.canOpenFiles}
              />
            ) : null}
            {isDiscarded && (
              <Text selectable style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
            )}
          </UserMessageBubble>
          </View>
          {actionsRow}
        </View>
      </View>
    )}
    </CommittedMessageActions>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  metadata: Metadata | null;
  sessionId: string;
  serverId?: string | null;
  interaction: TranscriptInteraction;
  canSendMessages: boolean;
  canOpenFiles: boolean;
  canPreviewMedia: boolean;
  canFork: boolean;
  activeThinkingMessageId: string | null;
  thinkingExpanded?: boolean;
  onThinkingExpandedChange?: (next: boolean) => void;
  rollbackAction?: TranscriptRollbackAction | null;
  messagePins?: readonly PersistedSessionMessagePinV1[];
  messageRevision?: number | null;
  onToggleMessagePin?: SessionMessagePinToggleHandler;
  historical?: boolean;
  forkCommon: TranscriptForkCommon;
  isForkAllowed: () => boolean;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
  toolDisplaySettings?: ToolViewDisplaySettings;
}) {
  const find = useTranscriptFindRow(props.message.id);
  const findActive = useTranscriptFindActive();
  const findSourceRanges = find?.blocks.find((block) => block.id === 'text')?.sourceRanges;
  const findRevealId = find?.reveal?.blockId === 'text' ? find.reveal.requestId : undefined;
  React.useEffect(() => {
    if (findRevealId !== undefined && props.message.isThinking) props.onThinkingExpandedChange?.(true);
  }, [findRevealId, props.message.isThinking, props.onThinkingExpandedChange]);
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const [isActionRowFocused, setIsActionRowFocused] = React.useState(false);
  const handleActionsFocus = React.useCallback(() => setIsActionRowFocused(true), []);
  const handleActionsBlur = React.useCallback(() => setIsActionRowFocused(false), []);
  const isWeb = Platform.OS === 'web';
  const fallbackTextSelectable = shouldEnableFallbackTextNativeSelection(Platform.OS);
	  const transcriptSource = useSessionTranscriptSource();
  const sourceCanSendMessages = transcriptSource.useInteraction().canSendMessages;
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId, props.serverId, props.canOpenFiles);
  const messageDisplay = React.useMemo(() => resolveTranscriptMessageDisplayText(props.message, {
    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
    thinkingDisplayMode: props.messageDisplayCommon.sessionThinkingDisplayMode,
  }), [props.message, props.messageDisplayCommon.debugInformationEnabled, props.messageDisplayCommon.sessionThinkingDisplayMode]);
  const {
    sessionThinkingDisplayMode,
    sessionThinkingInlineChrome,
    sessionThinkingInlinePresentation,
    transcriptStreamingMarkdownRenderingEnabled: transcriptStreamingMarkdownRenderingEnabledRaw,
    transcriptStreamingPartialOutputEnabled: transcriptStreamingPartialOutputEnabledRaw,
    transcriptStreamingSettleDelayMs: transcriptStreamingSettleDelayMsRaw,
    transcriptStreamingSmoothingEnabled: transcriptStreamingSmoothingEnabledRaw,
  } = props.messageDisplayCommon;
  const motion = useTranscriptMotion();
  const thinkingPulseEnabled =
    props.message.isThinking === true &&
    props.activeThinkingMessageId === props.message.id &&
    motion?.config.preset !== 'off' &&
    motion?.config.animateThinkingEnabled === true;

  const structuredNode = renderStructuredMessage({
	    message: props.message,
	    sessionId: props.sessionId,
        serverId: props.serverId,
        interaction: props.interaction,
	    onJumpToAnchor: handleJumpToAnchor,
	    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
	  });
  const isStructuredOnly = structuredNode != null;
  const agentUnsupportedContentMeta = readUnsupportedContentMeta(props.message.meta);
  const agentUnsupportedContentText = messageDisplay.unsupportedContentText;
  const markdown = messageDisplay.text ?? props.message.text;
  const deriveThinkingSummary = (text: string) => {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return '';
    const firstLine = trimmed.split('\n').find((line) => line.trim().length > 0) ?? '';
    const cleaned = firstLine
      .trim()
      .replace(/^#+\s+/, '')
      .replace(/^[-*]\s+/, '')
      .replace(/\s+/g, ' ');
    if (cleaned.length <= 120) return cleaned;
    return cleaned.slice(0, 117) + '…';
  };
  const selectableMessage = (() => {
    const base = resolveSelectableMessageText({
      message: props.message,
      isStructuredOnly,
      hasAttachmentBlockToStrip: false,
    });
    return base && agentUnsupportedContentText != null ? { ...base, text: agentUnsupportedContentText } : base;
  })();
  const selectionEnabled = props.messageDisplayCommon.transcriptMessageSelectionEnabled === true && selectableMessage != null;
  const copyText = selectableMessage?.text ?? (isStructuredOnly ? props.message.text : markdown);
  const handleOptionPress = React.useCallback((option: Option) => {
    fireAndForget((async () => {
      try {
        if (!props.canSendMessages || !sourceCanSendMessages || transcriptSource.actions === null) {
          Modal.alert(t('session.sharing.viewOnly'), t('session.sharing.noEditPermission'));
          return;
        }
        await transcriptSource.actions.submitMessage(option.title, {
          callerSurface: 'message_option',
        });
      } catch (e) {
        Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
      }
    })(), { tag: 'MessageView.handleOptionPress.agentMessage' });
  }, [props.canSendMessages, props.sessionId, sourceCanSendMessages, transcriptSource.actions]);
  const handleOptionLongPress = React.useCallback<OptionLongPressHandler>(async (option) => {
    const ok = await setClipboardStringSafe(option.title);
    if (!ok) {
      Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
      return false;
    }
    return true;
  }, []);

  const selectionRow = useOptionalTranscriptSelectionRow(props.message.id);
  const selectionModeActionsVisible = selectionEnabled && selectionRow.isSelectionMode;

  const messagePinAvailability = React.useMemo(() => resolveMessagePinAvailability({
    sessionId: props.sessionId,
    seq: resolveTranscriptMessageSeq(props.message),
    transcriptBlockIndex: resolveTranscriptMessageBlockIndex(props.message),
    routeMessageId: buildMessageRouteId(props.message),
    role: 'assistant',
    pins: props.messagePins ?? [],
  }), [props.message, props.messagePins, props.sessionId]);
  const rowActionVisibilityInput = {
    platformOS: Platform.OS,
    isRowHovered: isMessageHovered,
    isActionHovered: isCopyButtonHovered,
    isRowFocused: isActionRowFocused,
    coarsePrimaryPointer: readCoarsePrimaryPointer(),
    selectionModeActive: selectionModeActionsVisible,
  } as const;
  const hasPinButton = props.onToggleMessagePin != null && messagePinAvailability.status === 'available';
  const showMessageActions = shouldShowTranscriptRowActions(rowActionVisibilityInput);
  const showPinButton = hasPinButton && shouldShowTranscriptRowPinAction({
    ...rowActionVisibilityInput,
    pinned: messagePinAvailability.status === 'available' && messagePinAvailability.pinned,
  });
  const timestampPresentation = resolveMessageTimestampPresentation({
    displayMode: props.messageDisplayCommon.transcriptMessageTimestampDisplayMode,
    isWeb,
    showActions: showMessageActions,
  });
  const timestampText = timestampPresentation.showTimestamp
    ? formatTranscriptMessageTimestamp(props.message.createdAt)
    : null;

  const workspacePath = props.messageDisplayCommon.workspacePath;
	  const handleMarkdownLinkPress = React.useCallback((url: string) => {
	    if (!props.canOpenFiles) return false;
	    const resolved = resolveTranscriptMarkdownFileLink({ url, workspacePath });
	    if (!resolved) return false;
	    const anchor = resolved.anchor ?? null;
	    pushSessionFileDeepLink(transcriptSource.navigate, {
	      sessionId: props.sessionId,
	      serverId: props.serverId,
	      filePath: resolved.filePath,
	      ...(anchor ? { source: 'file' as const, anchor } : {}),
	    });
	    return true;
	  }, [props.canOpenFiles, props.serverId, props.sessionId, transcriptSource, workspacePath]);

  const renderThinkingAsToolCard = props.message.isThinking && sessionThinkingDisplayMode === 'tool';
  const renderThinkingInline = props.message.isThinking === true && !renderThinkingAsToolCard;
    const normalizedThinkingInlinePresentation: 'full' | 'summary' =
      sessionThinkingInlinePresentation === 'full' ? 'full' : 'summary';
    const normalizedThinkingInlineChrome: 'plain' | 'card' =
      sessionThinkingInlineChrome === 'plain' ? 'plain' : 'card';
  const thinkingMarkdownTextStyle =
      normalizedThinkingInlineChrome === 'card' ? styles.thinkingMarkdownTextCard : styles.thinkingMarkdownText;

  const transcriptStreamingSmoothingEnabled =
      typeof transcriptStreamingSmoothingEnabledRaw === 'boolean'
          ? transcriptStreamingSmoothingEnabledRaw
          : settingsDefaults.transcriptStreamingSmoothingEnabled;
  const transcriptStreamingSettleDelayMs =
      typeof transcriptStreamingSettleDelayMsRaw === 'number' && Number.isFinite(transcriptStreamingSettleDelayMsRaw)
          ? Math.max(0, Math.trunc(transcriptStreamingSettleDelayMsRaw))
          : settingsDefaults.transcriptStreamingSettleDelayMs;
  const transcriptStreamingPartialOutputEnabled =
      typeof transcriptStreamingPartialOutputEnabledRaw === 'boolean'
          ? transcriptStreamingPartialOutputEnabledRaw
          : settingsDefaults.transcriptStreamingPartialOutputEnabled;
  const transcriptStreamingMarkdownRenderingEnabled =
      typeof transcriptStreamingMarkdownRenderingEnabledRaw === 'boolean'
          ? transcriptStreamingMarkdownRenderingEnabledRaw
          : settingsDefaults.transcriptStreamingMarkdownRenderingEnabled;

  const streamSegmentMeta = readStreamSegmentMetaV1(props.message.meta);
  const streamSegmentAssistantState =
      streamSegmentMeta?.segmentKind === 'assistant' ? streamSegmentMeta.segmentState : null;
  const streamSegmentAssistantStreaming =
      streamSegmentMeta?.segmentKind === 'assistant'
          ? (streamSegmentAssistantState === 'streaming' || streamSegmentAssistantState === null)
          : false;
  const streamingPlainEligible =
      props.historical !== true &&
      props.message.isThinking !== true &&
      isStructuredOnly !== true;
  const shouldRenderActiveStreamSegmentPlain =
      streamingPlainEligible && streamSegmentAssistantStreaming === true;
  const shouldHidePartialStreamingOutput =
      transcriptStreamingPartialOutputEnabled !== true &&
      shouldRenderActiveStreamSegmentPlain;

  const renderText = shouldHidePartialStreamingOutput ? '...' : markdown;

  // Thinking text streams append-only exactly like assistant text and shares
  // the one pacer instance; only the render-path swap below stays
  // assistant-only (thinking keeps its own renderers).
  const streamingSmoothingEligible =
      messageDisplay.text !== null &&
      motion?.config.preset !== 'off' &&
      transcriptStreamingSmoothingEnabled === true &&
      props.historical !== true &&
      isStructuredOnly !== true &&
      (streamSegmentMeta ? streamSegmentAssistantStreaming === true : true);
  const streaming = useStreamingTextSmoothing({
      enabled: streamingSmoothingEligible,
      targetText: renderText,
      settleDelayMs: transcriptStreamingSettleDelayMs,
  });
  const thinkingRenderMarkdown =
      props.message.isThinking === true && streamingSmoothingEligible ? streaming.displayText : markdown;
  const thinkingStreamingActive =
      props.message.isThinking === true && streamingSmoothingEligible && streaming.isStreaming;
  const shouldRenderStreamingPlain =
      shouldRenderActiveStreamSegmentPlain || (props.message.isThinking !== true && streaming.isStreaming);
  const shouldRenderStreamingMarkdown =
      shouldRenderStreamingPlain && transcriptStreamingMarkdownRenderingEnabled === true;
  // The pacer already meters reveal frequency, so the streaming Markdown path
  // renders its output directly; the parse cache keeps per-frame cost bounded
  // to the changing tail block.
  const streamingMarkdownText = streaming.displayText;
  const committedStreamingMarkdownMessageIdRef = React.useRef<string | null>(null);
  const staticRenderPlaceholderEnabled =
      shouldRenderStreamingMarkdown ||
      committedStreamingMarkdownMessageIdRef.current === props.message.id
          ? false
          : undefined;
  React.useLayoutEffect(() => {
      if (shouldRenderStreamingMarkdown) {
          committedStreamingMarkdownMessageIdRef.current = props.message.id;
      }
  }, [props.message.id, shouldRenderStreamingMarkdown]);
  const streamingRevealAnimationEnabled =
      motion?.config.preset !== 'off' &&
      motion?.config.animateNewItemsEnabled === true;
  const streamingRevealPreset = motion?.config.preset === 'full' ? 'full' : 'subtle';
  const streamingLiveRegionProps = isWeb && shouldRenderStreamingPlain
    ? {
        role: 'log' as const,
        accessibilityLiveRegion: 'polite' as const,
        'aria-live': 'polite' as const,
        'aria-busy': true,
        'aria-atomic': false,
      }
    : null;
  const structuredReferencesDeferred = useMessageStructuredReferences({
    meta: props.message.meta,
    text: markdown,
    enabled: messageDisplay.text !== null && !shouldRenderStreamingPlain,
  });
  const handleOpenAgentSessionMediaPath = React.useCallback((filePath: string) => {
    pushSessionFileDeepLink(transcriptSource.navigate, { sessionId: props.sessionId, serverId: props.serverId, filePath });
  }, [props.serverId, props.sessionId, transcriptSource]);
  const agentSessionMediaMeta = React.useMemo(() => {
    const primaryEnvelope = parseHappierMetaEnvelope(props.message.meta);
    const envelope = primaryEnvelope?.kind === 'session_media.v1'
      ? primaryEnvelope
      : parseHappierMetaEnvelope(props.message.meta, 'happierMedia');
    return parseSessionMediaMessageMeta(envelope);
  }, [props.message.meta]);

  // Hidden thinking and filtered text keep the mounted row's hook order stable.
  if (messageDisplay.text === null) return null;

  return (
    <CommittedMessageActions
      message={props.message} sessionId={props.sessionId} serverId={props.serverId}
      selectableText={selectableMessage} copyText={copyText} isStructuredOnly={isStructuredOnly}
      canFork={props.canFork} forkCommon={props.forkCommon} isForkAllowed={props.isForkAllowed}
      settings={props.messageDisplayCommon} rollbackAction={props.rollbackAction}
      messagePins={props.messagePins} onToggleMessagePin={props.onToggleMessagePin}
      showActions={showMessageActions} showPinAction={showPinButton}
      timestampText={timestampText} invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
      onActionsFocus={handleActionsFocus} onActionsBlur={handleActionsBlur}
      onActionHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
      onActionHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
      onHoverIn={isWeb ? () => setIsMessageHovered(true) : undefined}
      onHoverOut={isWeb ? () => setIsMessageHovered(false) : undefined}
    >
      {(actionsRow) => (
      <TranscriptJumpAttention
        sessionAddress={transcriptSource.sessionId === props.sessionId ? normalizeSessionAddress(transcriptSource.serverId, props.sessionId) : null}
        routeMessageId={buildMessageRouteId(props.message)}
        seq={resolveTranscriptMessageSeq(props.message)}
        radius={TRANSCRIPT_AGENT_BLOCK_HIGHLIGHT_RADIUS}
        viewProps={{
          collapsable: false,
          ...streamingLiveRegionProps,
          ...(isWeb ? {} : { pointerEvents: 'box-none' as const }),
        }}
        style={[
          styles.agentMessageContainer,
          props.message.isThinking === true ? styles.agentMessageContainerThinking : null,
          props.historical ? styles.historicalMessageContainer : null,
        ]}
      >
        {selectionEnabled && selectableMessage ? (
          <View style={styles.messageSelectionCheckboxSlot}>
            <MessageSelectionCheckbox
              messageId={props.message.id}
              role={selectableMessage.role}
              previewText={selectableMessage.text}
              testID={`transcript-message-select-checkbox:${props.message.id}`}
            />
          </View>
        ) : null}
        {structuredNode}
        {isStructuredOnly ? null : (
          renderThinkingAsToolCard ? (
            <ToolView
              metadata={props.metadata}
              tool={{
                id: `thinking:${props.message.id}`,
                name: 'Reasoning',
                state: 'completed',
                input: {},
                createdAt: props.message.createdAt,
                startedAt: null,
                completedAt: props.message.createdAt,
                description: null,
                result: { content: thinkingRenderMarkdown },
              }}
              messages={[]}
              messageId={props.message.id}
              findBodyBlockId="text"
              displaySettings={props.toolDisplaySettings}
            />
          ) : (
              renderThinkingInline ? (
                <ThinkingTimelineRow
                  id={props.message.id}
                  createdAt={props.message.createdAt}
                  label={t('sessionInfo.thinking')}
                  summary={deriveThinkingSummary(thinkingRenderMarkdown)}
                  expandedByDefault={normalizedThinkingInlinePresentation === 'full'}
                  pulseEnabled={thinkingPulseEnabled}
                  chrome={normalizedThinkingInlineChrome}
                  expanded={props.thinkingExpanded}
                  onExpandedChange={props.onThinkingExpandedChange}
                >
                  <MarkdownView
                    testID="transcript-thinking-body-markdown"
                    findActive={findActive} findSourceRanges={findSourceRanges}
                    markdown={thinkingRenderMarkdown}
                    agentTexMath
                    renderCacheKey={buildMessageMarkdownRenderCacheKey(props.message.id, props.messageRevision)}
                    onOptionPress={handleOptionPress}
                    onOptionLongPress={handleOptionLongPress}
                    onLinkPress={handleMarkdownLinkPress}
                    selectable={true}
                    profile="thinking"
                    textStyle={thinkingMarkdownTextStyle}
                    {...(thinkingStreamingActive
                      ? {
                          streamingMode: 'streaming' as const,
                          streamingAnimated: streamingRevealAnimationEnabled,
                          streamingRevealPreset,
                        }
                      : null)}
                  />
                </ThinkingTimelineRow>
            ) : (
              shouldRenderStreamingMarkdown ? (
                  <MarkdownView
                      markdown={streamingMarkdownText}
                      findActive={findActive} findSourceRanges={findSourceRanges}
                      agentTexMath
                      renderCacheKey={buildMessageMarkdownRenderCacheKey(props.message.id, props.messageRevision)}
                      onOptionPress={handleOptionPress}
                      onOptionLongPress={handleOptionLongPress}
                      onLinkPress={handleMarkdownLinkPress}
                      selectable={true}
                      profile="transcript"
                      textStyle={styles.transcriptMarkdownText}
                      streamingMode="streaming"
                      streamingAnimated={streamingRevealAnimationEnabled}
                      streamingRevealPreset={streamingRevealPreset}
                  />
              ) : shouldRenderStreamingPlain ? (
                  <Text
                      testID={`transcript-streaming-plain:${props.message.id}`}
                      selectable={fallbackTextSelectable}
                      style={[styles.transcriptMarkdownText, styles.streamingPlainText]}
                  >
                      <FindHighlightedText text={streaming.displayText} ranges={findSourceRanges} selectable={fallbackTextSelectable} />
                  </Text>
              ) : (
                  <MarkdownView
                      markdown={markdown}
                      findActive={findActive} findSourceRanges={findSourceRanges}
                      agentTexMath
                      renderCacheKey={buildMessageMarkdownRenderCacheKey(props.message.id, props.messageRevision)}
                      onOptionPress={handleOptionPress}
                      onOptionLongPress={handleOptionLongPress}
                      onLinkPress={handleMarkdownLinkPress}
                      selectable={true}
                      profile={props.message.isThinking ? 'thinking' : 'transcript'}
                      textStyle={props.message.isThinking ? styles.thinkingMarkdownText : styles.transcriptMarkdownText}
                      staticRenderPlaceholderEnabled={staticRenderPlaceholderEnabled}
                  />
              )
            )
          )
        )}
        {structuredReferencesDeferred.length > 0 ? (
          <StructuredReferencesRow
            sessionId={props.sessionId}
            serverId={props.serverId ?? props.forkCommon.sessionForkSupportSource?.serverId}
            references={structuredReferencesDeferred}
            fileOpenEnabled={props.canOpenFiles}
          />
        ) : null}
        {agentSessionMediaMeta ? (
          <SessionMediaInlineImages
            sessionId={props.sessionId}
            media={agentSessionMediaMeta.inlineMedia}
            onOpenPath={handleOpenAgentSessionMediaPath}
            fileOpenEnabled={props.canOpenFiles}
            mediaPreviewEnabled={props.canPreviewMedia}
          />
        ) : null}
          {actionsRow}
      </TranscriptJumpAttention>
    )}
    </CommittedMessageActions>
  );
}
function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  layoutContext: 'transcript' | 'tool_calls_group';
  forcePermissionPromptsInTranscript?: boolean;
  approvalRequests?: readonly OpenApprovalArtifactForSession[];
  activeThinkingMessageId: string | null;
  getMessageById?: (id: string) => Message | null;
  interaction: TranscriptInteraction;
  rollbackAction?: TranscriptRollbackAction | null;
  messagePins?: readonly PersistedSessionMessagePinV1[];
  onToggleToolPin?: SessionMessagePinToggleHandler;
  historical?: boolean;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
  toolChromeCommon: TranscriptToolChromeCommon;
  toolRouteCommon: TranscriptToolRouteCommon;
}) {
	  const transcriptSource = useSessionTranscriptSource();
  const structuredPinHost = useRowActionHoverHost();
  const handleJumpToAnchor = useStructuredMessageJumpHandler(
    props.sessionId,
    props.toolChromeCommon.serverId,
    props.interaction.canOpenFiles === true,
  );
	  const toolViewTimelineChromeMode = props.toolChromeCommon.toolViewTimelineChromeMode;
  const messagesById = props.toolRouteCommon.messagesById;
  const reducerState = props.toolRouteCommon.reducerState;
  if (!props.message.tool) {
    return null;
  }
  const structuredNode = renderStructuredMessage({
	    message: props.message,
	    sessionId: props.sessionId,
        serverId: props.toolChromeCommon.serverId,
        interaction: props.interaction,
	    onJumpToAnchor: handleJumpToAnchor,
	    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
	  });
  const hasStructuredNode = structuredNode != null;
  const { turnChanges, shouldRenderToolChrome } = React.useMemo(() => deriveToolMessageDisplay({
    tool: props.message.tool,
    hasStructuredNode,
    toolViewTimelineChromeMode,
    permissionDisabledReason: props.interaction.permissionDisabledReason,
  }), [props.message.tool, hasStructuredNode, toolViewTimelineChromeMode, props.interaction.permissionDisabledReason]);
  const toolRouteMessageId = resolveMessageRouteIdForDisplay({
        message: props.message,
        messagesById,
        reducerState,
      });
  const toolSeq = resolveTranscriptMessageSeq(props.message);
  const toolPinAction = resolveToolRowPinAction({
    sessionId: props.sessionId,
    seq: toolSeq,
    transcriptBlockIndex: resolveTranscriptMessageBlockIndex(props.message),
    routeMessageId: toolRouteMessageId ?? null,
    pins: props.messagePins,
    readOnlyContext: props.interaction.permissionDisabledReason === 'readOnly',
    onTogglePin: props.onToggleToolPin,
    testID: `transcript-tool-call-pin:${props.message.id}`,
  });
  const handleOpenToolSessionMediaPath = React.useCallback((filePath: string) => {
    pushSessionFileDeepLink(transcriptSource.navigate, {
      sessionId: props.sessionId,
      serverId: props.toolChromeCommon.serverId,
      filePath,
    });
  }, [props.sessionId, props.toolChromeCommon.serverId, transcriptSource]);
  const toolSessionMediaMeta = React.useMemo(() => {
    const primaryEnvelope = parseHappierMetaEnvelope(props.message.meta);
    const envelope = primaryEnvelope?.kind === 'session_media.v1'
      ? primaryEnvelope
      : parseHappierMetaEnvelope(props.message.meta, 'happierMedia');
    return parseSessionMediaMessageMeta(envelope);
  }, [props.message.meta]);
  const containerStyle = [
    styles.toolContainer,
    props.layoutContext === 'tool_calls_group' ? styles.toolContainerEmbedded : null,
    toolViewTimelineChromeMode === 'activity_feed'
      ? (props.layoutContext === 'tool_calls_group' ? styles.toolContainerFeedEmbedded : styles.toolContainerFeed)
      : styles.toolContainerCards,
  ];
  const containerContent = (
    <>
      {structuredNode}
      {turnChanges ? (
        <TranscriptTurnChangesCard
          sessionId={props.sessionId}
          serverId={props.toolChromeCommon.serverId ?? null}
          turnId={turnChanges.turnId}
          files={turnChanges.files}
          messageId={toolRouteMessageId}
          onOpenFile={props.interaction.canOpenFiles === true ? handleOpenToolSessionMediaPath : null}
        />
      ) : null}
      {!shouldRenderToolChrome && toolPinAction ? (
        <RowActionRevealSlot
          revealed={shouldShowTranscriptRowPinAction({
            platformOS: Platform.OS,
            isRowHovered: structuredPinHost.isHovered,
            isActionHovered: false,
            coarsePrimaryPointer: readCoarsePrimaryPointer(),
            pinned: toolPinAction.pinned,
          })}
          style={styles.structuredToolPinAction}
          testID={`transcript-tool-call-pin-slot:${props.message.id}`}
        >
          {toolPinAction.node}
        </RowActionRevealSlot>
      ) : null}
      {shouldRenderToolChrome ? (toolViewTimelineChromeMode === 'activity_feed' ? (
        <ToolTimelineRow
          tool={props.message.tool}
          metadata={props.metadata}
          messages={props.message.children}
          sessionId={props.sessionId}
          serverId={props.toolChromeCommon.serverId ?? undefined}
          messageId={toolRouteMessageId}
          jumpHighlightSeq={toolSeq}
          headerAction={toolPinAction}
          approvalRequests={props.approvalRequests}
          forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
          interaction={props.interaction}
          displaySettings={props.toolChromeCommon.toolDisplaySettings}
        />
      ) : (
        <ToolView
          tool={props.message.tool}
          metadata={props.metadata}
          messages={props.message.children}
          sessionId={props.sessionId}
          serverId={props.toolChromeCommon.serverId ?? undefined}
          messageId={toolRouteMessageId}
          jumpHighlightSeq={toolSeq}
          headerAction={toolPinAction}
          approvalRequests={props.approvalRequests}
          forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
          interaction={props.interaction}
          displaySettings={props.toolChromeCommon.toolDisplaySettings}
        />
      )) : null}
      {toolSessionMediaMeta ? (
        <SessionMediaInlineImages
          sessionId={props.sessionId}
          media={toolSessionMediaMeta.inlineMedia}
          onOpenPath={handleOpenToolSessionMediaPath}
          fileOpenEnabled={props.interaction.canOpenFiles === true}
          mediaPreviewEnabled={props.interaction.canPreviewMedia === true}
        />
      ) : null}
    </>
  );
  // The tool chrome (ToolView / ToolTimelineRow) owns the jump-landing attention
  // when it renders. A suppressed-chrome structured row has no chrome to own it,
  // so the row container carries the same treatment — one highlight store, one
  // timing owner, one ring per landed row.
  if (!shouldRenderToolChrome) {
    return (
      <TranscriptJumpAttention
        sessionAddress={transcriptSource.sessionId === props.sessionId ? normalizeSessionAddress(transcriptSource.serverId, props.sessionId) : null}
        routeMessageId={toolRouteMessageId ?? null}
        seq={toolSeq}
        radius={TRANSCRIPT_MESSAGE_HIGHLIGHT_RADIUS}
        viewProps={structuredPinHost.hoverProps}
        style={containerStyle}
      >
        {containerContent}
      </TranscriptJumpAttention>
    );
  }
  return (
    <View {...structuredPinHost.hoverProps} style={containerStyle}>
      {containerContent}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  messageContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  messageContent: {
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
  },
  recoveredHistoryIndicator: {
    marginHorizontal: 16,
    marginBottom: 6,
    fontSize: 12,
    color: theme.colors.message.event.foreground,
  },
    messageProvenanceAttribution: {
    ...Typography.rowMeta(),
    alignSelf: 'stretch',
    marginHorizontal: 16,
    marginBottom: 4,
    color: theme.colors.text.secondary,
    textAlign: 'right',
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  structuredUserMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignSelf: 'stretch',
    paddingHorizontal: 16,
    paddingBottom: theme.transcript.messageGap,
    position: 'relative',
  },
  structuredUserMessageContent: {
    maxWidth: '100%',
  },
    userMessageWrapper: {
      // Stretch the wrapper to the full row width so the absolutely positioned
      // MessageActionRow is measured against the full width — its timestamp/actions can
      // then grow past a small bubble's width instead of being constrained to it (which
      // made short messages wrap the timestamp vertically). The bubble is right-aligned
      // and hugged by userMessageBubbleAligner below.
      alignSelf: 'stretch',
      position: 'relative',
      paddingBottom: theme.transcript.messageGap,
    },
    userMessageBubbleAligner: {
      // Hug + right-align the bubble within the full-width wrapper. The bubble itself stays
      // a default-stretch child of this aligner so its text wraps at a bounded width on
      // native (a flex-end/auto-width bubble would measure text at max-content and overflow
      // on one line, since maxWidth:'100%' only clamps the box, it does not bound the text).
      alignSelf: 'flex-end',
      maxWidth: '100%',
    },
  userStructuredMessageWrapper: {
    maxWidth: '100%',
  },
  historicalMessageContainer: {
    opacity: 0.55,
  },
  discardedCommittedMessageLabel: {
    marginTop: 6,
    fontSize: 12,
    color: theme.colors.message.event.foreground,
  },
  agentMessageContainer: {
    marginHorizontal: 16,
    paddingBottom: theme.transcript.messageGap,
    alignSelf: 'stretch',
    position: 'relative',
    maxWidth: '100%',
  },
  agentMessageContainerThinking: {
    alignSelf: 'stretch',
  },
  eventHighlightSurface: {
    alignSelf: 'stretch',
  },
  toolContainer: {
    marginHorizontal: 16,
  },
  toolContainerEmbedded: {
    marginHorizontal: 0,
  },
  structuredToolPinAction: {
    alignSelf: 'flex-end',
    marginTop: 4,
  },
  toolContainerCards: {
    paddingBottom: 0,
  },
  toolContainerFeed: {
    paddingBottom: theme.transcript.messageGap,
  },
  toolContainerFeedEmbedded: {
    paddingBottom: 0,
  },
  messageSelectionCheckboxSlot: {
    position: 'absolute',
    top: TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_TOP,
    right: TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_RIGHT,
    zIndex: TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_Z_INDEX,
  },
  debugText: {
    color: theme.colors.message.event.foreground,
    fontSize: 12,
  },
  transcriptMarkdownText: {
    ...transcriptMarkdownTextStyle,
  },
  streamingPlainText: {
    color: theme.colors.text.primary,
  },
    thinkingLabel: {
      marginBottom: 6,
      marginLeft: 2,
      color: theme.colors.message.event.foreground,
      fontSize: 12,
      fontStyle: 'italic',
      opacity: 0.78,
    },
      thinkingMarkdownText: {
        color: theme.colors.text.secondary,
        fontStyle: 'italic',
        opacity: 0.9,
            fontSize: 14,
            lineHeight: 20,
            marginTop: 0,
            marginBottom: 0,
      },
      thinkingPlainText: {
        color: theme.colors.text.secondary,
        fontStyle: 'italic',
        opacity: 0.9,
        fontSize: 14,
        lineHeight: 20,
      },
      thinkingMarkdownTextCard: {
        color: theme.colors.text.secondary,
        fontStyle: 'italic',
        opacity: 0.95,
            fontSize: 14,
            lineHeight: 20,
            marginTop: 0,
            marginBottom: 0,
      },
      thinkingPlainTextCard: {
        color: theme.colors.text.secondary,
        fontStyle: 'italic',
        opacity: 0.95,
        fontSize: 14,
        lineHeight: 20,
      },
    }));
