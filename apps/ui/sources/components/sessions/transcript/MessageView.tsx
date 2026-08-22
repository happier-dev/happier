import * as React from "react";
import { View, Pressable, Platform } from 'react-native';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/domains/messages/messageTypes";
import { Metadata } from "@/sync/domains/state/storageTypes";
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { useLayoutMaxWidthStyle } from "@/components/ui/layout/layout";
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import { resolveInactiveSessionToolCallFailure } from '@/components/tools/shell/permissions/resolveInactiveSessionToolCallFailure';
import { buildMessageRouteId, resolveMessageRouteIdForDisplay } from '@/sync/domains/messages/messageRouteIds';
import { readUnsupportedContentMeta, type UnsupportedContentKind } from '@/sync/domains/messages/unsupportedContentMeta';
import { resolveUnsupportedContentLabel } from '@/sync/domains/messages/resolveUnsupportedContentLabel';
import {
  resolveUnsupportedContentPresentation,
  type UnsupportedContentPresentation,
} from '@/sync/domains/messages/unsupportedContentPresentation';
import { sync } from '@/sync/sync';
import type { Option, OptionLongPressHandler } from '@/components/markdown/MarkdownView';
import { isCommittedMessageDiscarded } from "@/utils/sessions/discardedCommittedMessages";
import { shouldShowTranscriptRowActions, shouldShowTranscriptRowPinAction } from '@/components/sessions/transcript/transcriptRowActionVisibility';
import { MessageSelectionCheckbox } from '@/components/sessions/transcript/messageSelection/MessageSelectionCheckbox';
import { SelectMessageButton } from '@/components/sessions/transcript/messageSelection/SelectMessageButton';
import { useOptionalTranscriptSelectionRow } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import {
  resolveSelectableMessageText,
  stripLegacyAttachmentsBlock,
  unwrapLegacyThinkingWrapper,
} from '@/components/sessions/transcript/messageSelection/resolveSelectableMessageText';
import { renderStructuredMessage, StructuredMessageBlock } from '@/components/sessions/transcript/structured/StructuredMessageBlock';
import type { StructuredMessageRendererParams } from '@/components/sessions/transcript/structured/structuredMessageRegistry';
import { useRouter } from 'expo-router';
import { buildSessionFileDeepLink } from '@/utils/url/sessionFileDeepLink';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useMessageStructuredReferences } from '@/components/sessions/transcript/references/messageStructuredReferences';
import { StructuredReferencesRow } from '@/components/sessions/transcript/references/StructuredReferencesRow';
import { ComposerAttachmentFallbackRow } from '@/components/sessions/transcript/composerAttachments/ComposerAttachmentFallbackRow';
import { useMessageComposerAttachments } from '@/components/sessions/transcript/composerAttachments/messageComposerAttachments';
import { useTranscriptMotion } from '@/components/sessions/transcript/motion/TranscriptMotionContext';
import { ThinkingTimelineRow } from '@/components/sessions/transcript/thinking/ThinkingTimelineRow';
import { TranscriptEventRow } from '@/components/sessions/transcript/events/TranscriptEventRow';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import { parseHappierMetaEnvelope } from '@/components/sessions/transcript/structured/happierMetaEnvelope';
import { AttachmentsMessageMetaV1Schema } from '@/sync/domains/attachments/attachmentsMessageMeta';
import { AttachmentsMessageRow } from '@/components/sessions/attachments/messages/AttachmentsMessageRow';
import { AttachmentsInlineImages } from '@/components/sessions/attachments/messages/AttachmentsInlineImages';
import { parseSessionMediaMessageMeta } from '@/sync/domains/session/media/sessionMediaMessageMeta';
import { SessionMediaInlineImages } from '@/components/sessions/media/SessionMediaInlineImages';
import { resolveSessionMediaInlineRenderableImageMimeType } from '@/components/sessions/media/presentation';
import { canForkFromMessage } from '@/sync/domains/sessionFork/forkUiSupport';
import { resolveForkFromMessageSemantics } from '@/sync/domains/sessionFork/forkFromMessageSemantics';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { normalizeVoiceAgentTurnTranscriptText } from '@happier-dev/agents';
import { readSessionMessageProvenanceV1 } from '@happier-dev/protocol';
import { TranscriptRollbackActionButton } from '@/components/sessions/transcript/TranscriptRollbackActionButton';
import type { TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import { MessageActionRow } from '@/components/sessions/transcript/messageActions/MessageActionRow';
import { PluginMessageActions } from '@/components/sessions/transcript/messageActions/PluginMessageActions';
import { MessagePinButton } from '@/components/sessions/transcript/messageActions/MessagePinButton';
import { RowActionRevealSlot } from '@/components/sessions/transcript/messageActions/RowActionRevealSlot';
import { readCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { resolveMessagePinAvailability } from '@/components/sessions/transcript/messageActions/resolveMessagePinAvailability';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import { resolveToolRowPinAction } from '@/components/sessions/transcript/toolCalls/ToolCallPinAction';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useStreamingTextSmoothing } from '@/components/sessions/transcript/streaming/useStreamingTextSmoothing';
import { readStreamSegmentMetaV1 } from '@/sync/reducer/helpers/streamSegmentMeta';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { openSessionForkStrategyFlow } from '@/components/sessions/fork/openSessionForkStrategyFlow';
import { resolveTranscriptMarkdownFileLink } from '@/components/sessions/transcript/resolveTranscriptMarkdownFileLink';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import { executeTranscriptRollbackAction } from '@/components/sessions/transcript/transcriptRollbackActionRunner';
import {
  deriveTranscriptForkCommonForInteraction,
  type TranscriptForkCommon,
  type TranscriptMessageDisplayCommon,
  type TranscriptToolChromeCommon,
  type TranscriptToolRouteCommon,
  useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import {
  deriveTranscriptInteraction,
  deriveTranscriptInteractionFromSession,
  type TranscriptInteraction,
} from '@/utils/sessions/deriveTranscriptInteraction';
import { useSessionInteractionSource } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { TranscriptJumpAttention } from '@/components/sessions/transcript/navigation/TranscriptJumpHighlightOverlay';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { isRecoveredHistoryTranscriptObservation } from '@/sync/domains/messages/transcriptObservationProvenance';
import type { TranscriptEventEmphasis } from '@/components/sessions/transcript/events/transcriptEventEmphasis';
import { Icon } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';

const FAIL_CLOSED_TRANSCRIPT_INTERACTION = deriveTranscriptInteraction({ kind: 'public' });
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

/**
 * Resolve the text a placeholder row renders: the raw fallback text carries the offending payload
 * type, so it is kept for developer diagnostics and replaced by the localized label otherwise.
 */
function resolveUnsupportedContentText(params: Readonly<{
  presentation: UnsupportedContentPresentation;
  kind: UnsupportedContentKind;
  rawText: string | null | undefined;
}>): string {
  if (params.presentation !== 'diagnostic') return resolveUnsupportedContentLabel(params.kind);
  const raw = typeof params.rawText === 'string' ? params.rawText.trim() : '';
  return raw.length > 0 ? raw : resolveUnsupportedContentLabel(params.kind);
}

function shouldHideVoiceAgentTurnMessage(message: Message): boolean {
    if (message.kind !== 'user-text' && message.kind !== 'agent-text') return false;
    if (message.kind === 'user-text' && message.displayText !== undefined) return false;
    const envelope = parseHappierMetaEnvelope(message.meta);
    if (envelope?.kind !== 'voice_agent_turn.v1') return false;
    const normalizedText = normalizeVoiceAgentTurnTranscriptText(message.text);
    return normalizedText == null || normalizedText.trim().length === 0;
}

function resolveMessageServerId(sessionId: string, fallbackServerId?: string | null): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const resolvedServerId = resolvePreferredServerIdForSessionId(normalizedSessionId) ?? fallbackServerId ?? '';
  const normalizedServerId = String(resolvedServerId).trim();
  return normalizedServerId || null;
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

function PluginMessageAttribution(props: Readonly<{ message: Message }>) {
  const pluginProvenance = React.useMemo(() => {
    if (props.message.kind !== 'user-text') return null;
    const provenance = readSessionMessageProvenanceV1(props.message.meta);
    return provenance?.kind === 'pluginSession' ? provenance : null;
  }, [props.message]);
  if (!pluginProvenance) return null;

  const label = t('message.pluginAttribution', { pluginId: pluginProvenance.pluginId });
  return (
    <Text
      testID={`transcript-plugin-attribution:${props.message.id}`}
      accessibilityRole="text"
      accessibilityLabel={label}
      numberOfLines={1}
      ellipsizeMode="tail"
      style={styles.pluginMessageAttribution}
    >
      {label}
    </Text>
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
type SessionFileDeepLinkRouter = Pick<ReturnType<typeof useRouter>, 'push'>;

function pushSessionFileDeepLink(
  router: SessionFileDeepLinkRouter,
  params: SessionFileDeepLinkParams,
): void {
  const href = buildSessionFileDeepLink(params);
  router.push(href as never);
}

function useStructuredMessageJumpHandler(
  sessionId: string,
  enabled: boolean,
): StructuredMessageRendererParams['onJumpToAnchor'] {
  const router = useRouter();
  const routerRef = React.useRef<SessionFileDeepLinkRouter>(router);
  React.useLayoutEffect(() => {
    routerRef.current = router;
  }, [router]);

  const handler = React.useCallback((target: Parameters<NonNullable<StructuredMessageRendererParams['onJumpToAnchor']>>[0]) => {
    pushSessionFileDeepLink(routerRef.current, {
      sessionId,
      filePath: target.filePath,
      source: target.source,
      anchor: target.anchor,
    });
  }, [sessionId]);
  return enabled ? handler : undefined;
}

type MessageViewProps = {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
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
  interaction?: TranscriptInteraction;
};

export const MessageView = React.memo(function MessageView(props: MessageViewProps) {
  const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
  // Subscription width: this is a per-row hook, so a whole-record subscription made every
  // mounted row re-render on turn-lifecycle churn. `presence` was passed but
  // `deriveTranscriptInteractionFromSession` never reads it, so the narrow source drops it.
  const interactionSource = useSessionInteractionSource(props.sessionId);
  const sessionInteraction = React.useMemo(() => interactionSource
    ? deriveTranscriptInteractionFromSession(interactionSource)
    : undefined, [interactionSource]);
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
  const interaction = props.interaction ?? FAIL_CLOSED_TRANSCRIPT_INTERACTION;
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
        <PluginMessageAttribution message={props.message} />
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
  forkCommon: TranscriptForkCommon;
  isForkAllowed: () => boolean;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
  toolChromeCommon: TranscriptToolChromeCommon;
  toolRouteCommon: TranscriptToolRouteCommon;
}): React.ReactElement | null {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
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
          sessionId={props.sessionId}
          routeMessageId={buildMessageRouteId(props.message)}
          seq={resolveTranscriptMessageSeq(props.message)}
          radius={TRANSCRIPT_EVENT_ROW_HIGHLIGHT_RADIUS}
          style={styles.eventHighlightSurface}
        >
          <TranscriptEventRow
            event={props.message.event}
            localId={props.message.localId}
            sessionId={props.sessionId}
            emphasis={props.eventEmphasis}
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
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const [isActionRowFocused, setIsActionRowFocused] = React.useState(false);
  const handleActionsFocus = React.useCallback(() => setIsActionRowFocused(true), []);
  const handleActionsBlur = React.useCallback(() => setIsActionRowFocused(false), []);
  const isWeb = Platform.OS === 'web';
	  const router = useRouter();
	  const isDiscarded = isCommittedMessageDiscarded(props.metadata, props.message.localId);
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId, props.canOpenFiles);

  const isVoiceAgentTurn = React.useMemo(() => {
    const envelope = parseHappierMetaEnvelope(props.message.meta);
    return envelope?.kind === 'voice_agent_turn.v1';
  }, [props.message.meta]);

  const structuredNode = renderStructuredMessage({
	    message: props.message,
	    sessionId: props.sessionId,
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
  const handleOpenSessionMediaPath = React.useCallback((filePath: string) => {
    pushSessionFileDeepLink(router, { sessionId: props.sessionId, filePath });
  }, [props.sessionId, router]);
  const isStructuredOnly = structuredNode != null;

  const attachmentsMeta = React.useMemo(() => {
    const primaryEnvelope = parseHappierMetaEnvelope(props.message.meta);
    const envelope = primaryEnvelope?.kind === 'attachments.v1'
      ? primaryEnvelope
      : parseHappierMetaEnvelope(props.message.meta, 'happierAttachments');
    if (!envelope || envelope.kind !== 'attachments.v1') return null;
    const parsed = AttachmentsMessageMetaV1Schema.safeParse(envelope.payload);
    if (!parsed.success) return null;
    if (parsed.data.attachments.length === 0) return null;
    return parsed.data;
  }, [props.message.meta]);

  const nonImageAttachments = React.useMemo(() => {
    if (!attachmentsMeta) return [];
    return attachmentsMeta.attachments.filter((a) => {
      return resolveSessionMediaInlineRenderableImageMimeType(a) == null;
    });
  }, [attachmentsMeta]);
	  const handleOpenAttachmentPath = React.useCallback((filePath: string) => {
	    pushSessionFileDeepLink(router, { sessionId: props.sessionId, filePath });
	  }, [props.sessionId, router]);

  const unsupportedContentMeta = React.useMemo(
    () => readUnsupportedContentMeta(props.message.meta),
    [props.message.meta],
  );
  const unsupportedContentText = unsupportedContentMeta
    ? resolveUnsupportedContentText({
      presentation: resolveUnsupportedContentPresentation({
        kind: unsupportedContentMeta,
        debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
      }),
      kind: unsupportedContentMeta,
      rawText: props.message.text,
    })
    : null;

  const markdownText = React.useMemo(() => {
    if (unsupportedContentText != null) return unsupportedContentText;
    if (isVoiceAgentTurn && props.message.displayText === undefined) {
      return normalizeVoiceAgentTurnTranscriptText(props.message.text);
    }
    if (props.message.displayText !== undefined) return props.message.displayText;
    if (attachmentsMeta) return stripLegacyAttachmentsBlock(props.message.text);
    return props.message.text;
  }, [attachmentsMeta, isVoiceAgentTurn, props.message.displayText, props.message.text, unsupportedContentText]);
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
        if (!props.canSendMessages) {
          Modal.alert(t('session.sharing.viewOnly'), t('session.sharing.noEditPermission'));
          return;
        }
        await sync.submitMessage(props.sessionId, option.title, undefined, undefined, {
          callerSurface: 'message_option',
        });
      } catch (e) {
        Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
      }
    })(), { tag: 'MessageView.handleOptionPress.userMessage' });
  }, [props.canSendMessages, props.sessionId]);
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
  const showSelectButton = selectionEnabled && showMessageActions;
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
  const {
    sessionForkSupportSource,
    sessionReplayEnabled,
    agentSwitchingEnabled,
    currentAgentCapabilities,
  } = props.forkCommon;
  const workspacePath = props.messageDisplayCommon.workspacePath;
	  const handleMarkdownLinkPress = React.useCallback((url: string) => {
	    if (!props.canOpenFiles) return false;
	    const resolved = resolveTranscriptMarkdownFileLink({ url, workspacePath });
	    if (!resolved) return false;
	    const anchor = resolved.anchor ?? null;
	    pushSessionFileDeepLink(router, {
	      sessionId: props.sessionId,
	      filePath: resolved.filePath,
	      ...(anchor ? { source: 'file' as const, anchor } : {}),
	    });
	    return true;
	  }, [props.canOpenFiles, props.sessionId, router, workspacePath]);
  const seq =
    typeof (props.message as any).seq === 'number' && Number.isFinite((props.message as any).seq)
      ? Math.trunc((props.message as any).seq)
      : null;
  const showForkButton = props.canFork && canForkFromMessage({
    session: sessionForkSupportSource,
    messageSeq: seq,
    replayEnabled: sessionReplayEnabled,
    agentSwitchingEnabled,
    currentAgentCapabilities,
  });
  const forkSemantics = React.useMemo(() => {
    if (seq == null) return null;
    return resolveForkFromMessageSemantics({ message: props.message, messageSeqInclusive: seq });
  }, [props.message, seq]);

  if (isVoiceAgentTurn && (markdownText == null || markdownText.trim().length === 0)) {
    return null;
  }

  // Structured user messages should render as standalone blocks (tool-card style),
  // not inside a chat bubble background, and without echoing displayText fallback.
  if (isStructuredOnly) {
    return (
      <Pressable
        {...(isWeb
          ? {
              onHoverIn: () => setIsMessageHovered(true),
              onHoverOut: () => setIsMessageHovered(false),
            }
          : null)}
      >
        <View
          collapsable={false}
          style={[styles.structuredUserMessageContainer, props.historical ? styles.historicalMessageContainer : null]}
        >
          {selectableMessage ? (
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
            sessionId={props.sessionId}
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
            {isDiscarded ? (
              <Text selectable style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
            ) : null}
          </TranscriptJumpAttention>
          <MessageActionRow
            isWeb={isWeb}
            messageId={props.message.id}
            showActions={showMessageActions}
            showPinAction={showPinButton}
            pinAction={hasPinButton ? (
              <MessagePinButton
                availability={messagePinAvailability}
                onTogglePin={props.onToggleMessagePin}
                testID={`transcript-message-pin:${props.message.id}`}
                onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
                invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
              />
            ) : null}
            onActionsFocus={handleActionsFocus}
            onActionsBlur={handleActionsBlur}
            timestampText={timestampText}
            invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
          >
            {props.rollbackAction ? (
              <TranscriptRollbackActionButton
                sessionId={props.sessionId}
                target={props.rollbackAction.target}
                restoredDraftText={props.rollbackAction.restoredDraftText}
                currentAgentCapabilities={props.rollbackAction.currentAgentCapabilities}
                checkpointCodeRollback={props.rollbackAction.checkpointCodeRollback}
                testID={`transcript-message-rollback:${props.message.id}`}
                onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
                style={[
                  styles.rollbackMessageButton,
                  Platform.OS === 'web' ? styles.webActionButton : null,
                  timestampPresentation.invertTimestampAndActions ? styles.webActionButtonInverted : null,
                  timestampPresentation.invertTimestampAndActions ? styles.messageActionButtonInvertedSpacing : null,
                ]}
                pressedStyle={styles.copyMessageButtonPressed}
              />
            ) : null}
            {showForkButton ? (
              <ForkMessageButton
                sessionId={props.sessionId}
                upToSeqInclusive={(forkSemantics?.upToSeqInclusive ?? seq!)}
                restoredDraftText={forkSemantics?.restoredDraftText ?? null}
                messageId={props.message.id}
                forkCommon={props.forkCommon}
                isForkAllowed={props.isForkAllowed}
                onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
                invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
              />
            ) : null}
            {selectableMessage ? (
              <SelectMessageButton
                messageId={props.message.id}
                enabled={selectionEnabled}
                visible={showSelectButton}
                role={selectableMessage.role}
                previewText={selectableMessage.text}
                testID={`transcript-message-select:${props.message.id}`}
                onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
                invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
              />
            ) : null}
            <PluginMessageActions
              messageActionReference={props.message.messageActionReference}
              invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
            />
            <CopyMessageButton
              markdown={copyText}
              testID={`transcript-message-copy:${props.message.id}`}
              onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
              onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
              invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
            />
          </MessageActionRow>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      {...(isWeb
        ? {
            onHoverIn: () => setIsMessageHovered(true),
            onHoverOut: () => setIsMessageHovered(false),
          }
        : null)}
    >
      <View
        collapsable={false}
        style={[styles.userMessageContainer, props.historical ? styles.historicalMessageContainer : null]}
      >
        {selectableMessage ? (
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
          <TranscriptJumpAttention
            sessionId={props.sessionId}
            routeMessageId={buildMessageRouteId(props.message)}
            seq={resolveTranscriptMessageSeq(props.message)}
            radius={TRANSCRIPT_MESSAGE_HIGHLIGHT_RADIUS}
            style={[styles.userMessageBubble, isDiscarded ? styles.userMessageBubbleDiscarded : null]}
          >
            <StructuredMessageBlock
              message={props.message as any}
	              sessionId={props.sessionId}
                  interaction={props.interaction}
	              onJumpToAnchor={handleJumpToAnchor}
	              debugInformationEnabled={props.messageDisplayCommon.debugInformationEnabled}
	            />
            <MarkdownView markdown={renderedMarkdownText} renderCacheKey={buildMessageMarkdownRenderCacheKey(props.message.id, props.messageRevision)} onOptionPress={handleOptionPress} onOptionLongPress={handleOptionLongPress} onLinkPress={handleMarkdownLinkPress} selectable={true} profile="transcript" textStyle={styles.transcriptMarkdownText} />
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
                references={structuredReferences}
                fileOpenEnabled={props.canOpenFiles}
              />
            ) : null}
            {isDiscarded && (
              <Text selectable style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
            )}
          </TranscriptJumpAttention>
          </View>
          <MessageActionRow
            isWeb={isWeb}
            messageId={props.message.id}
            showActions={showMessageActions}
            showPinAction={showPinButton}
            pinAction={hasPinButton ? (
              <MessagePinButton
                availability={messagePinAvailability}
                onTogglePin={props.onToggleMessagePin}
                testID={`transcript-message-pin:${props.message.id}`}
                onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
                invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
              />
            ) : null}
            onActionsFocus={handleActionsFocus}
            onActionsBlur={handleActionsBlur}
            timestampText={timestampText}
            invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
          >
            {props.rollbackAction ? (
              <TranscriptRollbackActionButton
                sessionId={props.sessionId}
                target={props.rollbackAction.target}
                restoredDraftText={props.rollbackAction.restoredDraftText}
                currentAgentCapabilities={props.rollbackAction.currentAgentCapabilities}
                checkpointCodeRollback={props.rollbackAction.checkpointCodeRollback}
                testID={`transcript-message-rollback:${props.message.id}`}
                onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
                style={[
                  styles.rollbackMessageButton,
                  Platform.OS === 'web' ? styles.webActionButton : null,
                  timestampPresentation.invertTimestampAndActions ? styles.webActionButtonInverted : null,
                  timestampPresentation.invertTimestampAndActions ? styles.messageActionButtonInvertedSpacing : null,
                ]}
                pressedStyle={styles.copyMessageButtonPressed}
              />
            ) : null}
            {showForkButton ? (
              <ForkMessageButton
                sessionId={props.sessionId}
                upToSeqInclusive={(forkSemantics?.upToSeqInclusive ?? seq!)}
                restoredDraftText={forkSemantics?.restoredDraftText ?? null}
                messageId={props.message.id}
                forkCommon={props.forkCommon}
                isForkAllowed={props.isForkAllowed}
                onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
                invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
              />
            ) : null}
            {selectableMessage ? (
              <SelectMessageButton
                messageId={props.message.id}
                enabled={selectionEnabled}
                visible={showSelectButton}
                role={selectableMessage.role}
                previewText={selectableMessage.text}
                testID={`transcript-message-select:${props.message.id ?? props.message.localId}`}
                onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
                invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
              />
            ) : null}
            <PluginMessageActions
              messageActionReference={props.message.messageActionReference}
              invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
            />
            <CopyMessageButton
              markdown={copyText}
              testID={`transcript-message-copy:${props.message.id ?? props.message.localId}`}
              onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
              onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
              invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
            />
          </MessageActionRow>
        </View>
      </View>
    </Pressable>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  metadata: Metadata | null;
  sessionId: string;
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
}) {
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const [isActionRowFocused, setIsActionRowFocused] = React.useState(false);
  const handleActionsFocus = React.useCallback(() => setIsActionRowFocused(true), []);
  const handleActionsBlur = React.useCallback(() => setIsActionRowFocused(false), []);
  const isWeb = Platform.OS === 'web';
  const usesLongPressRollbackContextMenu = !isWeb && props.rollbackAction != null;
  const contextMenuAnchorRef = React.useRef<View>(null);
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const fallbackTextSelectable = shouldEnableFallbackTextNativeSelection(Platform.OS);
	  const router = useRouter();
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId, props.canOpenFiles);
	  const isVoiceAgentTurn = React.useMemo(() => {
    const envelope = parseHappierMetaEnvelope(props.message.meta);
    return envelope?.kind === 'voice_agent_turn.v1';
  }, [props.message.meta]);
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
        interaction: props.interaction,
	    onJumpToAnchor: handleJumpToAnchor,
	    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
	  });
  const isStructuredOnly = structuredNode != null;
  const agentUnsupportedContentMeta = readUnsupportedContentMeta(props.message.meta);
  const agentUnsupportedContentText = agentUnsupportedContentMeta
    ? resolveUnsupportedContentText({
      presentation: resolveUnsupportedContentPresentation({
        kind: agentUnsupportedContentMeta,
        debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
      }),
      kind: agentUnsupportedContentMeta,
      rawText: props.message.text,
    })
    : null;
  const baseMarkdownText = agentUnsupportedContentText != null
    ? agentUnsupportedContentText
    : isVoiceAgentTurn
      ? normalizeVoiceAgentTurnTranscriptText(props.message.text)
      : props.message.text;
  if (agentUnsupportedContentText == null && isVoiceAgentTurn && baseMarkdownText == null) {
    return null;
  }
  const markdownSource = baseMarkdownText ?? props.message.text;
  const markdown = (agentUnsupportedContentText == null && props.message.isThinking)
    ? unwrapLegacyThinkingWrapper(markdownSource)
    : markdownSource;
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
        if (!props.canSendMessages) {
          Modal.alert(t('session.sharing.viewOnly'), t('session.sharing.noEditPermission'));
          return;
        }
        await sync.submitMessage(props.sessionId, option.title, undefined, undefined, {
          callerSurface: 'message_option',
        });
      } catch (e) {
        Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
      }
    })(), { tag: 'MessageView.handleOptionPress.agentMessage' });
  }, [props.canSendMessages, props.sessionId]);
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

  if (props.message.isThinking && sessionThinkingDisplayMode === 'hidden') {
    return null;
  }

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
  const showSelectButton = selectionEnabled && showMessageActions;
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
  const {
    sessionForkSupportSource,
    sessionReplayEnabled,
    agentSwitchingEnabled,
    currentAgentCapabilities,
  } = props.forkCommon;
  const workspacePath = props.messageDisplayCommon.workspacePath;
	  const handleMarkdownLinkPress = React.useCallback((url: string) => {
	    if (!props.canOpenFiles) return false;
	    const resolved = resolveTranscriptMarkdownFileLink({ url, workspacePath });
	    if (!resolved) return false;
	    const anchor = resolved.anchor ?? null;
	    pushSessionFileDeepLink(router, {
	      sessionId: props.sessionId,
	      filePath: resolved.filePath,
	      ...(anchor ? { source: 'file' as const, anchor } : {}),
	    });
	    return true;
	  }, [props.canOpenFiles, props.sessionId, router, workspacePath]);
  const seq =
    typeof (props.message as any).seq === 'number' && Number.isFinite((props.message as any).seq)
      ? Math.trunc((props.message as any).seq)
      : null;
  const showForkButton = props.canFork && canForkFromMessage({
    session: sessionForkSupportSource,
    messageSeq: seq,
    replayEnabled: sessionReplayEnabled,
    agentSwitchingEnabled,
    currentAgentCapabilities,
  });
  const forkSemantics = React.useMemo(() => {
    if (seq == null) return null;
    return resolveForkFromMessageSemantics({ message: props.message, messageSeqInclusive: seq });
  }, [props.message, seq]);
  const rollbackContextMenuExecutor = React.useMemo(
    () => usesLongPressRollbackContextMenu
      ? createDefaultActionExecutor({
          resolveServerIdForSessionId: (sessionId) =>
            resolveMessageServerId(sessionId, sessionForkSupportSource?.serverId),
          currentAgentCapabilities: props.rollbackAction?.currentAgentCapabilities,
        })
      : null,
    [props.rollbackAction?.currentAgentCapabilities, sessionForkSupportSource?.serverId, usesLongPressRollbackContextMenu],
  );
  const rollbackContextMenuItems = React.useMemo((): ContextMenuItem[] => {
    if (!usesLongPressRollbackContextMenu || !props.rollbackAction) return [];
    const title = props.rollbackAction.target?.type === 'before_user_message'
      ? t('session.rollback.beforeUserMessageA11y')
      : t('session.rollback.latestTurnA11y');
    return [{ id: 'rollback', title }];
  }, [props.rollbackAction, usesLongPressRollbackContextMenu]);
  const handleRollbackContextMenuSelect = React.useCallback((itemId: string) => {
    setContextMenuOpen(false);
    if (itemId !== 'rollback' || !props.rollbackAction || !rollbackContextMenuExecutor) return;
    fireAndForget((async () => {
      try {
        await executeTranscriptRollbackAction({
          checkpointCodeRollback: props.rollbackAction?.checkpointCodeRollback,
          executor: rollbackContextMenuExecutor,
          restoredDraftText: props.rollbackAction?.restoredDraftText,
          sessionId: props.sessionId,
          target: props.rollbackAction?.target,
        });
      } catch (error) {
        Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
      }
    })(), { tag: 'MessageView.contextMenu.rollback.agentText' });
  }, [props.rollbackAction, props.sessionId, rollbackContextMenuExecutor]);
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
    enabled: !shouldRenderStreamingPlain,
  });
  const handleOpenAgentSessionMediaPath = React.useCallback((filePath: string) => {
    pushSessionFileDeepLink(router, { sessionId: props.sessionId, filePath });
  }, [props.sessionId, router]);
  const agentSessionMediaMeta = React.useMemo(() => {
    const primaryEnvelope = parseHappierMetaEnvelope(props.message.meta);
    const envelope = primaryEnvelope?.kind === 'session_media.v1'
      ? primaryEnvelope
      : parseHappierMetaEnvelope(props.message.meta, 'happierMedia');
    return parseSessionMediaMessageMeta(envelope);
  }, [props.message.meta]);

  return (
    <Pressable
      onLongPress={rollbackContextMenuItems.length > 0 ? () => setContextMenuOpen(true) : undefined}
      {...(isWeb
        ? {
            onHoverIn: () => setIsMessageHovered(true),
            onHoverOut: () => setIsMessageHovered(false),
          }
        : null)}
    >
      <TranscriptJumpAttention
        sessionId={props.sessionId}
        routeMessageId={buildMessageRouteId(props.message)}
        seq={resolveTranscriptMessageSeq(props.message)}
        radius={TRANSCRIPT_AGENT_BLOCK_HIGHLIGHT_RADIUS}
        viewRef={contextMenuAnchorRef}
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
        {selectableMessage ? (
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
                      {streaming.displayText}
                  </Text>
              ) : (
                  <MarkdownView
                      markdown={markdown}
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
        {structuredReferencesDeferred.length > 0 && !isStructuredOnly ? (
          <StructuredReferencesRow
            sessionId={props.sessionId}
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
        <MessageActionRow
          isWeb={isWeb}
          messageId={props.message.id}
          showActions={showMessageActions}
          showPinAction={showPinButton}
          pinAction={hasPinButton ? (
            <MessagePinButton
              availability={messagePinAvailability}
              onTogglePin={props.onToggleMessagePin}
              testID={`transcript-message-pin:${props.message.id}`}
              onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
              onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
              invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
            />
          ) : null}
          onActionsFocus={handleActionsFocus}
          onActionsBlur={handleActionsBlur}
          timestampText={timestampText}
          invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
        >
            {props.rollbackAction ? (
            <TranscriptRollbackActionButton
              sessionId={props.sessionId}
              target={props.rollbackAction.target}
              restoredDraftText={props.rollbackAction.restoredDraftText}
              currentAgentCapabilities={props.rollbackAction.currentAgentCapabilities}
              checkpointCodeRollback={props.rollbackAction.checkpointCodeRollback}
              testID={`transcript-message-rollback:${props.message.id}`}
              onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
              onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
              style={[
                styles.rollbackMessageButton,
                Platform.OS === 'web' ? styles.webActionButton : null,
                timestampPresentation.invertTimestampAndActions ? styles.webActionButtonInverted : null,
                timestampPresentation.invertTimestampAndActions ? styles.messageActionButtonInvertedSpacing : null,
              ]}
              pressedStyle={styles.copyMessageButtonPressed}
            />
            ) : null}
            {showForkButton ? (
            <ForkMessageButton
              sessionId={props.sessionId}
              upToSeqInclusive={(forkSemantics?.upToSeqInclusive ?? seq!)}
              restoredDraftText={forkSemantics?.restoredDraftText ?? null}
              messageId={props.message.id}
              forkCommon={props.forkCommon}
              isForkAllowed={props.isForkAllowed}
              onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
              onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
              invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
            />
          ) : null}
          {selectableMessage ? (
            <SelectMessageButton
              messageId={props.message.id}
              enabled={selectionEnabled}
              visible={showSelectButton}
              role={selectableMessage.role}
              previewText={selectableMessage.text}
              testID={`transcript-message-select:${props.message.id}`}
              onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
              onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
              invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
            />
          ) : null}
          <PluginMessageActions
            messageActionReference={props.message.messageActionReference}
            invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
          />
          <CopyMessageButton
            markdown={copyText}
            testID={`transcript-message-copy:${props.message.id}`}
            onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
            invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
          />
        </MessageActionRow>
      </TranscriptJumpAttention>
      {rollbackContextMenuItems.length > 0 ? (
        <ContextMenu
          open={contextMenuOpen}
          onOpenChange={setContextMenuOpen}
          anchorRef={contextMenuAnchorRef}
          items={rollbackContextMenuItems}
          onSelect={handleRollbackContextMenuSelect}
          placement="auto"
          variant="slim"
          showCategoryTitles={false}
          maxWidthCap={260}
        />
      ) : null}
    </Pressable>
  );
}

function ForkMessageButton(props: {
  sessionId: string;
  upToSeqInclusive: number;
  restoredDraftText?: string | null;
  messageId: string;
  forkCommon: TranscriptForkCommon;
  isForkAllowed: () => boolean;
  invertedActionsLayout?: boolean;
  onHoverIn?: () => void;
  onHoverOut?: () => void;
}) {
  const { theme } = useUnistyles();
  const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
  const router = useRouter();
  const sessionForkSupportSource = props.forkCommon.sessionForkSupportSource;
  const sessionForkOwnerMetadata = sessionForkSupportSource
    ? readSessionOwnerMetadataView(sessionForkSupportSource)
    : null;
  const executionRunsEnabled = props.forkCommon.executionRunsEnabled;
  const agentSwitchingEnabled = props.forkCommon.agentSwitchingEnabled;
  const sessionReplayEnabled = props.forkCommon.sessionReplayEnabled;
  const sessionReplayStrategy = props.forkCommon.sessionReplayStrategy;
  const sessionReplaySummaryRunner = props.forkCommon.sessionReplaySummaryRunnerV1;
  const sessionReplayMaxSeedChars = props.forkCommon.sessionReplayMaxSeedChars;

  // A launcher only. Choosing Native, Replay or Configure happens before any
  // fork effect is issued, and the modal — not this button — owns the progress
  // of the operation it starts.
  const handlePress = React.useCallback(() => {
    if (!props.isForkAllowed()) return;
    const reachableMachineTarget = readMachineTargetForSession(props.sessionId);
    const serverId = resolveMessageServerId(props.sessionId, sessionForkSupportSource?.serverId) ?? null;
    const restored = typeof props.restoredDraftText === 'string' ? props.restoredDraftText : null;
    openSessionForkStrategyFlow({
      sessionId: props.sessionId,
      forkSupportSource: sessionForkSupportSource,
      serverId,
      machineId: reachableMachineTarget?.machineId ?? sessionForkOwnerMetadata?.machineId ?? null,
      forkPoint: { type: 'seq', upToSeqInclusive: props.upToSeqInclusive },
      settings: {
        sessionReplayEnabled,
        sessionReplayMaxSeedChars,
        sessionReplayStrategy,
        sessionReplaySummaryRunnerV1: sessionReplaySummaryRunner,
      },
      replayEnabled: sessionReplayEnabled,
      currentAgentCapabilities: props.forkCommon.currentAgentCapabilities,
      executionRunsEnabled,
      agentSwitchingEnabled,
      restoredDraftText: restored,
      sourceMessageId: props.messageId,
      sourcePreview: restored,
      writeForkInitialPrompt: true,
      navigateToSession: (childSessionId, options) => {
        router.push(buildScopedSessionRouteHref({
          sessionId: childSessionId,
          serverId: options?.serverId ?? serverId,
        }) as any);
      },
      navigateToNewSession: (route) => {
        router.push(route as any);
      },
    });
  }, [
    agentSwitchingEnabled,
    executionRunsEnabled,
    props.isForkAllowed,
    props.messageId,
    props.restoredDraftText,
    props.sessionId,
    props.upToSeqInclusive,
    props.forkCommon.currentAgentCapabilities,
    router,
    sessionForkOwnerMetadata?.machineId,
    sessionForkSupportSource,
    sessionReplayEnabled,
    sessionReplayMaxSeedChars,
    sessionReplayStrategy,
    sessionReplaySummaryRunner,
  ]);

  if (!sessionForkSupportSource) return null;

  return (
    <Pressable
      testID={`transcript-message-fork:${props.messageId}`}
      onPress={handlePress}
      onHoverIn={props.onHoverIn}
      onHoverOut={props.onHoverOut}
      accessibilityRole="button"
      accessibilityLabel={t('session.forking.forkFromMessageA11y')}
      style={({ pressed }) => [
        styles.forkMessageButton,
        {
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: minimumInteractiveTargetSize,
          minWidth: minimumInteractiveTargetSize,
        },
        Platform.OS === 'web' ? styles.webActionButton : null,
        props.invertedActionsLayout ? styles.webActionButtonInverted : null,
        props.invertedActionsLayout ? styles.messageActionButtonInvertedSpacing : null,
        pressed && styles.copyMessageButtonPressed,
      ]}
    >
      <Icon
        name="git-branch"
        size={14}
        color={theme.colors.text.secondary}
      />
    </Pressable>
  );
}

function CopyMessageButton(props: { markdown: string; testID?: string; invertedActionsLayout?: boolean; onHoverIn?: () => void; onHoverOut?: () => void }) {
  const { theme } = useUnistyles();
  const [copied, setCopied] = React.useState(false);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

  const markdown = props.markdown || '';
  const isCopyable = markdown.trim().length > 0;

  const handlePress = React.useCallback(async () => {
    if (!isCopyable) return;

    try {
      const ok = await setClipboardStringSafe(markdown);
      if (!ok) {
        Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
        return;
      }
      setCopied(true);

      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
      resetTimer.current = setTimeout(() => {
        setCopied(false);
      }, 1200);
    } catch (error) {
      Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
    }
  }, [isCopyable, markdown]);

  React.useEffect(() => {
    return () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  if (!isCopyable) {
    return null;
  }

  return (
    <Pressable
      testID={props.testID}
      onPress={handlePress}
      onHoverIn={props.onHoverIn}
      onHoverOut={props.onHoverOut}
      accessibilityRole="button"
      accessibilityLabel={t('common.copy')}
      style={({ pressed }) => [
        styles.copyMessageButton,
        {
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: minimumInteractiveTargetSize,
          minWidth: minimumInteractiveTargetSize,
        },
        Platform.OS === 'web' ? styles.webActionButton : null,
        props.invertedActionsLayout ? styles.webActionButtonInverted : null,
        pressed && styles.copyMessageButtonPressed,
      ]}
    >
      <Icon
        name={copied ? "check" : "copy"}
        size={14}
        color={copied ? theme.colors.state.success.foreground : theme.colors.text.secondary}
      />
    </Pressable>
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
	  const router = useRouter();
  const structuredPinHost = useRowActionHoverHost();
  const handleJumpToAnchor = useStructuredMessageJumpHandler(
    props.sessionId,
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
        interaction: props.interaction,
	    onJumpToAnchor: handleJumpToAnchor,
	    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
	  });
  const toolForSession = resolveInactiveSessionToolCallFailure({
    tool: props.message.tool,
    permissionDisabledReason: props.interaction.permissionDisabledReason,
  });
  const statusKind = resolveToolStatusIndicatorKind(toolForSession);
  const shouldForceToolChromeForStatus = statusKind === 'error' || statusKind === 'permission_blocked';
  const shouldRenderToolChrome = !(
    toolViewTimelineChromeMode === 'activity_feed' &&
    structuredNode != null &&
    !shouldForceToolChromeForStatus
  );
  const toolRouteMessageId = props.interaction.disableToolNavigation
    ? undefined
    : resolveMessageRouteIdForDisplay({
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
    pushSessionFileDeepLink(router, { sessionId: props.sessionId, filePath });
  }, [props.sessionId, router]);
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
          messageId={toolRouteMessageId}
          jumpHighlightSeq={toolSeq}
          headerAction={toolPinAction}
          approvalRequests={props.approvalRequests}
          forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
          interaction={props.interaction}
        />
      ) : (
        <ToolView
          tool={props.message.tool}
          metadata={props.metadata}
          messages={props.message.children}
          sessionId={props.sessionId}
          messageId={toolRouteMessageId}
          jumpHighlightSeq={toolSeq}
          headerAction={toolPinAction}
          approvalRequests={props.approvalRequests}
          forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
          interaction={props.interaction}
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
        sessionId={props.sessionId}
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
  pluginMessageAttribution: {
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
    paddingBottom: 22,
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
      paddingBottom: 22,
    },
    userMessageBubbleAligner: {
      // Hug + right-align the bubble within the full-width wrapper. The bubble itself stays
      // a default-stretch child of this aligner so its text wraps at a bounded width on
      // native (a flex-end/auto-width bubble would measure text at max-content and overflow
      // on one line, since maxWidth:'100%' only clamps the box, it does not bound the text).
      alignSelf: 'flex-end',
      maxWidth: '100%',
    },
    userMessageBubble: {
      backgroundColor: theme.colors.message.user.background,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: theme.borderRadius.xl,
      maxWidth: '100%',
    },
  userStructuredMessageWrapper: {
    maxWidth: '100%',
  },
  userMessageBubbleDiscarded: {
    opacity: 0.65,
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
    paddingBottom: 22,
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
    paddingBottom: 22,
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
  webActionButton: {
    padding: 6,
  },
  webActionButtonInverted: {
    paddingHorizontal: 4,
  },
  messageActionButtonInvertedSpacing: {
    marginRight: 2,
  },
  forkMessageButton: {
    padding: 2,
    borderRadius: 6,
    opacity: 0.6,
    cursor: 'pointer',
    marginRight: 6,
  },
  rollbackMessageButton: {
    padding: 2,
    borderRadius: 6,
    opacity: 0.6,
    cursor: 'pointer',
    marginRight: 6,
  },
  copyMessageButton: {
    padding: 2,
    borderRadius: 6,
    opacity: 0.6,
    cursor: 'pointer',
  },
  copyMessageButtonPressed: {
    opacity: 1,
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
