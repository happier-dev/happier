import * as React from "react";
import { View, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/domains/messages/messageTypes";
import { Metadata } from "@/sync/domains/state/storageTypes";
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { layout } from "@/components/ui/layout/layout";
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import { resolveInactiveSessionToolCallFailure } from '@/components/tools/shell/permissions/resolveInactiveSessionToolCallFailure';
import { resolveMessageRouteIdForDisplay } from '@/sync/domains/messages/messageRouteIds';
import { sync } from '@/sync/sync';
import { Option, type OptionLongPressHandler } from '@/components/markdown/MarkdownView';
import { isCommittedMessageDiscarded } from "@/utils/sessions/discardedCommittedMessages";
import { shouldShowMessageCopyButton, shouldShowMessageSelectButton } from '@/components/sessions/transcript/messageCopyVisibility';
import { renderStructuredMessage, StructuredMessageBlock } from '@/components/sessions/transcript/structured/StructuredMessageBlock';
import type { StructuredMessageRendererParams } from '@/components/sessions/transcript/structured/structuredMessageRegistry';
import { usePathname, useRouter } from 'expo-router';
import { buildSessionFileDeepLink } from '@/utils/url/sessionFileDeepLink';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { extractWorkspaceFileMentions } from '@/components/sessions/linkedFiles/extractWorkspaceFileMentions';
import { LinkedWorkspaceFilesRow } from '@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow';
import { useTranscriptMotion } from '@/components/sessions/transcript/motion/TranscriptMotionContext';
import { ThinkingTimelineRow } from '@/components/sessions/transcript/thinking/ThinkingTimelineRow';
import { TranscriptEventRow } from '@/components/sessions/transcript/events/TranscriptEventRow';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import { parseHappierMetaEnvelope } from '@/components/sessions/transcript/structured/happierMetaEnvelope';
import { readUnsupportedContentMeta, type UnsupportedContentMetaValue } from '@/sync/domains/messages/unsupportedContentMeta';
import { AttachmentsMessageRow } from '@/components/sessions/attachments/messages/AttachmentsMessageRow';
import { SessionMediaInlineImages } from '@/components/sessions/sessionMedia/SessionMediaInlineImages';
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
import type { TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useStreamingTextSmoothing } from '@/components/sessions/transcript/streaming/useStreamingTextSmoothing';
import { useThrottledStreamingMarkdownText } from '@/components/sessions/transcript/streaming/useThrottledStreamingMarkdownText';
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
import { useTranscriptSessionCommon } from '@/components/sessions/transcript/transcriptSessionCommon';

type StreamSegmentStateForRendering = 'streaming' | 'complete' | 'interrupted';
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

function useStructuredMessageJumpHandler(sessionId: string): StructuredMessageRendererParams['onJumpToAnchor'] {
  const router = useRouter();
  const routerRef = React.useRef<SessionFileDeepLinkRouter>(router);
  routerRef.current = router;

  return React.useCallback((target) => {
    pushSessionFileDeepLink(routerRef.current, null, {
      sessionId,
      filePath: target.filePath,
      source: target.source,
      anchor: target.anchor,
    });
  }, [sessionId]);
}

function shouldEnableFallbackTextNativeSelection(platformOS: typeof Platform.OS): boolean {
  return platformOS !== 'ios';
}

function resolveUnsupportedContentLabel(meta: UnsupportedContentMetaValue): string {
  switch (meta.kind) {
    case 'unparsed-user-message':
      return t('transcript.unsupportedContent.unparsedUserMessage');
    case 'unparsed-agent-message':
      return t('transcript.unsupportedContent.unparsedAgentMessage');
    case 'unsupported-agent-output':
      return t('transcript.unsupportedContent.unsupportedAgentOutput', { recordType: meta.recordType });
    case 'unsupported-transcript-record':
      return t('transcript.unsupportedContent.unsupportedTranscriptRecord', { recordType: meta.recordType });
  }
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

function formatTranscriptMessageTimestamp(createdAt: number): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) return null;
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

type TranscriptMessageTimestampDisplayMode = TranscriptMessageDisplayCommon['transcriptMessageTimestampDisplayMode'];

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
  historical?: boolean;
  interaction?: {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    disableToolNavigation?: boolean;
  };
};

export const MessageView = (props: MessageViewProps) => {
  const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
  return (
    <MessageViewWithSessionCommon
      {...props}
      forkCommon={transcriptSessionCommon.fork}
      messageDisplayCommon={transcriptSessionCommon.messageDisplay}
      toolChromeCommon={transcriptSessionCommon.toolChrome}
      toolRouteCommon={transcriptSessionCommon.toolRoute}
    />
  );
};

export const MessageViewWithSessionCommon = (props: MessageViewProps & {
  forkCommon: TranscriptForkCommon;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
  toolChromeCommon: TranscriptToolChromeCommon;
  toolRouteCommon: TranscriptToolRouteCommon;
}) => {
  if (shouldHideVoiceAgentTurnMessage(props.message)) return null;
  return (
    <View style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
      <View style={styles.messageContent}>
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
          historical={props.historical}
          interaction={props.interaction}
          forkCommon={props.forkCommon}
          messageDisplayCommon={props.messageDisplayCommon}
          toolChromeCommon={props.toolChromeCommon}
          toolRouteCommon={props.toolRouteCommon}
        />
      </View>
    </View>
  );
};

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
  interaction?: {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    disableToolNavigation?: boolean;
  };
  rollbackAction?: TranscriptRollbackAction | null;
  historical?: boolean;
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
          canSendMessages={props.interaction?.canSendMessages ?? true}
          rollbackAction={props.rollbackAction}
          historical={props.historical}
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
          canSendMessages={props.interaction?.canSendMessages ?? true}
          activeThinkingMessageId={props.activeThinkingMessageId}
          thinkingExpanded={props.thinkingExpanded}
          onThinkingExpandedChange={props.onThinkingExpandedChange}
          rollbackAction={props.rollbackAction}
          historical={props.historical}
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
        historical={props.historical}
        messageDisplayCommon={props.messageDisplayCommon}
        toolChromeCommon={props.toolChromeCommon}
        toolRouteCommon={props.toolRouteCommon}
      />;

    case 'agent-event':
      return <TranscriptEventRow event={props.message.event} sessionId={props.sessionId} />;


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
  canSendMessages: boolean;
  rollbackAction?: TranscriptRollbackAction | null;
  historical?: boolean;
  forkCommon: TranscriptForkCommon;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
}) {
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const isWeb = Platform.OS === 'web';
  const router = useRouter();
  const pathname = usePathname();
  const isDiscarded = isCommittedMessageDiscarded(props.metadata, props.message.localId);
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId);

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
    onJumpToAnchor: handleJumpToAnchor,
  });
  const isStructuredOnly = structuredNode != null;

  const parsedSessionMediaMeta = React.useMemo(
    () => parseSessionMediaMessageMeta(props.message.meta),
    [props.message.meta],
  );
  const attachmentsMeta = parsedSessionMediaMeta.legacyAttachments;
  const sessionMediaInlineImages = parsedSessionMediaMeta.inlineImages;

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

  const markdownText = React.useMemo(() => {
    if (unsupportedContentMeta) return resolveUnsupportedContentLabel(unsupportedContentMeta);
    if (isVoiceAgentTurn && props.message.displayText === undefined) {
      return normalizeVoiceAgentTurnTranscriptText(props.message.text);
    }
    if (props.message.displayText !== undefined) return props.message.displayText;
    if (attachmentsMeta) return stripLegacyAttachmentsBlock(props.message.text);
    return props.message.text;
  }, [attachmentsMeta, isVoiceAgentTurn, props.message.displayText, props.message.text, unsupportedContentMeta]);
  const renderedMarkdownText = markdownText ?? props.message.displayText ?? props.message.text;

  const linkedWorkspaceFiles = React.useMemo(
    () => extractWorkspaceFileMentions(renderedMarkdownText),
    [renderedMarkdownText],
  );

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

  const selectableMessage = isDiscarded ? null : resolveSelectableMessageText({
    message: props.message,
    isStructuredOnly,
    hasAttachmentBlockToStrip: attachmentsMeta != null,
  });
  const selectionEnabled = props.messageDisplayCommon.transcriptMessageSelectionEnabled === true && selectableMessage != null;
  const selectionRow = useOptionalTranscriptSelectionRow(props.message.id);
  const selectionModeActionsVisible = selectionEnabled && selectionRow.isSelectionMode;
  const showCopyButton = shouldShowMessageCopyButton({ platformOS: Platform.OS, isMessageHovered, isCopyButtonHovered, selectionModeActive: selectionModeActionsVisible });
  const showSelectButton = selectionEnabled && shouldShowMessageSelectButton({ platformOS: Platform.OS, isMessageHovered, isCopyButtonHovered, selectionModeActive: selectionModeActionsVisible });
  const showMessageActions = showCopyButton || showSelectButton;
  const copyText = selectableMessage?.text ?? (isStructuredOnly ? props.message.text : (markdownText ?? props.message.displayText ?? props.message.text));
  const actionPointerEvents = resolveMessageActionPointerEvents({ showActions: showMessageActions });
  const timestampPresentation = resolveMessageTimestampPresentation({
    displayMode: props.messageDisplayCommon.transcriptMessageTimestampDisplayMode,
    isWeb,
    showActions: showMessageActions,
  });
  const timestampText = timestampPresentation.showTimestamp
    ? formatTranscriptMessageTimestamp(props.message.createdAt)
    : null;
  const sessionReplayEnabled = props.forkCommon.sessionReplayEnabled;
  const sessionForkSupportSource = props.forkCommon.sessionForkSupportSource;
  const workspacePath = props.messageDisplayCommon.workspacePath;
  const handleMarkdownLinkPress = React.useCallback((url: string) => {
    const resolved = resolveTranscriptMarkdownFileLink({ url, workspacePath });
    if (!resolved) return false;
    const anchor = resolved.anchor ?? null;
    pushSessionFileDeepLink(router, pathname, {
      sessionId: props.sessionId,
      filePath: resolved.filePath,
      ...(anchor ? { source: 'file' as const, anchor } : {}),
    });
    return true;
  }, [pathname, props.sessionId, router, workspacePath]);
  const seq =
    typeof (props.message as any).seq === 'number' && Number.isFinite((props.message as any).seq)
      ? Math.trunc((props.message as any).seq)
      : null;
  const showForkButton = canForkFromMessage({ session: sessionForkSupportSource, messageSeq: seq, replayEnabled: sessionReplayEnabled });
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
          <View style={styles.structuredUserMessageContent}>
            {structuredNode}
            {sessionMediaInlineImages.length > 0 ? (
              <SessionMediaInlineImages
                sessionId={props.sessionId}
                media={sessionMediaInlineImages}
                onOpenPath={handleOpenAttachmentPath}
              />
            ) : null}
            {nonImageAttachments.length > 0 ? (
              <AttachmentsMessageRow
                attachments={nonImageAttachments}
                onOpenPath={handleOpenAttachmentPath}
              />
            ) : null}
            {isDiscarded ? (
              <Text selectable style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
            ) : null}
          </View>
          <MessageActionRow
            messageId={props.message.id}
            timestampText={timestampText}
            showActions={showMessageActions}
            pointerEvents={actionPointerEvents}
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
            <View style={[styles.userMessageBubble, isDiscarded && styles.userMessageBubbleDiscarded]}>
              <StructuredMessageBlock
                message={props.message as any}
                sessionId={props.sessionId}
                onJumpToAnchor={handleJumpToAnchor}
              />
              <MarkdownView markdown={renderedMarkdownText} onOptionPress={handleOptionPress} onOptionLongPress={handleOptionLongPress} onLinkPress={handleMarkdownLinkPress} selectable={true} profile="transcript" textStyle={styles.transcriptMarkdownText} />
              {sessionMediaInlineImages.length > 0 ? (
                <SessionMediaInlineImages
                  sessionId={props.sessionId}
                  media={sessionMediaInlineImages}
                  onOpenPath={handleOpenAttachmentPath}
                />
              ) : null}
              {nonImageAttachments.length > 0 ? (
                <AttachmentsMessageRow
                  attachments={nonImageAttachments}
                  onOpenPath={handleOpenAttachmentPath}
                />
              ) : null}
              {linkedWorkspaceFiles.length > 0 ? (
                <LinkedWorkspaceFilesRow sessionId={props.sessionId} paths={linkedWorkspaceFiles} />
              ) : null}
              {isDiscarded && (
                <Text selectable style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
              )}
            </View>
          </View>
          <MessageActionRow
            messageId={props.message.id}
            timestampText={timestampText}
            showActions={showMessageActions}
            pointerEvents={actionPointerEvents}
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
  canSendMessages: boolean;
  activeThinkingMessageId: string | null;
  thinkingExpanded?: boolean;
  onThinkingExpandedChange?: (next: boolean) => void;
  rollbackAction?: TranscriptRollbackAction | null;
  historical?: boolean;
  forkCommon: TranscriptForkCommon;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
}) {
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const isWeb = Platform.OS === 'web';
  const fallbackTextSelectable = shouldEnableFallbackTextNativeSelection(Platform.OS);
  const router = useRouter();
  const pathname = usePathname();
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId);
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
    onJumpToAnchor: handleJumpToAnchor,
  });
  const isStructuredOnly = structuredNode != null;
  const parsedSessionMediaMeta = React.useMemo(
    () => parseSessionMediaMessageMeta(props.message.meta),
    [props.message.meta],
  );
  const sessionMediaInlineImages = parsedSessionMediaMeta.inlineImages;
  const handleOpenMediaPath = React.useCallback((filePath: string) => {
    pushSessionFileDeepLink(router, pathname, { sessionId: props.sessionId, filePath });
  }, [pathname, props.sessionId, router]);
  const baseMarkdownText = unsupportedContentMeta
    ? resolveUnsupportedContentLabel(unsupportedContentMeta)
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
  const selectableMessage = resolveSelectableMessageText({
    message: props.message,
    isStructuredOnly,
    hasAttachmentBlockToStrip: false,
  });
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

  const showCopyButton = shouldShowMessageCopyButton({ platformOS: Platform.OS, isMessageHovered, isCopyButtonHovered, selectionModeActive: selectionModeActionsVisible });
  const showSelectButton = selectionEnabled && shouldShowMessageSelectButton({ platformOS: Platform.OS, isMessageHovered, isCopyButtonHovered, selectionModeActive: selectionModeActionsVisible });
  const showMessageActions = showCopyButton || showSelectButton;
  const actionPointerEvents = resolveMessageActionPointerEvents({ showActions: showMessageActions });
  const timestampPresentation = resolveMessageTimestampPresentation({
    displayMode: props.messageDisplayCommon.transcriptMessageTimestampDisplayMode,
    isWeb,
    showActions: showMessageActions,
  });
  const timestampText = timestampPresentation.showTimestamp
    ? formatTranscriptMessageTimestamp(props.message.createdAt)
    : null;
  const sessionReplayEnabled = props.forkCommon.sessionReplayEnabled;
  const sessionForkSupportSource = props.forkCommon.sessionForkSupportSource;
  const workspacePath = props.messageDisplayCommon.workspacePath;
  const handleMarkdownLinkPress = React.useCallback((url: string) => {
    const resolved = resolveTranscriptMarkdownFileLink({ url, workspacePath });
    if (!resolved) return false;
    const anchor = resolved.anchor ?? null;
    pushSessionFileDeepLink(router, pathname, {
      sessionId: props.sessionId,
      filePath: resolved.filePath,
      ...(anchor ? { source: 'file' as const, anchor } : {}),
    });
    return true;
  }, [pathname, props.sessionId, router, workspacePath]);
  const seq =
    typeof (props.message as any).seq === 'number' && Number.isFinite((props.message as any).seq)
      ? Math.trunc((props.message as any).seq)
      : null;
  const showForkButton = canForkFromMessage({ session: sessionForkSupportSource, messageSeq: seq, replayEnabled: sessionReplayEnabled });
  const forkSemantics = React.useMemo(() => {
    if (seq == null) return null;
    return resolveForkFromMessageSemantics({ message: props.message, messageSeqInclusive: seq });
  }, [props.message, seq]);
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
  const streamingSmoothingEligible =
    transcriptStreamingSmoothingEnabled === true &&
    streamingPlainEligible &&
    (streamSegmentMeta ? streamSegmentAssistantStreaming === true : true);
  const streaming = useStreamingTextSmoothing({
    enabled: streamingSmoothingEligible,
    targetText: renderedAgentText,
    settleDelayMs: transcriptStreamingSettleDelayMs,
  });
  const shouldRenderStreamingPlain = shouldRenderActiveStreamSegmentPlain || streaming.isStreaming;
  const shouldRenderStreamingMarkdown =
    shouldRenderStreamingPlain && transcriptStreamingMarkdownRenderingEnabled === true;
  const streamingMarkdownText = useThrottledStreamingMarkdownText({
    enabled: shouldRenderStreamingMarkdown && transcriptStreamingSmoothingEnabled,
    text: streaming.displayText,
    throttleMs: transcriptStreamingSettleDelayMs,
  });
  const streamingMarkdownMessageIdRef = React.useRef<string | null>(null);
  if (shouldRenderStreamingMarkdown) {
    streamingMarkdownMessageIdRef.current = props.message.id;
  }
  const staticRenderPlaceholderEnabled =
    streamingMarkdownMessageIdRef.current === props.message.id ? false : undefined;
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
  const linkedWorkspaceFiles = React.useMemo(() => {
    if (shouldRenderStreamingPlain) return [];
    return extractWorkspaceFileMentions(markdown);
  }, [markdown, shouldRenderStreamingPlain]);

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
        {...streamingLiveRegionProps}
        style={[
          styles.agentMessageContainer,
          props.message.isThinking === true ? styles.agentMessageContainerThinking : null,
          props.historical ? styles.historicalMessageContainer : null,
        ]}
        {...(isWeb ? {} : { pointerEvents: 'box-none' as const })}
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
                result: { content: markdown },
              }}
              messages={[]}
            />
          ) : (
              renderThinkingInline ? (
                <ThinkingTimelineRow
                  id={props.message.id}
                  createdAt={props.message.createdAt}
                  label={t('sessionInfo.thinking')}
                  summary={deriveThinkingSummary(markdown)}
                  expandedByDefault={normalizedThinkingInlinePresentation === 'full'}
                  pulseEnabled={thinkingPulseEnabled}
                  chrome={normalizedThinkingInlineChrome}
                  expanded={props.thinkingExpanded}
                  onExpandedChange={props.onThinkingExpandedChange}
                >
                  <MarkdownView
                    testID="transcript-thinking-body-markdown"
                    markdown={markdown}
                    onOptionPress={handleOptionPress}
                    onOptionLongPress={handleOptionLongPress}
                    onLinkPress={handleMarkdownLinkPress}
                    selectable={true}
                    profile="thinking"
                    textStyle={thinkingMarkdownTextStyle}
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
        {linkedWorkspaceFiles.length > 0 && !isStructuredOnly ? (
          <LinkedWorkspaceFilesRow sessionId={props.sessionId} paths={linkedWorkspaceFiles} />
        ) : null}
        {sessionMediaInlineImages.length > 0 ? (
          <SessionMediaInlineImages
            sessionId={props.sessionId}
            media={sessionMediaInlineImages}
            onOpenPath={handleOpenMediaPath}
          />
        ) : null}
        <MessageActionRow
          messageId={props.message.id}
          timestampText={timestampText}
          showActions={showMessageActions}
          pointerEvents={actionPointerEvents}
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

function MessageActionRow(props: {
  children: React.ReactNode;
  isWeb: boolean;
  invertTimestampAndActions: boolean;
  messageId: string;
  pointerEvents: 'auto' | 'none';
  showActions: boolean;
  timestampText: string | null;
}) {
  const hasTimestamp = typeof props.timestampText === 'string' && props.timestampText.length > 0;
  const shouldHideRow = !hasTimestamp && !props.showActions;
  return (
    <View
      {...(props.isWeb ? {} : { pointerEvents: props.pointerEvents })}
      style={[
        styles.messageActionContainer,
        props.invertTimestampAndActions && styles.messageActionContainerInverted,
        shouldHideRow && styles.messageActionContainerHidden,
        props.isWeb ? { pointerEvents: props.pointerEvents } : null,
      ]}
      testID={`transcript-message-actions-row:${props.messageId}`}
    >
      {hasTimestamp ? (
        <Text
          testID={`transcript-message-timestamp:${props.messageId}`}
          style={[
            styles.messageTimestampText,
            props.invertTimestampAndActions && styles.messageTimestampTextInverted,
          ]}
        >
          {props.timestampText}
        </Text>
      ) : null}
      <View
        accessibilityElementsHidden={!props.showActions}
        importantForAccessibility={props.showActions ? 'auto' : 'no-hide-descendants'}
        style={[
          styles.messageActionButtons,
          !props.showActions && styles.messageActionContainerHidden,
        ]}
        testID={`transcript-message-actions:${props.messageId}`}
      >
        {props.children}
      </View>
    </View>
  );
}

function ForkMessageButton(props: {
  sessionId: string;
  upToSeqInclusive: number;
  restoredDraftText?: string | null;
  messageId: string;
  forkCommon: TranscriptForkCommon;
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
    if (isForking) return;
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
        navigate: (childSessionId) => router.push((`/session/${childSessionId}`) as any),
        restoredDraftText: restored,
        sourceMessageId: props.messageId,
        writeForkInitialPrompt: true,
      });
    } catch (e) {
      Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToForkSession'));
    } finally {
      setIsForking(false);
    }
  }, [executionRunsEnabled, isForking, props.messageId, props.restoredDraftText, props.sessionId, props.upToSeqInclusive, router, sessionForkSupportSource?.metadata?.machineId, sessionReplayMaxSeedChars, sessionReplayStrategy, sessionReplaySummaryRunner]);

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
        <Ionicons
          name="git-branch-outline"
          size={12}
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
      <Ionicons
        name={copied ? "checkmark-outline" : "copy-outline"}
        size={12}
        color={copied ? theme.colors.state.success.foreground : theme.colors.text.secondary}
      />
    </Pressable>
  );
}

function resolveMessageActionPointerEvents(params: { showActions: boolean }) {
  return params.showActions ? ('auto' as const) : ('none' as const);
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
  interaction?: {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'inactive' | 'notGranted';
    disableToolNavigation?: boolean;
  };
  rollbackAction?: TranscriptRollbackAction | null;
  historical?: boolean;
  messageDisplayCommon: TranscriptMessageDisplayCommon;
  toolChromeCommon: TranscriptToolChromeCommon;
  toolRouteCommon: TranscriptToolRouteCommon;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId);
  const toolViewTimelineChromeMode = props.toolChromeCommon.toolViewTimelineChromeMode;
  const messagesById = props.toolRouteCommon.messagesById;
  const reducerState = props.toolRouteCommon.reducerState;
  if (!props.message.tool) {
    return null;
  }
  const structuredNode = renderStructuredMessage({
    message: props.message,
    sessionId: props.sessionId,
    onJumpToAnchor: handleJumpToAnchor,
  });
  const toolForSession = resolveInactiveSessionToolCallFailure({
    tool: props.message.tool,
    permissionDisabledReason: props.interaction?.permissionDisabledReason,
  });
  const statusKind = resolveToolStatusIndicatorKind(toolForSession);
  const shouldForceToolChromeForStatus = statusKind === 'error' || statusKind === 'permission_blocked';
  const shouldRenderToolChrome = !(
    toolViewTimelineChromeMode === 'activity_feed' &&
    structuredNode != null &&
    !shouldForceToolChromeForStatus
  );
  const toolRouteMessageId = props.interaction?.disableToolNavigation
    ? undefined
    : resolveMessageRouteIdForDisplay({
        message: props.message,
        messagesById,
        reducerState,
      });
  return (
    <View
      style={[
        styles.toolContainer,
        props.layoutContext === 'tool_calls_group' ? styles.toolContainerEmbedded : null,
        toolViewTimelineChromeMode === 'activity_feed'
          ? (props.layoutContext === 'tool_calls_group' ? styles.toolContainerFeedEmbedded : styles.toolContainerFeed)
          : styles.toolContainerCards,
      ]}
    >
      {structuredNode}
      {shouldRenderToolChrome ? (toolViewTimelineChromeMode === 'activity_feed' ? (
        <ToolTimelineRow
          tool={props.message.tool}
          metadata={props.metadata}
          messages={props.message.children}
          sessionId={props.sessionId}
          messageId={toolRouteMessageId}
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
          approvalRequests={props.approvalRequests}
          forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
          interaction={props.interaction}
          embedded={props.layoutContext === 'tool_calls_group'}
        />
      )) : null}
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
    maxWidth: layout.maxWidth,
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
      borderRadius: 12,
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
    borderRadius: 16,
    alignSelf: 'stretch',
    position: 'relative',
    maxWidth: '100%',
  },
  agentMessageContainerThinking: {
    alignSelf: 'stretch',
  },
  toolContainer: {
    marginHorizontal: 16,
  },
  toolContainerEmbedded: {
    marginHorizontal: 0,
  },
  toolActionContainer: {
    alignItems: 'flex-end',
    paddingBottom: 6,
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
  messageActionContainer: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  messageActionContainerInverted: {
    flexDirection: 'row-reverse',
  },
  messageActionContainerHidden: {
    opacity: 0,
  },
  messageActionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  messageSelectionCheckboxSlot: {
    position: 'absolute',
    top: TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_TOP,
    right: TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_RIGHT,
    zIndex: TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_Z_INDEX,
  },
  messageTimestampText: {
    color: theme.colors.text.tertiary,
    fontSize: 11,
    lineHeight: 16,
    marginRight: 8,
  },
  messageTimestampTextInverted: {
    marginLeft: 12,
    marginRight: 0,
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
