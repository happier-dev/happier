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
import { Option } from '@/components/markdown/MarkdownView';
import { isCommittedMessageDiscarded } from "@/utils/sessions/discardedCommittedMessages";
import { shouldShowMessageCopyButton, shouldShowMessageSelectButton } from '@/components/sessions/transcript/messageCopyVisibility';
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
import {
  storage,
} from '@/sync/domains/state/storage';
import { Text } from '@/components/ui/text/Text';
import { extractWorkspaceFileMentions } from '@/components/sessions/linkedFiles/extractWorkspaceFileMentions';
import { LinkedWorkspaceFilesRow } from '@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow';
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
import { forkSession } from '@/sync/ops';
import { canForkFromMessage } from '@/sync/domains/sessionFork/forkUiSupport';
import { resolveForkFromMessageSemantics } from '@/sync/domains/sessionFork/forkFromMessageSemantics';
import { writeForkInitialPromptV1 } from '@/sync/domains/sessionFork/forkInitialPromptV1';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { normalizeVoiceAgentTurnTranscriptText } from '@happier-dev/agents';
import { TranscriptRollbackActionButton } from '@/components/sessions/transcript/TranscriptRollbackActionButton';
import type { TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useStreamingTextSmoothing } from '@/components/sessions/transcript/streaming/useStreamingTextSmoothing';
import { useThrottledStreamingMarkdownText } from '@/components/sessions/transcript/streaming/useThrottledStreamingMarkdownText';
import { readStreamSegmentMetaV1 } from '@/sync/reducer/helpers/streamSegmentMeta';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveTranscriptMarkdownFileLink } from '@/components/sessions/transcript/resolveTranscriptMarkdownFileLink';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
  type TranscriptForkCommon,
  type TranscriptMessageDisplayCommon,
  type TranscriptToolChromeCommon,
  type TranscriptToolRouteCommon,
  useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

const TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_TOP = 0;
const TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_RIGHT = 0;
const TRANSCRIPT_SELECTION_CHECKBOX_ANCHOR_Z_INDEX = 2;

function shouldEnableFallbackTextNativeSelection(platformOS: typeof Platform.OS): boolean {
  return platformOS !== 'ios';
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

type SessionFileDeepLinkParams = Parameters<typeof buildSessionFileDeepLink>[0];
type SessionFileDeepLinkRouter = Pick<ReturnType<typeof useRouter>, 'push'>;

function pushSessionFileDeepLink(
  router: SessionFileDeepLinkRouter,
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
    pushSessionFileDeepLink(routerRef.current, {
      sessionId,
      filePath: target.filePath,
      source: target.source,
      anchor: target.anchor,
    });
  }, [sessionId]);
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
      return <TranscriptEventRow event={props.message.event} />;


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
	  const isDiscarded = isCommittedMessageDiscarded(props.metadata, props.message.localId);
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId);

  const isVoiceAgentTurn = React.useMemo(() => {
    const envelope = parseHappierMetaEnvelope(props.message.meta);
    return envelope?.kind === 'voice_agent_turn.v1';
  }, [props.message.meta]);

  const structuredNode = renderStructuredMessage({
	    message: props.message,
	    sessionId: props.sessionId,
	    onJumpToAnchor: handleJumpToAnchor,
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

  const markdownText = React.useMemo(() => {
    if (isVoiceAgentTurn && props.message.displayText === undefined) {
      return normalizeVoiceAgentTurnTranscriptText(props.message.text);
    }
    if (props.message.displayText !== undefined) return props.message.displayText;
    if (attachmentsMeta) return stripLegacyAttachmentsBlock(props.message.text);
    return props.message.text;
  }, [attachmentsMeta, isVoiceAgentTurn, props.message.displayText, props.message.text]);
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
  const {
    sessionForkSupportSource,
    sessionReplayEnabled,
  } = props.forkCommon;
  const workspacePath = props.messageDisplayCommon.workspacePath;
	  const handleMarkdownLinkPress = React.useCallback((url: string) => {
	    const resolved = resolveTranscriptMarkdownFileLink({ url, workspacePath });
	    if (!resolved) return false;
	    const anchor = resolved.anchor ?? null;
	    pushSessionFileDeepLink(router, {
	      sessionId: props.sessionId,
	      filePath: resolved.filePath,
	      ...(anchor ? { source: 'file' as const, anchor } : {}),
	    });
	    return true;
	  }, [props.sessionId, router, workspacePath]);
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
          <View style={styles.structuredUserMessageContent}>
            {structuredNode}
            {attachmentsMeta ? (
              <AttachmentsInlineImages
                sessionId={props.sessionId}
                attachments={attachmentsMeta.attachments}
                onOpenPath={handleOpenAttachmentPath}
              />
            ) : null}
            {sessionMediaMeta ? (
              <SessionMediaInlineImages
                sessionId={props.sessionId}
                media={sessionMediaMeta.inlineImages}
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
            isWeb={isWeb}
            messageId={props.message.id}
            pointerEvents={actionPointerEvents}
            showActions={showMessageActions}
            timestampText={timestampText}
            invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
          >
            {props.rollbackAction ? (
              <TranscriptRollbackActionButton
                sessionId={props.sessionId}
                target={props.rollbackAction.target}
                restoredDraftText={props.rollbackAction.restoredDraftText}
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
          <View style={[styles.userMessageBubble, isDiscarded && styles.userMessageBubbleDiscarded]}>
            <StructuredMessageBlock
              message={props.message as any}
	              sessionId={props.sessionId}
	              onJumpToAnchor={handleJumpToAnchor}
	            />
            <MarkdownView markdown={renderedMarkdownText} onOptionPress={handleOptionPress} onLinkPress={handleMarkdownLinkPress} selectable={true} profile="transcript" textStyle={styles.transcriptMarkdownText} />
            {attachmentsMeta ? (
              <AttachmentsInlineImages
                sessionId={props.sessionId}
                attachments={attachmentsMeta.attachments}
                onOpenPath={handleOpenAttachmentPath}
              />
            ) : null}
            {sessionMediaMeta ? (
              <SessionMediaInlineImages
                sessionId={props.sessionId}
                media={sessionMediaMeta.inlineImages}
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
          <MessageActionRow
            isWeb={isWeb}
            messageId={props.message.id}
            pointerEvents={actionPointerEvents}
            showActions={showMessageActions}
            timestampText={timestampText}
            invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
          >
            {props.rollbackAction ? (
              <TranscriptRollbackActionButton
                sessionId={props.sessionId}
                target={props.rollbackAction.target}
                restoredDraftText={props.rollbackAction.restoredDraftText}
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
  const handleJumpToAnchor = useStructuredMessageJumpHandler(props.sessionId);
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
	    onJumpToAnchor: handleJumpToAnchor,
	  });
  const isStructuredOnly = structuredNode != null;
  const baseMarkdownText = isVoiceAgentTurn
    ? normalizeVoiceAgentTurnTranscriptText(props.message.text)
    : props.message.text;
  if (isVoiceAgentTurn && baseMarkdownText == null) {
    return null;
  }
  const markdownSource = baseMarkdownText ?? props.message.text;
  const markdown = props.message.isThinking ? unwrapLegacyThinkingWrapper(markdownSource) : markdownSource;
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
  const {
    sessionForkSupportSource,
    sessionReplayEnabled,
  } = props.forkCommon;
  const workspacePath = props.messageDisplayCommon.workspacePath;
	  const handleMarkdownLinkPress = React.useCallback((url: string) => {
	    const resolved = resolveTranscriptMarkdownFileLink({ url, workspacePath });
	    if (!resolved) return false;
	    const anchor = resolved.anchor ?? null;
	    pushSessionFileDeepLink(router, {
	      sessionId: props.sessionId,
	      filePath: resolved.filePath,
	      ...(anchor ? { source: 'file' as const, anchor } : {}),
	    });
	    return true;
	  }, [props.sessionId, router, workspacePath]);
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

  const streamingSmoothingEligible =
      transcriptStreamingSmoothingEnabled === true &&
      streamingPlainEligible &&
      (streamSegmentMeta ? streamSegmentAssistantStreaming === true : true);
  const streaming = useStreamingTextSmoothing({
      enabled: streamingSmoothingEligible,
      targetText: renderText,
      settleDelayMs: transcriptStreamingSettleDelayMs,
  });
  const shouldRenderStreamingPlain =
      shouldRenderActiveStreamSegmentPlain || streaming.isStreaming;
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
  const linkedWorkspaceFilesDeferred = React.useMemo(() => {
      if (shouldRenderStreamingPlain) return [];
      return extractWorkspaceFileMentions(markdown);
  }, [markdown, shouldRenderStreamingPlain]);
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
      {...(isWeb
        ? {
            onHoverIn: () => setIsMessageHovered(true),
            onHoverOut: () => setIsMessageHovered(false),
          }
        : null)}
    >
      <View
        collapsable={false}
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
        {linkedWorkspaceFilesDeferred.length > 0 && !isStructuredOnly ? (
          <LinkedWorkspaceFilesRow sessionId={props.sessionId} paths={linkedWorkspaceFilesDeferred} />
        ) : null}
        {agentSessionMediaMeta ? (
          <SessionMediaInlineImages
            sessionId={props.sessionId}
            media={agentSessionMediaMeta.inlineImages}
            onOpenPath={handleOpenAgentSessionMediaPath}
          />
        ) : null}
        <MessageActionRow
          isWeb={isWeb}
          messageId={props.message.id}
          pointerEvents={actionPointerEvents}
          showActions={showMessageActions}
          timestampText={timestampText}
          invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
        >
          {props.rollbackAction ? (
            <TranscriptRollbackActionButton
              sessionId={props.sessionId}
              target={props.rollbackAction.target}
              restoredDraftText={props.rollbackAction.restoredDraftText}
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
        serverId: resolveMessageServerId(props.sessionId, sessionForkSupportSource?.serverId) ?? undefined,
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
      if (restored && restored.trim().length > 0) {
        try {
          // Persist immediately so the child session composer can initialize from drafts even if the session
          // is not yet hydrated into local state.
          storage.getState().updateSessionDraft(result.childSessionId, restored);
        } catch {
          // best-effort
        }
      }
      router.push((`/session/${result.childSessionId}`) as any);
      fireAndForget((async () => {
        try {
          await (sync as any).ensureSessionVisibleForMessageRoute?.(result.childSessionId);
          if (restored && restored.trim().length > 0) {
            await sync.patchSessionMetadataWithRetry(result.childSessionId, (metadata) =>
              writeForkInitialPromptV1({
                metadata: metadata as any,
                text: restored,
                createdAtMs: Date.now(),
                sourceMessageId: props.messageId,
              }) as any,
            );
          }
        } catch {
          // best-effort
        }
      })(), { tag: 'ForkMessageButton.ensureChildVisibleAndPersistForkInitialPromptV1' });
    } catch (e) {
      Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToForkSession'));
    } finally {
      setIsForking(false);
    }
  }, [executionRunsEnabled, isForking, props.messageId, props.restoredDraftText, props.sessionId, props.upToSeqInclusive, router, sessionForkSupportSource?.metadata?.machineId, sessionForkSupportSource?.serverId, sessionReplayMaxSeedChars, sessionReplayStrategy, sessionReplaySummaryRunner]);

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
        />
      )) : null}
      {toolSessionMediaMeta ? (
        <SessionMediaInlineImages
          sessionId={props.sessionId}
          media={toolSessionMediaMeta.inlineImages}
          onOpenPath={handleOpenToolSessionMediaPath}
        />
      ) : null}
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
      maxWidth: '100%',
      alignSelf: 'flex-end',
      position: 'relative',
      paddingBottom: 22,
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
    marginRight: 8,
    color: theme.colors.text.tertiary,
    fontSize: 11,
    lineHeight: 16,
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
