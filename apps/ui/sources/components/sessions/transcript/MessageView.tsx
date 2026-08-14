import * as React from "react";
import { View, Pressable, Platform } from 'react-native';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/domains/messages/messageTypes";
import { Metadata } from "@/sync/domains/state/storageTypes";
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { useLayoutMaxWidth } from "@/components/ui/layout/layout";
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import { resolveInactiveSessionToolCallFailure } from '@/components/tools/shell/permissions/resolveInactiveSessionToolCallFailure';
import { buildMessageRouteId, resolveMessageRouteIdForDisplay } from '@/sync/domains/messages/messageRouteIds';
import { sync } from '@/sync/sync';
import { Option, type OptionLongPressHandler } from '@/components/markdown/MarkdownView';
import { isCommittedMessageDiscarded } from "@/utils/sessions/discardedCommittedMessages";
import { shouldShowTranscriptRowActions, shouldShowTranscriptRowPinAction } from '@/components/sessions/transcript/messageCopyVisibility';
import { renderStructuredMessage, StructuredMessageBlock } from '@/components/sessions/transcript/structured/StructuredMessageBlock';
import type { StructuredMessageRendererParams } from '@/components/sessions/transcript/structured/structuredMessageRegistry';
import { usePathname, useRouter } from 'expo-router';
import { buildSessionFileDeepLink } from '@/utils/url/sessionFileDeepLink';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { useMessageStructuredReferences } from '@/components/sessions/transcript/references/messageStructuredReferences';
import { StructuredReferencesRow } from '@/components/sessions/transcript/references/StructuredReferencesRow';
import { useTranscriptMotion } from '@/components/sessions/transcript/motion/TranscriptMotionContext';
import { ThinkingTimelineRow } from '@/components/sessions/transcript/thinking/ThinkingTimelineRow';
import { TranscriptEventRow } from '@/components/sessions/transcript/events/TranscriptEventRow';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import { parseHappierMetaEnvelope } from '@/components/sessions/transcript/structured/happierMetaEnvelope';
import { readUnsupportedContentMeta, type UnsupportedContentKind } from '@/sync/domains/messages/unsupportedContentMeta';
import { resolveUnsupportedContentLabel } from '@/sync/domains/messages/resolveUnsupportedContentLabel';
import {
  resolveUnsupportedContentPresentation,
  type UnsupportedContentPresentation,
} from '@/sync/domains/messages/unsupportedContentPresentation';
import { AttachmentsMessageRow } from '@/components/sessions/attachments/messages/AttachmentsMessageRow';
import { SessionMediaInlineImages } from '@/components/sessions/sessionMedia/SessionMediaInlineImages';
import { SessionMediaUnavailableItems } from '@/components/sessions/sessionMedia/SessionMediaUnavailableItems';
import { parseSessionMediaMessageMeta } from '@/sync/domains/sessionMedia/sessionMediaMessageMeta';
import { forkSession } from '@/sync/ops';
import { canForkFromMessage } from '@/sync/domains/sessionFork/forkUiSupport';
import { resolveForkFromMessageSemantics } from '@/sync/domains/sessionFork/forkFromMessageSemantics';
import { completeSessionForkNavigation } from '@/components/sessions/transcript/forkContext/completeSessionForkNavigation';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';
import { normalizeVoiceAgentTurnTranscriptText } from '@happier-dev/agents';
import { MessageSelectionCheckbox } from '@/components/sessions/transcript/messageSelection/MessageSelectionCheckbox';
import { SelectMessageButton } from '@/components/sessions/transcript/messageSelection/SelectMessageButton';
import { useOptionalTranscriptSelectionRow } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import {
  resolveSelectableMessageText,
  stripLegacyAttachmentsBlock,
  unwrapLegacyThinkingWrapper,
} from '@/components/sessions/transcript/messageSelection/resolveSelectableMessageText';
import { TranscriptRollbackActionButton } from '@/components/sessions/transcript/TranscriptRollbackActionButton';
import { MessageActionRow } from '@/components/sessions/transcript/messageActions/MessageActionRow';
import { MessagePinButton } from '@/components/sessions/transcript/messageActions/MessagePinButton';
import { resolveMessagePinAvailability } from '@/components/sessions/transcript/messageActions/resolveMessagePinAvailability';
import { readCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { RowActionRevealSlot } from '@/components/sessions/transcript/messageActions/RowActionRevealSlot';
import { resolveToolRowPinAction } from '@/components/sessions/transcript/toolCalls/ToolCallPinAction';
import type { TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useStreamingTextSmoothing } from '@/components/sessions/transcript/streaming/useStreamingTextSmoothing';
import { readStreamSegmentMetaV1 } from '@/sync/reducer/helpers/streamSegmentMeta';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
  resolveTranscriptMarkdownFileLink,
} from '@/components/sessions/transcript/resolveTranscriptMarkdownFileLink';
import type {
  TranscriptForkCommon,
  TranscriptMessageDisplayCommon,
  TranscriptToolChromeCommon,
  TranscriptToolRouteCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import {
  deriveTranscriptForkCommonForInteraction,
  useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import { TranscriptJumpAttention } from '@/components/sessions/transcript/navigation/TranscriptJumpHighlightOverlay';
import { getCachedIntlDateTimeFormat } from '@/utils/datetime/cachedIntlFormatters';
import type { TranscriptEventEmphasis } from '@/components/sessions/transcript/events/transcriptEventEmphasis';
import {
  deriveTranscriptInteraction,
  deriveTranscriptInteractionFromSession,
  type TranscriptInteraction,
} from '@/utils/sessions/deriveTranscriptInteraction';
import { useSessionInteractionSource } from '@/sync/domains/state/storage';
import { isRecoveredHistoryTranscriptObservation } from '@/sync/domains/messages/transcriptObservationProvenance';
import { Icon } from '@/components/ui/icons/Icon';

type StreamSegmentStateForRendering = 'streaming' | 'complete' | 'interrupted';
const FAIL_CLOSED_TRANSCRIPT_INTERACTION = deriveTranscriptInteraction({ kind: 'public' });
const TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_TOP = 0;
const TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_RIGHT = 0;
const TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_Z_INDEX = 2;
type SessionFileDeepLinkParams = Parameters<typeof buildSessionFileDeepLink>[0];
type SessionFileDeepLinkRouter = Pick<ReturnType<typeof useRouter>, 'push'>;

function pushSessionFileDeepLink(
  router: SessionFileDeepLinkRouter,
  _currentPathname: string | null | undefined,
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
    pushSessionFileDeepLink(routerRef.current, null, {
      sessionId,
      filePath: target.filePath,
      source: target.source,
      anchor: target.anchor,
    });
  }, [sessionId]);
  return enabled ? handler : undefined;
}

function shouldEnableFallbackTextNativeSelection(platformOS: typeof Platform.OS): boolean {
  return platformOS !== 'ios';
}

function normalizeStreamSegmentStateForRendering(value: unknown): StreamSegmentStateForRendering | null {
  return value === 'streaming' || value === 'complete' || value === 'interrupted' ? value : null;
}

function readStreamSegmentStateForRendering(params: {
  messageMeta: unknown;
  streamSegmentMeta: ReturnType<typeof readStreamSegmentMetaV1>;
}): StreamSegmentStateForRendering | null {
  if (params.streamSegmentMeta && 'segmentState' in params.streamSegmentMeta) {
    return normalizeStreamSegmentStateForRendering(params.streamSegmentMeta.segmentState);
  }

  if (!params.messageMeta || typeof params.messageMeta !== 'object' || Array.isArray(params.messageMeta)) {
    return null;
  }
  const segment = (params.messageMeta as Record<string, unknown>).happierStreamSegmentV1;
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
    return null;
  }
  return normalizeStreamSegmentStateForRendering((segment as Record<string, unknown>).segmentState);
}

function shouldHideVoiceAgentTurnMessage(message: Message): boolean {
    if (message.kind !== 'user-text' && message.kind !== 'agent-text') return false;
    if (message.kind === 'user-text' && message.displayText !== undefined) return false;
    const envelope = parseHappierMetaEnvelope(message.meta);
    if (envelope?.kind !== 'voice_agent_turn.v1') return false;
    const normalizedText = normalizeVoiceAgentTurnTranscriptText(message.text);
    return normalizedText == null || normalizedText.trim().length === 0;
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

function formatTranscriptMessageTimestamp(createdAt: number): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) return null;
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return getCachedIntlDateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
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

const TRANSCRIPT_MESSAGE_HIGHLIGHT_RADIUS = 12;
const TRANSCRIPT_AGENT_BLOCK_HIGHLIGHT_RADIUS = 16;
const TRANSCRIPT_EVENT_ROW_HIGHLIGHT_RADIUS = 10;

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

function buildStreamingMarkdownParseCacheKey(messageId: string, revision: number | null | undefined): string | null {
  if (typeof revision !== 'number' || !Number.isFinite(revision)) return null;
  return `message:${messageId}:revision:${Math.trunc(revision)}`;
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
  onToggleMessagePin?: SessionMessagePinToggleHandler;
  onToggleToolPin?: SessionMessagePinToggleHandler;
  historical?: boolean;
  messageRevision?: number | null;
  eventEmphasis?: TranscriptEventEmphasis;
  interaction?: TranscriptInteraction;
};

// R3: transcript rows are memoized — the message object's identity changes only on revision
// (store in-place contract), and per-row selection state reaches each block through the
// selection store subscription, so a parent/list re-render with stable props must not
// re-render every visible message subtree.
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
  const contentMaxWidth = useLayoutMaxWidth();
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
  if (shouldHideVoiceAgentTurnMessage(props.message)) return null;
  // Placeholders for content we could not render are dropped here rather than inside the message
  // blocks, so toggling developer diagnostics never changes the hook order of a mounted row.
  if (resolveMessageUnsupportedContentPresentation(
    props.message,
    props.messageDisplayCommon.debugInformationEnabled,
  ) === 'hidden') return null;
  return (
    <View style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
      <View style={[styles.messageContent, { maxWidth: contentMaxWidth }]}>
        <RecoveredHistoryIndicator message={props.message} />
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
          onToggleMessagePin={props.onToggleMessagePin}
          onToggleToolPin={props.onToggleToolPin}
          historical={props.historical}
          messageRevision={props.messageRevision}
          eventEmphasis={props.eventEmphasis}
          interaction={interaction}
          canFork={canFork}
          isForkAllowed={isForkAllowed}
          forkCommon={forkCommon}
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
  isForkAllowed: () => boolean;
  rollbackAction?: TranscriptRollbackAction | null;
  messagePins?: readonly PersistedSessionMessagePinV1[];
  onToggleMessagePin?: SessionMessagePinToggleHandler;
  onToggleToolPin?: SessionMessagePinToggleHandler;
  historical?: boolean;
  messageRevision?: number | null;
  eventEmphasis?: TranscriptEventEmphasis;
  forkCommon: TranscriptForkCommon;
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
          isForkAllowed={props.isForkAllowed}
          rollbackAction={props.rollbackAction}
          messagePins={props.messagePins}
          onToggleMessagePin={props.onToggleMessagePin}
          historical={props.historical}
          pinReadOnlyContext={props.interaction.permissionDisabledReason === 'readOnly'}
          forkCommon={props.forkCommon}
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
          isForkAllowed={props.isForkAllowed}
          activeThinkingMessageId={props.activeThinkingMessageId}
          thinkingExpanded={props.thinkingExpanded}
          onThinkingExpandedChange={props.onThinkingExpandedChange}
          rollbackAction={props.rollbackAction}
          messagePins={props.messagePins}
          onToggleMessagePin={props.onToggleMessagePin}
          historical={props.historical}
          messageRevision={props.messageRevision}
          pinReadOnlyContext={props.interaction.permissionDisabledReason === 'readOnly'}
          forkCommon={props.forkCommon}
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
        messagePins={props.messagePins}
        onToggleToolPin={props.onToggleToolPin}
        historical={props.historical}
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
          <TranscriptEventRow event={props.message.event} sessionId={props.sessionId} emphasis={props.eventEmphasis} />
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
  isForkAllowed: () => boolean;
  rollbackAction?: TranscriptRollbackAction | null;
  messagePins?: readonly PersistedSessionMessagePinV1[];
  onToggleMessagePin?: SessionMessagePinToggleHandler;
  historical?: boolean;
  pinReadOnlyContext?: boolean;
  forkCommon: TranscriptForkCommon;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
}) {
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const [isActionRowFocused, setIsActionRowFocused] = React.useState(false);
  const handleActionsFocus = React.useCallback(() => setIsActionRowFocused(true), []);
  const handleActionsBlur = React.useCallback(() => setIsActionRowFocused(false), []);
  const isWeb = Platform.OS === 'web';
  const router = useRouter();
  const pathname = usePathname();
  const isDiscarded = isCommittedMessageDiscarded(props.metadata, props.message.localId);
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId, props.canOpenFiles);

  const isVoiceAgentTurn = React.useMemo(() => {
    const envelope = parseHappierMetaEnvelope(props.message.meta);
    return envelope?.kind === 'voice_agent_turn.v1';
  }, [props.message.meta]);

  const unsupportedContentMeta = React.useMemo(
    () => readUnsupportedContentMeta(props.message.meta),
    [props.message.meta],
  );

  const structuredNode = renderStructuredMessage({
    message: props.message,
    sessionId: props.sessionId,
    interaction: props.interaction,
    onJumpToAnchor: handleJumpToAnchor,
  });
  const isStructuredOnly = structuredNode != null;

  const parsedSessionMediaMeta = React.useMemo(
    () => parseSessionMediaMessageMeta(props.message.meta),
    [props.message.meta],
  );
  const attachmentsMeta = parsedSessionMediaMeta.legacyAttachments;
  const sessionMediaInlineImages = parsedSessionMediaMeta.inlineImages;
  const unavailableSessionMedia = parsedSessionMediaMeta.unavailableMedia;

  const nonImageAttachments = React.useMemo(() => {
    if (!attachmentsMeta) return [];
    return attachmentsMeta.attachments.filter((a) => {
      if (a.mimeType && a.mimeType.startsWith('image/')) return false;
      return getImageMimeTypeFromPath(a.path) == null;
    });
  }, [attachmentsMeta]);
  const handleOpenAttachmentPath = React.useCallback((filePath: string) => {
    pushSessionFileDeepLink(router, pathname, { sessionId: props.sessionId, filePath });
  }, [pathname, props.sessionId, router]);

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

  const structuredReferences = useMessageStructuredReferences({
    meta: props.message.meta,
    text: renderedMarkdownText,
  });

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
  const sessionReplayEnabled = props.forkCommon.sessionReplayEnabled;
  const sessionForkSupportSource = props.forkCommon.sessionForkSupportSource;
  const workspacePath = props.messageDisplayCommon.workspacePath;
  const handleMarkdownLinkPress = React.useCallback((url: string) => {
    if (!props.canOpenFiles) return false;
    const resolved = resolveTranscriptMarkdownFileLink({ url, workspacePath });
    if (!resolved) return false;
    const anchor = resolved.anchor ?? null;
    pushSessionFileDeepLink(router, pathname, {
      sessionId: props.sessionId,
      filePath: resolved.filePath,
      ...(anchor ? { source: 'file' as const, anchor } : {}),
    });
    return true;
  }, [pathname, props.canOpenFiles, props.sessionId, router, workspacePath]);
  const seq = resolveTranscriptMessageSeq(props.message);
  const showForkButton = props.canFork && canForkFromMessage({ session: sessionForkSupportSource, messageSeq: seq, replayEnabled: sessionReplayEnabled });
  const forkSemantics = React.useMemo(() => {
    if (seq == null) return null;
    return resolveForkFromMessageSemantics({ message: props.message, messageSeqInclusive: seq });
  }, [props.message, seq]);
  const messagePinAvailability = React.useMemo(() => resolveMessagePinAvailability({
    sessionId: props.sessionId,
    seq,
    transcriptBlockIndex: resolveTranscriptMessageBlockIndex(props.message),
    routeMessageId: buildMessageRouteId(props.message),
    role: 'user',
    pins: props.messagePins ?? [],
    readOnlyContext: props.pinReadOnlyContext === true,
  }), [props.message, props.messagePins, props.pinReadOnlyContext, props.sessionId, seq]);
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
            seq={seq}
            radius={TRANSCRIPT_MESSAGE_HIGHLIGHT_RADIUS}
            style={styles.structuredUserMessageContent}
          >
            {structuredNode}
            {sessionMediaInlineImages.length > 0 ? (
              <SessionMediaInlineImages
                sessionId={props.sessionId}
                media={sessionMediaInlineImages}
                onOpenPath={handleOpenAttachmentPath}
                fileOpenEnabled={props.canOpenFiles}
                mediaPreviewEnabled={props.canPreviewMedia}
              />
            ) : null}
            <SessionMediaUnavailableItems items={unavailableSessionMedia} />
            {nonImageAttachments.length > 0 ? (
              <AttachmentsMessageRow
                attachments={nonImageAttachments}
                onOpenPath={props.canOpenFiles ? handleOpenAttachmentPath : undefined}
              />
            ) : null}
            {isDiscarded ? (
              <Text selectable style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
            ) : null}
          </TranscriptJumpAttention>
          <MessageActionRow
            messageId={props.message.id}
            timestampText={timestampText}
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
            isWeb={isWeb}
            invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
          >
            {props.rollbackAction ? (
              <TranscriptRollbackActionButton
                sessionId={props.sessionId}
                target={props.rollbackAction.target}
                restoredDraftText={props.rollbackAction.restoredDraftText}
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
              seq={seq}
              radius={TRANSCRIPT_MESSAGE_HIGHLIGHT_RADIUS}
              style={[styles.userMessageBubble, isDiscarded ? styles.userMessageBubbleDiscarded : null]}
            >
              <StructuredMessageBlock
                message={props.message}
                sessionId={props.sessionId}
                interaction={props.interaction}
                onJumpToAnchor={handleJumpToAnchor}
              />
              <MarkdownView markdown={renderedMarkdownText} onOptionPress={handleOptionPress} onOptionLongPress={handleOptionLongPress} onLinkPress={handleMarkdownLinkPress} selectable={true} profile="transcript" textStyle={styles.transcriptMarkdownText} />
              {sessionMediaInlineImages.length > 0 ? (
                <SessionMediaInlineImages
                  sessionId={props.sessionId}
                  media={sessionMediaInlineImages}
                  onOpenPath={handleOpenAttachmentPath}
                  fileOpenEnabled={props.canOpenFiles}
                  mediaPreviewEnabled={props.canPreviewMedia}
                />
              ) : null}
              <SessionMediaUnavailableItems items={unavailableSessionMedia} />
              {nonImageAttachments.length > 0 ? (
                <AttachmentsMessageRow
                  attachments={nonImageAttachments}
                  onOpenPath={props.canOpenFiles ? handleOpenAttachmentPath : undefined}
                />
              ) : null}
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
            messageId={props.message.id}
            timestampText={timestampText}
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
            isWeb={isWeb}
            invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
          >
            {props.rollbackAction ? (
              <TranscriptRollbackActionButton
                sessionId={props.sessionId}
                target={props.rollbackAction.target}
                restoredDraftText={props.rollbackAction.restoredDraftText}
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
  isForkAllowed: () => boolean;
  activeThinkingMessageId: string | null;
  thinkingExpanded?: boolean;
  onThinkingExpandedChange?: (next: boolean) => void;
  rollbackAction?: TranscriptRollbackAction | null;
  messagePins?: readonly PersistedSessionMessagePinV1[];
  onToggleMessagePin?: SessionMessagePinToggleHandler;
  historical?: boolean;
  messageRevision?: number | null;
  pinReadOnlyContext?: boolean;
  forkCommon: TranscriptForkCommon;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
}) {
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const [isActionRowFocused, setIsActionRowFocused] = React.useState(false);
  const handleActionsFocus = React.useCallback(() => setIsActionRowFocused(true), []);
  const handleActionsBlur = React.useCallback(() => setIsActionRowFocused(false), []);
  const isWeb = Platform.OS === 'web';
  const fallbackTextSelectable = shouldEnableFallbackTextNativeSelection(Platform.OS);
  const router = useRouter();
  const pathname = usePathname();
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId, props.canOpenFiles);
  const isVoiceAgentTurn = React.useMemo(() => {
    const envelope = parseHappierMetaEnvelope(props.message.meta);
    return envelope?.kind === 'voice_agent_turn.v1';
  }, [props.message.meta]);
  const unsupportedContentMeta = React.useMemo(
    () => readUnsupportedContentMeta(props.message.meta),
    [props.message.meta],
  );
  const sessionThinkingDisplayMode = props.messageDisplayCommon.sessionThinkingDisplayMode;
  const sessionThinkingInlinePresentation = props.messageDisplayCommon.sessionThinkingInlinePresentation;
  const sessionThinkingInlineChrome = props.messageDisplayCommon.sessionThinkingInlineChrome;
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
  });
  const isStructuredOnly = structuredNode != null;
  const parsedSessionMediaMeta = React.useMemo(
    () => parseSessionMediaMessageMeta(props.message.meta),
    [props.message.meta],
  );
  const sessionMediaInlineImages = parsedSessionMediaMeta.inlineImages;
  const unavailableSessionMedia = parsedSessionMediaMeta.unavailableMedia;
  const handleOpenMediaPath = React.useCallback((filePath: string) => {
    pushSessionFileDeepLink(router, pathname, { sessionId: props.sessionId, filePath });
  }, [pathname, props.sessionId, router]);
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
  const baseMarkdownText = unsupportedContentText != null
    ? unsupportedContentText
    : isVoiceAgentTurn
      ? normalizeVoiceAgentTurnTranscriptText(props.message.text)
      : props.message.text;
  if (!unsupportedContentMeta && isVoiceAgentTurn && baseMarkdownText == null) {
    return null;
  }
  const markdownSource = baseMarkdownText ?? props.message.text;
  const markdown = (!unsupportedContentMeta && props.message.isThinking)
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
    return base && unsupportedContentText != null ? { ...base, text: unsupportedContentText } : base;
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

  const sessionReplayEnabled = props.forkCommon.sessionReplayEnabled;
  const sessionForkSupportSource = props.forkCommon.sessionForkSupportSource;
  const workspacePath = props.messageDisplayCommon.workspacePath;
  const handleMarkdownLinkPress = React.useCallback((url: string) => {
    if (!props.canOpenFiles) return false;
    const resolved = resolveTranscriptMarkdownFileLink({ url, workspacePath });
    if (!resolved) return false;
    const anchor = resolved.anchor ?? null;
    pushSessionFileDeepLink(router, pathname, {
      sessionId: props.sessionId,
      filePath: resolved.filePath,
      ...(anchor ? { source: 'file' as const, anchor } : {}),
    });
    return true;
  }, [pathname, props.canOpenFiles, props.sessionId, router, workspacePath]);
  const seq = resolveTranscriptMessageSeq(props.message);
  const showForkButton = props.canFork && canForkFromMessage({ session: sessionForkSupportSource, messageSeq: seq, replayEnabled: sessionReplayEnabled });
  const forkSemantics = React.useMemo(() => {
    if (seq == null) return null;
    return resolveForkFromMessageSemantics({ message: props.message, messageSeqInclusive: seq });
  }, [props.message, seq]);
  const messagePinAvailability = React.useMemo(() => resolveMessagePinAvailability({
    sessionId: props.sessionId,
    seq,
    transcriptBlockIndex: resolveTranscriptMessageBlockIndex(props.message),
    routeMessageId: buildMessageRouteId(props.message),
    role: 'assistant',
    pins: props.messagePins ?? [],
    readOnlyContext: props.pinReadOnlyContext === true,
  }), [props.message, props.messagePins, props.pinReadOnlyContext, props.sessionId, seq]);
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
  const renderThinkingAsToolCard = props.message.isThinking && sessionThinkingDisplayMode === 'tool';
  const renderThinkingInline = props.message.isThinking === true && !renderThinkingAsToolCard;
    const normalizedThinkingInlinePresentation: 'full' | 'summary' =
      sessionThinkingInlinePresentation === 'full' ? 'full' : 'summary';
    const normalizedThinkingInlineChrome: 'plain' | 'card' =
      sessionThinkingInlineChrome === 'plain' ? 'plain' : 'card';
    const thinkingMarkdownTextStyle =
      normalizedThinkingInlineChrome === 'card' ? styles.thinkingMarkdownTextCard : styles.thinkingMarkdownText;

  const transcriptStreamingSmoothingEnabledRaw = props.messageDisplayCommon.transcriptStreamingSmoothingEnabled;
  const transcriptStreamingSettleDelayMsRaw = props.messageDisplayCommon.transcriptStreamingSettleDelayMs;
  const transcriptStreamingPartialOutputEnabledRaw = props.messageDisplayCommon.transcriptStreamingPartialOutputEnabled;
  const transcriptStreamingMarkdownRenderingEnabledRaw = props.messageDisplayCommon.transcriptStreamingMarkdownRenderingEnabled;
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
    streamSegmentMeta?.segmentKind === 'assistant'
      ? readStreamSegmentStateForRendering({ messageMeta: props.message.meta, streamSegmentMeta })
      : null;
  const streamSegmentAssistantStreaming =
    streamSegmentMeta?.segmentKind === 'assistant'
      ? streamSegmentAssistantState === 'streaming' || streamSegmentAssistantState === null
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
  const renderedAgentText = shouldHidePartialStreamingOutput ? '...' : markdown;
  // Thinking text streams append-only exactly like assistant text and shares
  // the one pacer instance; only the render-path swap below stays
  // assistant-only (thinking keeps its own renderers).
  const streamingSmoothingEligible =
    transcriptStreamingSmoothingEnabled === true &&
    motion?.config.preset !== 'off' &&
    props.historical !== true &&
    isStructuredOnly !== true &&
    (streamSegmentMeta ? streamSegmentAssistantStreaming === true : true);
  const streaming = useStreamingTextSmoothing({
    enabled: streamingSmoothingEligible,
    targetText: renderedAgentText,
    settleDelayMs: transcriptStreamingSettleDelayMs,
  });
  const thinkingRenderMarkdown =
    props.message.isThinking === true && streamingSmoothingEligible ? streaming.displayText : markdown;
  const thinkingStreamingActive =
    props.message.isThinking === true && streamingSmoothingEligible && streaming.isStreaming;
  const shouldRenderStreamingPlain = shouldRenderActiveStreamSegmentPlain || (props.message.isThinking !== true && streaming.isStreaming);
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
  const structuredReferences = useMessageStructuredReferences({
    meta: props.message.meta,
    text: markdown,
    enabled: !shouldRenderStreamingPlain,
  });

  return (
    <Pressable
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
        seq={seq}
        radius={TRANSCRIPT_AGENT_BLOCK_HIGHLIGHT_RADIUS}
        viewProps={{
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
                    onOptionPress={handleOptionPress}
                    onOptionLongPress={handleOptionLongPress}
                    onLinkPress={handleMarkdownLinkPress}
                    selectable={true}
                    profile="thinking"
                    textStyle={thinkingMarkdownTextStyle}
                    {...(thinkingStreamingActive
                      ? {
                          streamingMode: 'streaming' as const,
                          streamingParseCacheKey: buildStreamingMarkdownParseCacheKey(props.message.id, props.messageRevision),
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
                  onOptionPress={handleOptionPress}
                  onOptionLongPress={handleOptionLongPress}
                  onLinkPress={handleMarkdownLinkPress}
                  selectable={true}
                  profile="transcript"
                  textStyle={styles.transcriptMarkdownText}
                  streamingMode="streaming"
                  streamingParseCacheKey={buildStreamingMarkdownParseCacheKey(props.message.id, props.messageRevision)}
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
        {structuredReferences.length > 0 && !isStructuredOnly ? (
          <StructuredReferencesRow
            sessionId={props.sessionId}
            references={structuredReferences}
            fileOpenEnabled={props.canOpenFiles}
          />
        ) : null}
        {sessionMediaInlineImages.length > 0 ? (
          <SessionMediaInlineImages
            sessionId={props.sessionId}
            media={sessionMediaInlineImages}
            onOpenPath={handleOpenMediaPath}
            fileOpenEnabled={props.canOpenFiles}
            mediaPreviewEnabled={props.canPreviewMedia}
          />
        ) : null}
        <SessionMediaUnavailableItems items={unavailableSessionMedia} />
        <MessageActionRow
          messageId={props.message.id}
          timestampText={timestampText}
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
          isWeb={isWeb}
          invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
        >
          {props.rollbackAction ? (
            <TranscriptRollbackActionButton
              sessionId={props.sessionId}
              target={props.rollbackAction.target}
              restoredDraftText={props.rollbackAction.restoredDraftText}
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
          <CopyMessageButton
            markdown={copyText}
            testID={`transcript-message-copy:${props.message.id}`}
            onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
            invertedActionsLayout={timestampPresentation.invertTimestampAndActions}
          />
        </MessageActionRow>
      </TranscriptJumpAttention>
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
  const router = useRouter();
  const sessionForkSupportSource = props.forkCommon.sessionForkSupportSource;
  const [isForking, setIsForking] = React.useState(false);
  const hitSlop = Platform.OS === 'web' ? undefined : 15;
  const executionRunsEnabled = props.forkCommon.executionRunsEnabled;
  const sessionReplayStrategy = props.forkCommon.sessionReplayStrategy;
  const sessionReplaySummaryRunner = props.forkCommon.sessionReplaySummaryRunnerV1;
  const sessionReplayMaxSeedChars = props.forkCommon.sessionReplayMaxSeedChars;

  const handlePress = React.useCallback(async () => {
    if (isForking || !props.isForkAllowed()) return;
    setIsForking(true);
    try {
      const reachableMachineTarget = readMachineTargetForSession(props.sessionId);
      const replaySummaryRunner =
        executionRunsEnabled && sessionReplayStrategy === 'summary_plus_recent' && sessionReplaySummaryRunner
          ? sessionReplaySummaryRunner
          : undefined;
      const result = await forkSession({
        machineId: reachableMachineTarget?.machineId ?? sessionForkSupportSource?.metadata?.machineId,
        serverId: resolveServerIdForSessionIdFromLocalCache(props.sessionId),
        parentSessionId: props.sessionId,
        forkPoint: { type: 'seq', upToSeqInclusive: props.upToSeqInclusive },
        ...(typeof sessionReplayMaxSeedChars === 'number' ? { replayMaxSeedChars: sessionReplayMaxSeedChars } : {}),
        ...(replaySummaryRunner ? { replaySummaryRunner } : {}),
      });
      if (result.ok !== true) {
        Modal.alert(t('common.error'), result.errorMessage || t('errors.failedToForkSession'));
        return;
      }
      const restored = typeof props.restoredDraftText === 'string' ? props.restoredDraftText : null;
      await completeSessionForkNavigation({
        childSessionId: result.childSessionId,
        parentSessionId: props.sessionId,
        navigate: (childSessionId) => router.push(`/session/${childSessionId}` as never),
        restoredDraftText: restored,
        sourceMessageId: props.messageId,
        writeForkInitialPrompt: true,
      });
    } catch (e) {
      Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToForkSession'));
    } finally {
      setIsForking(false);
    }
  }, [executionRunsEnabled, isForking, props.isForkAllowed, props.messageId, props.restoredDraftText, props.sessionId, props.upToSeqInclusive, router, sessionForkSupportSource?.metadata?.machineId, sessionReplayMaxSeedChars, sessionReplayStrategy, sessionReplaySummaryRunner]);

  if (!sessionForkSupportSource) return null;

  return (
    <Pressable
      testID={`transcript-message-fork:${props.messageId}`}
      onPress={handlePress}
      onHoverIn={props.onHoverIn}
      onHoverOut={props.onHoverOut}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={t('session.forking.forkFromMessageA11y')}
      style={({ pressed }) => [
        styles.forkMessageButton,
        Platform.OS === 'web' ? styles.webActionButton : null,
        props.invertedActionsLayout ? styles.webActionButtonInverted : null,
        props.invertedActionsLayout ? styles.messageActionButtonInvertedSpacing : null,
        pressed && styles.copyMessageButtonPressed,
        isForking && styles.copyMessageButtonPressed,
      ]}
    >
      {isForking ? (
        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
      ) : (
        <Icon
          name="git-branch"
          size={14}
          color={theme.colors.text.secondary}
        />
      )}
    </Pressable>
  );
}

function CopyMessageButton(props: { markdown: string; testID?: string; invertedActionsLayout?: boolean; onHoverIn?: () => void; onHoverOut?: () => void }) {
  const { theme } = useUnistyles();
  const [copied, setCopied] = React.useState(false);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hitSlop = Platform.OS === 'web' ? undefined : 15;

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
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={t('common.copy')}
      style={({ pressed }) => [
        styles.copyMessageButton,
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
  const pathname = usePathname();
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
          embedded={props.layoutContext === 'tool_calls_group'}
        />
      )) : null}
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
  },
  recoveredHistoryIndicator: {
    marginHorizontal: 16,
    marginBottom: 6,
    fontSize: 12,
    color: theme.colors.message.event.foreground,
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
    // No background, border or overflow clip on this container, so a radius here
    // renders nothing — it only made the transcript's radius census look wider than
    // the surfaces the user can actually see. Removed rather than unified.
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
