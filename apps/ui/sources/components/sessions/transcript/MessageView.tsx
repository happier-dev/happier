import * as React from "react";
import { View, Pressable, Platform, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/domains/messages/messageTypes";
import { Metadata } from "@/sync/domains/state/storageTypes";
import { layout } from "@/components/ui/layout/layout";
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { resolveMessageRouteIdForDisplay } from '@/sync/domains/messages/messageRouteIds';
import { sync } from '@/sync/sync';
import { Option } from '@/components/markdown/MarkdownView';
import { isCommittedMessageDiscarded } from "@/utils/sessions/discardedCommittedMessages";
import { shouldShowMessageCopyButton } from '@/components/sessions/transcript/messageCopyVisibility';
import { renderStructuredMessage, StructuredMessageBlock } from '@/components/sessions/transcript/structured/StructuredMessageBlock';
import { useRouter } from 'expo-router';
import { buildSessionFileDeepLink } from '@/utils/url/sessionFileDeepLink';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage, useSession, useSessionMessagesById, useSessionMessagesReducerState, useSetting } from '@/sync/domains/state/storage';
import { Text } from '@/components/ui/text/Text';
import { extractWorkspaceFileMentions } from '@/components/sessions/linkedFiles/extractWorkspaceFileMentions';
import { LinkedWorkspaceFilesRow } from '@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow';
import { useTranscriptMotion } from '@/components/sessions/transcript/motion/TranscriptMotionContext';
import { ThinkingTimelineRow } from '@/components/sessions/transcript/thinking/ThinkingTimelineRow';
import { TranscriptEventRow } from '@/components/sessions/transcript/events/TranscriptEventRow';
import { parseHappierMetaEnvelope } from '@/components/sessions/transcript/structured/happierMetaEnvelope';
import { AttachmentsMessageMetaV1Schema } from '@/sync/domains/attachments/attachmentsMessageMeta';
import { AttachmentsMessageRow } from '@/components/sessions/attachments/messages/AttachmentsMessageRow';
import { AttachmentsInlineImages } from '@/components/sessions/attachments/messages/AttachmentsInlineImages';
import { forkSession } from '@/sync/ops';
import { canForkFromMessage } from '@/sync/domains/sessionFork/forkUiSupport';
import { resolveForkFromMessageSemantics } from '@/sync/domains/sessionFork/forkFromMessageSemantics';
import { writeForkInitialPromptV1 } from '@/sync/domains/sessionFork/forkInitialPromptV1';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';
import { normalizeVoiceAgentTurnTranscriptText } from '@/voice/persistence/normalizeVoiceAgentTurnTranscriptText';
import { TranscriptRollbackActionButton } from '@/components/sessions/transcript/TranscriptRollbackActionButton';

function shouldHideVoiceAgentTurnMessage(message: Message): boolean {
  if (message.kind !== 'user-text' && message.kind !== 'agent-text') return false;
  if (message.kind === 'user-text' && message.displayText !== undefined) return false;
  const envelope = parseHappierMetaEnvelope(message.meta);
  if (envelope?.kind !== 'voice_agent_turn.v1') return false;
  return normalizeVoiceAgentTurnTranscriptText(message.text) == null;
}

export const MessageView = (props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  activeThinkingMessageId?: string | null;
  thinkingExpanded?: boolean;
  onThinkingExpandedChange?: (next: boolean) => void;
  getMessageById?: (id: string) => Message | null;
  showRollbackAction?: boolean;
  historical?: boolean;
  interaction?: {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    disableToolNavigation?: boolean;
  };
}) => {
  if (shouldHideVoiceAgentTurnMessage(props.message)) return null;
  return (
    <View style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          activeThinkingMessageId={props.activeThinkingMessageId ?? null}
          thinkingExpanded={props.thinkingExpanded}
          onThinkingExpandedChange={props.onThinkingExpandedChange}
          getMessageById={props.getMessageById}
          showRollbackAction={props.showRollbackAction}
          historical={props.historical}
          interaction={props.interaction}
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
  showRollbackAction?: boolean;
  historical?: boolean;
}): React.ReactElement | null {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          canSendMessages={props.interaction?.canSendMessages ?? true}
          showRollbackAction={props.showRollbackAction}
          historical={props.historical}
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
          showRollbackAction={props.showRollbackAction}
          historical={props.historical}
        />
      );

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        activeThinkingMessageId={props.activeThinkingMessageId}
        getMessageById={props.getMessageById}
        interaction={props.interaction}
        showRollbackAction={props.showRollbackAction}
        historical={props.historical}
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
  showRollbackAction?: boolean;
  historical?: boolean;
}) {
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const isWeb = Platform.OS === 'web';
  const router = useRouter();
  const isDiscarded = isCommittedMessageDiscarded(props.metadata, props.message.localId);

  const isVoiceAgentTurn = React.useMemo(() => {
    const envelope = parseHappierMetaEnvelope(props.message.meta);
    return envelope?.kind === 'voice_agent_turn.v1';
  }, [props.message.meta]);

  const structuredNode = renderStructuredMessage({
    message: props.message,
    sessionId: props.sessionId,
    onJumpToAnchor: (target) => {
      router.push(buildSessionFileDeepLink({
        sessionId: props.sessionId,
        filePath: target.filePath,
        source: target.source,
        anchor: target.anchor,
      }));
    },
  });
  const isStructuredOnly = structuredNode != null;

  const attachmentsMeta = React.useMemo(() => {
    const envelope = parseHappierMetaEnvelope(props.message.meta);
    if (!envelope || envelope.kind !== 'attachments.v1') return null;
    const parsed = AttachmentsMessageMetaV1Schema.safeParse(envelope.payload);
    if (!parsed.success) return null;
    if (parsed.data.attachments.length === 0) return null;
    return parsed.data;
  }, [props.message.meta]);

  const nonImageAttachments = React.useMemo(() => {
    if (!attachmentsMeta) return [];
    return attachmentsMeta.attachments.filter((a) => {
      if (a.mimeType && a.mimeType.startsWith('image/')) return false;
      return getImageMimeTypeFromPath(a.path) == null;
    });
  }, [attachmentsMeta]);

  const stripAttachmentsBlock = React.useCallback((text: string): string => {
    const startTag = '[attachments]';
    const endTag = '[/attachments]';
    const start = text.indexOf(startTag);
    const end = text.indexOf(endTag);
    if (start < 0 || end < 0 || end <= start) return text;

    // Prefer stripping from the start of the "Attachments:" line when present.
    let stripStart = start;
    const intro = text.lastIndexOf('Attachments:', start);
    if (intro >= 0) {
      const lineStart = text.lastIndexOf('\n', intro - 1) + 1;
      if (lineStart === intro || text.slice(lineStart, intro).trim() === '') {
        stripStart = lineStart;
      }
    }

    const before = text.slice(0, stripStart).trimEnd();
    const after = text.slice(end + endTag.length).trimStart();
    if (!before) return after;
    if (!after) return before;
    return `${before}\n\n${after}`;
  }, []);

  const markdownText = React.useMemo(() => {
    if (isVoiceAgentTurn && props.message.displayText === undefined) {
      return normalizeVoiceAgentTurnTranscriptText(props.message.text);
    }
    if (props.message.displayText !== undefined) return props.message.displayText;
    if (attachmentsMeta) return stripAttachmentsBlock(props.message.text);
    return props.message.text;
  }, [attachmentsMeta, isVoiceAgentTurn, props.message.displayText, props.message.text, stripAttachmentsBlock]);
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
        await sync.submitMessage(props.sessionId, option.title);
      } catch (e) {
        Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
      }
    })(), { tag: 'MessageView.handleOptionPress.userMessage' });
  }, [props.canSendMessages, props.sessionId]);

  const showCopyButton = shouldShowMessageCopyButton({ platformOS: Platform.OS, isMessageHovered, isCopyButtonHovered });
  const copyText = isStructuredOnly ? props.message.text : (markdownText ?? props.message.displayText ?? props.message.text);
  const actionPointerEvents = resolveMessageActionPointerEvents({ isWeb, showCopyButton });
  const sessionReplayEnabled = useSetting('sessionReplayEnabled');
  const session = useSession(props.sessionId);
  const seq =
    typeof (props.message as any).seq === 'number' && Number.isFinite((props.message as any).seq)
      ? Math.trunc((props.message as any).seq)
      : null;
  const showForkButton = canForkFromMessage({ session, messageSeq: seq, replayEnabled: sessionReplayEnabled });
  const forkSemantics = React.useMemo(() => {
    if (seq == null) return null;
    return resolveForkFromMessageSemantics({ message: props.message, messageSeqInclusive: seq });
  }, [props.message, seq]);

  if (isVoiceAgentTurn && markdownText == null) {
    return null;
  }

  // Structured user messages should render as standalone blocks (tool-card style),
  // not inside a chat bubble background, and without echoing displayText fallback.
  if (isStructuredOnly) {
    return (
      <View
        style={[styles.structuredUserMessageContainer, props.historical ? styles.historicalMessageContainer : null]}
        {...(isWeb
          ? {
              onPointerEnter: () => setIsMessageHovered(true),
              onPointerLeave: () => setIsMessageHovered(false),
            }
          : null)}
      >
        <View style={styles.structuredUserMessageContent}>
          {structuredNode}
          {isDiscarded ? (
            <Text selectable style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
          ) : null}
        </View>
        <View
          {...(isWeb ? {} : { pointerEvents: actionPointerEvents })}
          accessibilityElementsHidden={!showCopyButton}
          importantForAccessibility={showCopyButton ? 'auto' : 'no-hide-descendants'}
          style={[
            styles.messageActionContainer,
            !showCopyButton && styles.messageActionContainerHidden,
            isWeb ? { pointerEvents: actionPointerEvents } : null,
          ]}
        >
          {props.showRollbackAction ? (
            <TranscriptRollbackActionButton
              sessionId={props.sessionId}
              testID={`transcript-message-rollback:${props.message.id}`}
              onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
              onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
              style={[styles.rollbackMessageButton, Platform.OS === 'web' ? styles.webActionButton : null]}
              pressedStyle={styles.copyMessageButtonPressed}
            />
          ) : null}
          {showForkButton ? (
            <ForkMessageButton
              sessionId={props.sessionId}
              upToSeqInclusive={(forkSemantics?.upToSeqInclusive ?? seq!)}
              restoredDraftText={forkSemantics?.restoredDraftText ?? null}
              messageId={props.message.id}
              onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
              onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
            />
          ) : null}
          <CopyMessageButton
            markdown={copyText}
            testID={`transcript-message-copy:${props.message.id}`}
            onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
          />
        </View>
      </View>
    );
  }

  return (
    <View
      style={[styles.userMessageContainer, props.historical ? styles.historicalMessageContainer : null]}
      {...(isWeb
        ? {
            onPointerEnter: () => setIsMessageHovered(true),
            onPointerLeave: () => setIsMessageHovered(false),
          }
        : null)}
    >
      <View
        style={styles.userMessageWrapper}
        {...(isWeb ? {} : { pointerEvents: 'box-none' as const })}
      >
        <View style={[styles.userMessageBubble, isDiscarded && styles.userMessageBubbleDiscarded]}>
          <StructuredMessageBlock
            message={props.message as any}
            sessionId={props.sessionId}
            onJumpToAnchor={(target) => {
              router.push(buildSessionFileDeepLink({
                sessionId: props.sessionId,
                filePath: target.filePath,
                source: target.source,
                anchor: target.anchor,
              }));
            }}
          />
          <MarkdownView markdown={renderedMarkdownText} onOptionPress={handleOptionPress} textStyle={styles.transcriptMarkdownText} />
          {attachmentsMeta ? (
            <AttachmentsInlineImages
              sessionId={props.sessionId}
              attachments={attachmentsMeta.attachments}
              onOpenPath={(filePath) => {
                router.push(buildSessionFileDeepLink({ sessionId: props.sessionId, filePath }) as any);
              }}
            />
          ) : null}
          {nonImageAttachments.length > 0 ? (
            <AttachmentsMessageRow
              attachments={nonImageAttachments}
              onOpenPath={(filePath) => {
                router.push(buildSessionFileDeepLink({ sessionId: props.sessionId, filePath }) as any);
              }}
            />
          ) : null}
          {linkedWorkspaceFiles.length > 0 ? (
            <LinkedWorkspaceFilesRow sessionId={props.sessionId} paths={linkedWorkspaceFiles} />
          ) : null}
          {isDiscarded && (
            <Text selectable style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
          )}
          {/* {__DEV__ && (
            <Text style={styles.debugText}>{JSON.stringify(props.message.meta)}</Text>
          )} */}
        </View>
        <View
          {...(isWeb ? {} : { pointerEvents: actionPointerEvents })}
          accessibilityElementsHidden={!showCopyButton}
          importantForAccessibility={showCopyButton ? 'auto' : 'no-hide-descendants'}
          style={[
            styles.messageActionContainer,
            !showCopyButton && styles.messageActionContainerHidden,
            isWeb ? { pointerEvents: actionPointerEvents } : null,
          ]}
        >
          {props.showRollbackAction ? (
            <TranscriptRollbackActionButton
              sessionId={props.sessionId}
              testID={`transcript-message-rollback:${props.message.id}`}
              onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
              onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
              style={[styles.rollbackMessageButton, Platform.OS === 'web' ? styles.webActionButton : null]}
              pressedStyle={styles.copyMessageButtonPressed}
            />
          ) : null}
          {showForkButton ? (
            <ForkMessageButton
              sessionId={props.sessionId}
              upToSeqInclusive={(forkSemantics?.upToSeqInclusive ?? seq!)}
              restoredDraftText={forkSemantics?.restoredDraftText ?? null}
              messageId={props.message.id}
              onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
              onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
            />
          ) : null}
          <CopyMessageButton
            markdown={copyText}
            onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
          />
        </View>
      </View>
    </View>
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
  showRollbackAction?: boolean;
  historical?: boolean;
}) {
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const isWeb = Platform.OS === 'web';
  const router = useRouter();
  const isVoiceAgentTurn = React.useMemo(() => {
    const envelope = parseHappierMetaEnvelope(props.message.meta);
    return envelope?.kind === 'voice_agent_turn.v1';
  }, [props.message.meta]);
  const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
  const sessionThinkingInlinePresentation = useSetting('sessionThinkingInlinePresentation');
  const sessionThinkingInlineChrome = useSetting('sessionThinkingInlineChrome');
  const motion = useTranscriptMotion();
  const thinkingPulseEnabled =
    props.message.isThinking === true &&
    props.activeThinkingMessageId === props.message.id &&
    motion?.config.preset !== 'off' &&
    motion?.config.animateThinkingEnabled === true;

  const structuredNode = renderStructuredMessage({
    message: props.message,
    sessionId: props.sessionId,
    onJumpToAnchor: (target) => {
      router.push(buildSessionFileDeepLink({
        sessionId: props.sessionId,
        filePath: target.filePath,
        source: target.source,
        anchor: target.anchor,
      }));
    },
  });
  const isStructuredOnly = structuredNode != null;
  const unwrapLegacyThinkingWrapper = (text: string) => {
    const match = text.match(/^\*Thinking\.\.\.\*\n\n\*([\s\S]*)\*$/);
    return match ? match[1] : text;
  };
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
  const copyText = isStructuredOnly ? props.message.text : markdown;
  const linkedWorkspaceFiles = React.useMemo(
    () => extractWorkspaceFileMentions(markdown),
    [markdown],
  );

  const handleOptionPress = React.useCallback((option: Option) => {
    fireAndForget((async () => {
      try {
        if (!props.canSendMessages) {
          Modal.alert(t('session.sharing.viewOnly'), t('session.sharing.noEditPermission'));
          return;
        }
        await sync.submitMessage(props.sessionId, option.title);
      } catch (e) {
        Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
      }
    })(), { tag: 'MessageView.handleOptionPress.agentMessage' });
  }, [props.canSendMessages, props.sessionId]);

  if (props.message.isThinking && sessionThinkingDisplayMode === 'hidden') {
    return null;
  }

  const showCopyButton = shouldShowMessageCopyButton({ platformOS: Platform.OS, isMessageHovered, isCopyButtonHovered });
  const actionPointerEvents = resolveMessageActionPointerEvents({ isWeb, showCopyButton });
  const sessionReplayEnabled = useSetting('sessionReplayEnabled');
  const session = useSession(props.sessionId);
  const seq =
    typeof (props.message as any).seq === 'number' && Number.isFinite((props.message as any).seq)
      ? Math.trunc((props.message as any).seq)
      : null;
  const showForkButton = canForkFromMessage({ session, messageSeq: seq, replayEnabled: sessionReplayEnabled });
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

  const handleHoverIn = isWeb ? () => setIsMessageHovered(true) : undefined;
  const handleHoverOut = isWeb ? () => setIsMessageHovered(false) : undefined;

  return (
    <View
      style={[styles.agentMessageContainer, props.message.isThinking === true ? styles.agentMessageContainerThinking : null]}
      {...(isWeb ? {} : { pointerEvents: 'box-none' as const })}
      onPointerEnter={handleHoverIn}
      onPointerLeave={handleHoverOut}
    >
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
                  textStyle={thinkingMarkdownTextStyle}
                  variant="thinking"
                />
              </ThinkingTimelineRow>
          ) : (
            <MarkdownView
              markdown={markdown}
              onOptionPress={handleOptionPress}
              textStyle={props.message.isThinking ? styles.thinkingMarkdownText : styles.transcriptMarkdownText}
              variant={props.message.isThinking ? 'thinking' : undefined}
            />
          )
        )
      )}
      {linkedWorkspaceFiles.length > 0 && !isStructuredOnly ? (
        <LinkedWorkspaceFilesRow sessionId={props.sessionId} paths={linkedWorkspaceFiles} />
      ) : null}
      <View
        {...(isWeb ? {} : { pointerEvents: actionPointerEvents })}
        accessibilityElementsHidden={!showCopyButton}
        importantForAccessibility={showCopyButton ? 'auto' : 'no-hide-descendants'}
        style={[
          styles.messageActionContainer,
          !showCopyButton && styles.messageActionContainerHidden,
          isWeb ? { pointerEvents: actionPointerEvents } : null,
        ]}
      >
        {showForkButton ? (
          <ForkMessageButton
            sessionId={props.sessionId}
            upToSeqInclusive={(forkSemantics?.upToSeqInclusive ?? seq!)}
            restoredDraftText={forkSemantics?.restoredDraftText ?? null}
            messageId={props.message.id}
            onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
          />
        ) : null}
        <CopyMessageButton
          markdown={copyText}
          testID={`transcript-message-copy:${props.message.id}`}
          onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
          onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
        />
      </View>
    </View>
  );
}

function ForkMessageButton(props: {
  sessionId: string;
  upToSeqInclusive: number;
  restoredDraftText?: string | null;
  messageId: string;
  onHoverIn?: () => void;
  onHoverOut?: () => void;
}) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const session = useSession(props.sessionId);
  const [isForking, setIsForking] = React.useState(false);
  const hitSlop = Platform.OS === 'web' ? undefined : 15;
  const executionRunsEnabled = useFeatureEnabled('execution.runs');
  const sessionReplayStrategy = useSetting('sessionReplayStrategy');
  const sessionReplaySummaryRunner = useSetting('sessionReplaySummaryRunnerV1');
  const sessionReplayMaxSeedChars = useSetting('sessionReplayMaxSeedChars');

  const handlePress = React.useCallback(async () => {
    if (isForking) return;
    setIsForking(true);
    try {
      const replaySummaryRunner =
        executionRunsEnabled && sessionReplayStrategy === 'summary_plus_recent' && sessionReplaySummaryRunner
          ? sessionReplaySummaryRunner
          : undefined;
      const result = await forkSession({
        machineId: session?.metadata?.machineId,
        parentSessionId: props.sessionId,
        forkPoint: { type: 'seq', upToSeqInclusive: props.upToSeqInclusive },
        ...(typeof sessionReplayMaxSeedChars === 'number' ? { replayMaxSeedChars: sessionReplayMaxSeedChars } : {}),
        ...(replaySummaryRunner ? { replaySummaryRunner } : {}),
      } as any);
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
        fireAndForget(
          sync.patchSessionMetadataWithRetry(result.childSessionId, (metadata) =>
            writeForkInitialPromptV1({
              metadata: metadata as any,
              text: restored,
              createdAtMs: Date.now(),
              sourceMessageId: props.messageId,
            }) as any,
          ),
          { tag: 'ForkMessageButton.persistForkInitialPromptV1' },
        );
      }
      router.push((`/session/${result.childSessionId}`) as any);
      fireAndForget((async () => {
        try {
          await (sync as any).ensureSessionVisibleForMessageRoute?.(result.childSessionId);
        } catch {
          // best-effort
        }
      })(), { tag: 'ForkMessageButton.ensureChildVisible' });
    } catch (e) {
      Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToForkSession'));
    } finally {
      setIsForking(false);
    }
  }, [isForking, executionRunsEnabled, props.restoredDraftText, props.sessionId, props.upToSeqInclusive, router, session?.metadata?.machineId, sessionReplayMaxSeedChars, sessionReplayStrategy, sessionReplaySummaryRunner]);

  if (!session) return null;

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
        pressed && styles.copyMessageButtonPressed,
        isForking && styles.copyMessageButtonPressed,
      ]}
    >
      {isForking ? (
        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
      ) : (
        <Ionicons
          name="git-branch-outline"
          size={12}
          color={theme.colors.textSecondary}
        />
      )}
    </Pressable>
  );
}

function CopyMessageButton(props: { markdown: string; testID?: string; onHoverIn?: () => void; onHoverOut?: () => void }) {
  const { theme } = useUnistyles();
  const [copied, setCopied] = React.useState(false);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hitSlop = Platform.OS === 'web' ? undefined : 15;

  const markdown = props.markdown || '';
  const isCopyable = markdown.trim().length > 0;

  const handlePress = React.useCallback(async () => {
    if (!isCopyable) return;

    try {
      await Clipboard.setStringAsync(markdown);
      setCopied(true);

      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
      resetTimer.current = setTimeout(() => {
        setCopied(false);
      }, 1200);
    } catch (error) {
      console.error('Failed to copy message:', error);
      Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
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
        pressed && styles.copyMessageButtonPressed,
      ]}
    >
      <Ionicons
        name={copied ? "checkmark-outline" : "copy-outline"}
        size={12}
        color={copied ? theme.colors.success : theme.colors.textSecondary}
      />
    </Pressable>
  );
}

function resolveMessageActionPointerEvents(params: { isWeb: boolean; showCopyButton: boolean }) {
  const { showCopyButton } = params;
  return showCopyButton ? ('auto' as const) : ('none' as const);
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  activeThinkingMessageId: string | null;
  getMessageById?: (id: string) => Message | null;
	  interaction?: {
	    canSendMessages: boolean;
	    canApprovePermissions: boolean;
	    permissionDisabledReason?: 'public' | 'readOnly' | 'inactive' | 'notGranted';
	    disableToolNavigation?: boolean;
	  };
	  showRollbackAction?: boolean;
	  historical?: boolean;
	}) {
  const router = useRouter();
  const toolViewTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
  const messagesById = useSessionMessagesById(props.sessionId);
  const reducerState = useSessionMessagesReducerState(props.sessionId);
  if (!props.message.tool) {
    return null;
  }
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
        toolViewTimelineChromeMode === 'activity_feed' ? styles.toolContainerFeed : styles.toolContainerCards,
      ]}
    >
        <StructuredMessageBlock
          message={props.message as any}
          sessionId={props.sessionId}
          onJumpToAnchor={(target) => {
            router.push(buildSessionFileDeepLink({
              sessionId: props.sessionId,
              filePath: target.filePath,
              source: target.source,
              anchor: target.anchor,
            }));
          }}
        />
      {toolViewTimelineChromeMode === 'activity_feed' ? (
        <ToolTimelineRow
          tool={props.message.tool}
          metadata={props.metadata}
          messages={props.message.children}
          sessionId={props.sessionId}
          messageId={toolRouteMessageId}
          interaction={props.interaction}
        />
      ) : (
        <ToolView
          tool={props.message.tool}
          metadata={props.metadata}
          messages={props.message.children}
          sessionId={props.sessionId}
          messageId={toolRouteMessageId}
          interaction={props.interaction}
        />
      )}
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
      maxWidth: '100%',
      alignSelf: 'flex-end',
      position: 'relative',
      paddingBottom: 22,
    },
    userMessageBubble: {
      backgroundColor: theme.colors.userMessageBackground,
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
    color: theme.colors.agentEventText,
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
  messageActionContainer: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  messageActionContainerHidden: {
    opacity: 0,
  },
  webActionButton: {
    padding: 6,
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
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
  transcriptMarkdownText: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 0,
    marginBottom: 0,
  },
    thinkingLabel: {
      marginBottom: 6,
      marginLeft: 2,
      color: theme.colors.agentEventText,
      fontSize: 12,
      fontStyle: 'italic',
      opacity: 0.78,
    },
      thinkingMarkdownText: {
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
        opacity: 0.9,
            fontSize: 14,
            lineHeight: 20,
            marginTop: 0,
            marginBottom: 0,
      },
      thinkingPlainText: {
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
        opacity: 0.9,
        fontSize: 14,
        lineHeight: 20,
      },
      thinkingMarkdownTextCard: {
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
        opacity: 0.95,
            fontSize: 14,
            lineHeight: 20,
            marginTop: 0,
            marginBottom: 0,
      },
      thinkingPlainTextCard: {
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
        opacity: 0.95,
        fontSize: 14,
        lineHeight: 20,
      },
    }));
