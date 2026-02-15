import * as React from "react";
import { View, Text, Pressable, Platform } from "react-native";
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
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { Option } from '@/components/markdown/MarkdownView';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { isCommittedMessageDiscarded } from "@/utils/sessions/discardedCommittedMessages";
import { shouldShowMessageCopyButton } from '@/components/sessions/transcript/messageCopyVisibility';
import { renderStructuredMessage, StructuredMessageBlock } from '@/components/sessions/transcript/structured/StructuredMessageBlock';
import { useRouter } from 'expo-router';
import { buildSessionFileDeepLink } from '@/utils/url/sessionFileDeepLink';

export const MessageView = (props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  interaction?: {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted';
    disableToolNavigation?: boolean;
  };
}) => {
  return (
    <View style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
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
  getMessageById?: (id: string) => Message | null;
  interaction?: {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted';
    disableToolNavigation?: boolean;
  };
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return <UserTextBlock message={props.message} metadata={props.metadata} sessionId={props.sessionId} canSendMessages={props.interaction?.canSendMessages ?? true} />;

    case 'agent-text':
      return <AgentTextBlock message={props.message} sessionId={props.sessionId} canSendMessages={props.interaction?.canSendMessages ?? true} />;

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
        interaction={props.interaction}
      />;

    case 'agent-event':
      return <AgentEventBlock event={props.message.event} metadata={props.metadata} />;


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
}) {
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const isWeb = Platform.OS === 'web';
  const router = useRouter();
  const isDiscarded = isCommittedMessageDiscarded(props.metadata, props.message.localId);

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

  const handleOptionPress = React.useCallback((option: Option) => {
    void (async () => {
      try {
        if (!props.canSendMessages) {
          Modal.alert(t('session.sharing.viewOnly'), t('session.sharing.noEditPermission'));
          return;
        }
        await sync.submitMessage(props.sessionId, option.title);
      } catch (e) {
        Modal.alert(t('common.error'), e instanceof Error ? e.message : 'Failed to send message');
      }
    })();
  }, [props.canSendMessages, props.sessionId]);

  const showCopyButton = shouldShowMessageCopyButton({ platformOS: Platform.OS, isMessageHovered, isCopyButtonHovered });
  const copyText = isStructuredOnly ? props.message.text : (props.message.displayText || props.message.text);

  // Structured user messages should render as standalone blocks (tool-card style),
  // not inside a chat bubble background, and without echoing displayText fallback.
  if (isStructuredOnly) {
    return (
      <View style={styles.structuredUserMessageContainer}>
        <View style={styles.structuredUserMessageContent}>
          {structuredNode}
          {isDiscarded ? (
            <Text style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
          ) : null}
        </View>
        <View
          pointerEvents={showCopyButton ? 'auto' : 'none'}
          accessibilityElementsHidden={!showCopyButton}
          importantForAccessibility={showCopyButton ? 'auto' : 'no-hide-descendants'}
          style={[
            styles.messageActionContainer,
            !showCopyButton && styles.messageActionContainerHidden,
          ]}
        >
          <CopyMessageButton
            markdown={copyText}
            onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.userMessageContainer}>
      <Pressable
        style={styles.userMessageWrapper}
        onHoverIn={isWeb ? () => setIsMessageHovered(true) : undefined}
        onHoverOut={isWeb ? () => setIsMessageHovered(false) : undefined}
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
          <MarkdownView markdown={props.message.displayText || props.message.text} onOptionPress={handleOptionPress} />
          {isDiscarded && (
            <Text style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
          )}
          {/* {__DEV__ && (
            <Text style={styles.debugText}>{JSON.stringify(props.message.meta)}</Text>
          )} */}
        </View>
        <View
          pointerEvents={showCopyButton ? 'auto' : 'none'}
          accessibilityElementsHidden={!showCopyButton}
          importantForAccessibility={showCopyButton ? 'auto' : 'no-hide-descendants'}
          style={[
            styles.messageActionContainer,
            !showCopyButton && styles.messageActionContainerHidden,
          ]}
        >
          <CopyMessageButton
            markdown={copyText}
            onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
          />
        </View>
      </Pressable>
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
  canSendMessages: boolean;
}) {
  const [isMessageHovered, setIsMessageHovered] = React.useState(false);
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const isWeb = Platform.OS === 'web';
  const router = useRouter();
  const showThinkingMessages = useFeatureEnabled('messages.thinkingVisibility');

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
  const copyText = isStructuredOnly ? props.message.text : props.message.text;

  const handleOptionPress = React.useCallback((option: Option) => {
    void (async () => {
      try {
        if (!props.canSendMessages) {
          Modal.alert(t('session.sharing.viewOnly'), t('session.sharing.noEditPermission'));
          return;
        }
        await sync.submitMessage(props.sessionId, option.title);
      } catch (e) {
        Modal.alert(t('common.error'), e instanceof Error ? e.message : 'Failed to send message');
      }
    })();
  }, [props.canSendMessages, props.sessionId]);

  // Hide thinking messages unless the feature flag is enabled.
  if (props.message.isThinking && !showThinkingMessages) {
    return null;
  }

  const showCopyButton = shouldShowMessageCopyButton({ platformOS: Platform.OS, isMessageHovered, isCopyButtonHovered });

  return (
    <Pressable
      style={styles.agentMessageContainer}
      onHoverIn={isWeb ? () => setIsMessageHovered(true) : undefined}
      onHoverOut={isWeb ? () => setIsMessageHovered(false) : undefined}
    >
      {structuredNode}
      {isStructuredOnly ? null : <MarkdownView markdown={props.message.text} onOptionPress={handleOptionPress} />}
      <View
        pointerEvents={showCopyButton ? 'auto' : 'none'}
        accessibilityElementsHidden={!showCopyButton}
        importantForAccessibility={showCopyButton ? 'auto' : 'no-hide-descendants'}
        style={[
          styles.messageActionContainer,
          !showCopyButton && styles.messageActionContainerHidden,
        ]}
      >
        <CopyMessageButton
          markdown={copyText}
          onHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
          onHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
        />
      </View>
    </Pressable>
  );
}

function CopyMessageButton(props: { markdown: string; onHoverIn?: () => void; onHoverOut?: () => void }) {
  const { theme } = useUnistyles();
  const [copied, setCopied] = React.useState(false);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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
      onPress={handlePress}
      onHoverIn={props.onHoverIn}
      onHoverOut={props.onHoverOut}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('common.copy')}
      style={({ pressed }) => [
        styles.copyMessageButton,
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

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
}) {
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{props.event.message}</Text>
      </View>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return t('message.unknownTime');
      }
    };

    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>
          {t('message.usageLimitUntil', { time: formatTime(props.event.endsAt) })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.agentEventContainer}>
      <Text style={styles.agentEventText}>{t('message.unknownEvent')}</Text>
    </View>
  );
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  interaction?: {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted';
    disableToolNavigation?: boolean;
  };
}) {
  const router = useRouter();
  if (!props.message.tool) {
    return null;
  }
  return (
    <View style={styles.toolContainer}>
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
      <ToolView
        tool={props.message.tool}
        metadata={props.metadata}
        messages={props.message.children}
        sessionId={props.sessionId}
        messageId={props.interaction?.disableToolNavigation ? undefined : props.message.id}
        interaction={props.interaction}
      />
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
    paddingBottom: 18,
    position: 'relative',
  },
  structuredUserMessageContent: {
    maxWidth: '100%',
  },
  userMessageWrapper: {
    maxWidth: '100%',
    alignSelf: 'flex-end',
    position: 'relative',
    paddingBottom: 18,
  },
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    maxWidth: '100%',
  },
  userStructuredMessageWrapper: {
    maxWidth: '100%',
  },
  userMessageBubbleDiscarded: {
    opacity: 0.65,
  },
  discardedCommittedMessageLabel: {
    marginTop: 6,
    fontSize: 12,
    color: theme.colors.agentEventText,
  },
  agentMessageContainer: {
    marginHorizontal: 16,
    paddingBottom: 18,
    borderRadius: 16,
    alignSelf: 'flex-start',
    position: 'relative',
    maxWidth: '100%',
  },
  agentEventContainer: {
    marginHorizontal: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  toolContainer: {
    marginHorizontal: 8,
  },
  messageActionContainer: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    zIndex: 10,
  },
  messageActionContainerHidden: {
    opacity: 0,
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
}));
