import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import * as React from "react";
import { useShallow } from 'zustand/react/shallow';
import { HappierProvenanceChip } from '@happier-dev/plugin-ui/presentation';
import { View, Pressable, Platform } from 'react-native';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { TranscriptFindMessageProvider, useTranscriptFindActive, useTranscriptFindRow } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@happier-dev/session-core/messages";
import { Metadata } from '@happier-dev/session-core/state';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { useLayoutMaxWidthStyle } from "@/components/ui/layout/layout";
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { selectToolApprovalRequestsForMessages } from '@/components/tools/shell/views/toolApprovalPromptMatching';
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
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { useMessageStructuredReferences } from '@/components/sessions/transcript/references/messageStructuredReferences';
import { StructuredReferencesRow } from '@/components/sessions/transcript/references/StructuredReferencesRow';
import { useMessageInlineReferences } from '@/components/sessions/transcript/references/useMessageInlineReferences';
import { ComposerAttachmentFallbackRow } from '@/components/sessions/transcript/composerAttachments/ComposerAttachmentFallbackRow';
import { useMessageComposerAttachments } from '@/components/sessions/transcript/composerAttachments/messageComposerAttachments';
import { useTranscriptMotion } from '@/components/sessions/transcript/motion/TranscriptMotionContext';
import { PeerMessageRow } from '@/components/sessions/transcript/peer/PeerMessageRow';
import { ThinkingTimelineRow } from '@/components/sessions/transcript/thinking/ThinkingTimelineRow';
import { TranscriptEventRow, TranscriptHostWakeNotice } from '@/components/sessions/transcript/events/TranscriptEventRow';
import { projectWorkerCardDelivery } from '@/components/sessions/transcript/events/followWorkerCardDelivery';
import type { FollowDeliveryProjectionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowDeliveryProjectionV1';
import { isRuntimeIssueMessageMeta } from '@/components/sessions/transcript/events/runtimeIssueMessage';
import { isHostAuthoredInputMeta, readHostFollowInputMeta } from '@/sync/domains/session/input/hostAuthoredInput';
import type { AgentEvent } from "@happier-dev/session-core/raw";
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import { parseHappierMetaEnvelope } from '@/components/sessions/transcript/structured/happierMetaEnvelope';
import { AttachmentsMessageRow } from '@/components/sessions/attachments/messages/AttachmentsMessageRow';
import { AttachmentsInlineImages } from '@/components/sessions/attachments/messages/AttachmentsInlineImages';
import { parseSessionMediaMessageMeta } from '@/sync/domains/session/media/sessionMediaMessageMeta';
import { SessionMediaInlineImages } from '@/components/sessions/media/SessionMediaInlineImages';
import { resolveSessionMediaInlineRenderableImageMimeType } from '@/components/sessions/media/presentation';
import { readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import { CommittedMessageActions } from '@/components/sessions/transcript/messageActions/CommittedMessageActions';
import { presentDiscussionSecondOpinion } from '@/components/discussions/DiscussionSecondOpinionSheet';
import type { DiscussionSecondOpinionSourceV1 } from '@happier-dev/protocol/discussions/secondOpinion';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { readCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { resolveMessagePinAvailability } from '@/components/sessions/transcript/messageActions/resolveMessagePinAvailability';
import type { PersistedSessionMessagePinV1 } from "@happier-dev/session-core/pins";
import { resolveToolRowPinAction } from '@/components/sessions/transcript/toolCalls/ToolCallPinAction';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useStreamingTextSmoothing } from '@/components/sessions/transcript/streaming/useStreamingTextSmoothing';
import { readStreamSegmentMetaV1 } from "@happier-dev/session-core/reducer";
import { resolveTranscriptMessageServerId } from '@/components/sessions/transcript/source/resolveTranscriptMessageServerId';
import { useTranscriptFileLinks } from '@/components/sessions/transcript/useTranscriptFileLinks';
import {
  deriveTranscriptForkCommonForInteraction,
  type TranscriptForkCommon,
  type TranscriptMessageDisplayCommon,
  type TranscriptToolChromeCommon,
  type TranscriptMessageRouteCommon,
  useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { getStorage, useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createWorkflowInvocationRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { TranscriptJumpAttention } from '@/components/sessions/transcript/navigation/TranscriptJumpHighlightOverlay';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { UserMessageBubble, userMessageBubbleAlignerStyle } from './UserMessageBubble';

const EMPTY_FOLLOW_DELIVERY_BY_LOCAL_ID: ReadonlyMap<string, FollowDeliveryProjectionV1 | null> = new Map();
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { isRecoveredHistoryTranscriptObservation } from "@happier-dev/session-core/messages";
import type { TranscriptEventEmphasis } from '@/components/sessions/transcript/events/transcriptEventEmphasis';
import { Icon } from '@/components/ui/icons/Icon';
import { ReturnedAnswerQuote, readReturnedAnswer } from '@/components/sessions/transcript/returnedAnswer/ReturnedAnswerQuote';
import { SessionAskRecord } from '@/components/sessions/transcript/askRecord/SessionAskRecord';
import { isSessionMessageInvocationAnchor } from '@/components/sessions/transcript/references/readSessionMessageInvocation';
import { Typography } from '@/constants/Typography';
import { SessionMessageAccountByline } from './SessionMessageAccountByline';
import type { ToolViewDisplaySettings } from '@/components/tools/shell/views/toolViewDisplaySettings';
import { TranscriptTurnChangesCard } from '@/components/sessions/files/turnChanges/TranscriptTurnChangesCard';
import { deriveToolMessageDisplay } from '@/components/sessions/transcript/toolCalls/deriveToolMessageDisplay';
import { projectReviewToolMessage, readReviewToolRunId } from '@/components/sessions/reviews/messages/projectReviewToolMessage';
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';
import { useTranscriptRowContentDemand } from '@/components/sessions/transcript/viewport/visibility/TranscriptRowContentDemand';
import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';

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

export function formatTranscriptMessageTimestamp(createdAt: number): string | null {
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

type WorkflowMessageProvenanceProps = Readonly<{
  messageId: string;
  runId: string;
  invocationRecordId: string;
  /** The step's visible number, stamped on the provenance by the host that ran it. */
  stepOrdinal?: string;
  serverId?: string | null;
  inline?: boolean;
}>;

function AppWorkflowMessageProvenanceAttribution(props: WorkflowMessageProvenanceProps) {
  const transcriptSource = useSessionTranscriptSource();
  const serverId = props.serverId ?? transcriptSource.serverId;
  // The transcript owner batches missing facts. Each chip reads only its exact title and authored
  // ordinal; unrelated Runs/invocations never repaint the message. A host-stamped number wins.
  const display = getStorage()(useShallow((state) => {
    const inScope = !serverId || Boolean(state.profileScope
      && areServerProfileIdentifiersEquivalent(state.profileScope.serverId, serverId));
    const run = inScope ? state.workflowRunsById[workflowRunStoreKey(props.runId)] : undefined;
    return {
      inScope,
      title: run?.metadata?.kind === 'available' ? run.metadata.value.title : null,
      stepOrdinal: props.stepOrdinal ?? (inScope
        ? state.workflowRunInvocationsByRunId[workflowRunStoreKey(props.runId)]?.factsById[props.invocationRecordId]?.stepOrdinal : undefined),
    };
  }));
  const source = display.title ?? t('message.provenanceWorkflow');
  const label = display.stepOrdinal === undefined
    ? t('message.provenanceFrom', { source })
    : t('sessionWork.scheduled.provenanceWorkflowStep', { source, step: display.stepOrdinal });
  const testID = `transcript-provenance-attribution:${props.messageId}`;
  if (!display.inScope || transcriptSource.navigate === null) {
    return <MessageProvenanceAttributionLabel testID={testID} label={label} />;
  }
  return <WorkflowMessageProvenanceChip {...props} label={label}
    onPress={() => transcriptSource.navigate?.(createWorkflowInvocationRoute(props.runId, props.invocationRecordId, serverId))} />;
}

function WorkflowMessageProvenanceChip(props: WorkflowMessageProvenanceProps & Readonly<{ label: string; onPress?: () => void }>) {
  const { theme } = useUnistyles();
  return (
    <View style={props.inline ? styles.workflowProvenanceInline : styles.workflowProvenanceRow}>
      <HappierProvenanceChip
        testID={`transcript-provenance-attribution:${props.messageId}`}
        label={props.label}
        accessibilityLabel={props.label}
        onPress={props.onPress}
        // The chip owner draws the capsule ring; the transcript only supplies ink. It hangs from the
        // message's trailing edge (lab lane12-final `b-habit Q`): a quiet ring on the page, no fill.
        colors={{ foreground: theme.colors.text.secondary, background: 'transparent',
          border: theme.colors.border.default, focus: theme.colors.border.focus }}
        labelContent={<Text numberOfLines={1} ellipsizeMode="tail" style={styles.workflowProvenanceText}>{props.label}</Text>}
      />
    </View>
  );
}

export function WorkflowMessageProvenanceAttribution(props: WorkflowMessageProvenanceProps) {
  const source = useSessionTranscriptSource();
  // Static/public transcripts never subscribe to private Account Run content.
  return source.kind === 'app'
    ? <AppWorkflowMessageProvenanceAttribution {...props} />
    : props.inline ? <WorkflowMessageProvenanceChip {...props} label={props.stepOrdinal === undefined
      ? t('message.provenanceFrom', { source: t('message.provenanceWorkflow') })
      : t('sessionWork.scheduled.provenanceWorkflowStep', { source: t('message.provenanceWorkflow'), step: props.stepOrdinal })} />
    : <MessageProvenanceAttributionLabel
      testID={`transcript-provenance-attribution:${props.messageId}`}
      label={t('message.provenanceFrom', { source: t('message.provenanceWorkflow') })}
    />;
}

function MessageProvenanceAttribution(props: Readonly<{ message: Message; serverId?: string | null }>) {
  const provenance = React.useMemo(() => props.message.kind === 'user-text'
    ? readSessionMessageProvenance(props.message.meta, 'stored')
    : null, [props.message]);
  // Authenticated Account actors and descriptive producer provenance are
  // independent: producer metadata never invents or suppresses a human actor.
  // Input the person typed (in the app, the CLI or by voice) or a host relayed carries no origin label;
  // only a producer that is not the person (a Workflow, an Automation, a Session, a plugin) is named.
  if (!provenance || provenance.kind === 'host' || provenance.kind === 'happierApp'
    || provenance.kind === 'cli' || provenance.kind === 'voice') return null;
  if (provenance.kind === 'workflow_invocation') {
    return <WorkflowMessageProvenanceAttribution
      messageId={props.message.id}
      runId={provenance.runId}
      invocationRecordId={provenance.invocationRecordId}
      {...(provenance.stepOrdinal === undefined ? {} : { stepOrdinal: provenance.stepOrdinal })}
      serverId={props.serverId}
    />;
  }
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
    : t('message.provenanceFrom', { source: t('message.provenanceAutomation') });
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

type MessageViewProps = {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  serverId?: string | null;
  layoutContext?: 'transcript' | 'tool_calls_group';
  /** A containing turn header already renders the exact same attribution. */
  hideProvenanceAttribution?: boolean;
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
  toolRouteCommon: TranscriptMessageRouteCommon;
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
  // Recognized returns use the quote even when the host delivered the input.
  // Carry this one classification into rendering and attribution.
  const returnedAnswer = React.useMemo(() => readReturnedAnswer(props.message), [props.message]);
  if (shouldHideVoiceAgentTurnMessage(props.message)) return null;
  // Placeholders for content we could not render are dropped here rather than inside the message
  // blocks, so toggling developer diagnostics never changes the hook order of a mounted row.
  if (resolveMessageUnsupportedContentPresentation(
    props.message,
    props.messageDisplayCommon.debugInformationEnabled,
  ) === 'hidden') return null;
  const isHostFollowInput = props.message.kind === 'user-text' && isHostAuthoredInputMeta(props.message.meta);
  // Follow's admitted model prompt remains in storage for the agent. Its exact
  // delivery facts and cards own the person-visible notice, never prompt prose.
  if (props.message.kind === 'user-text' && !returnedAnswer
    && readHostFollowInputMeta(props.message.meta) && !props.hostWakeCount) return null;
  return (
    <View style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
      <View style={messageContentStyle}>
        <RecoveredHistoryIndicator message={props.message} />
        {props.message.kind === 'user-text' && !isHostFollowInput && (
          <SessionMessageAccountByline
            messageId={props.message.id}
            actor={props.message.accountActor}
            viewerScope={props.messageDisplayCommon.accountActorViewerScope ?? null}
            hasOtherNamedCollaborator={props.messageDisplayCommon.hasOtherNamedCollaborator === true}
          />
        )}
        {!props.hideProvenanceAttribution && !returnedAnswer && <MessageProvenanceAttribution
          message={props.message}
          serverId={resolveTranscriptMessageServerId(props.sessionId, props.serverId, props.forkCommon.sessionForkSupportSource?.serverId)}
        />}
        <RenderBlock
          message={props.message}
          isHostFollowInput={isHostFollowInput}
          returnedAnswer={returnedAnswer}
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
  isHostFollowInput: boolean;
  returnedAnswer: ReturnType<typeof readReturnedAnswer>;
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
  toolRouteCommon: TranscriptMessageRouteCommon;
}): React.ReactElement | null {
  const transcriptSource = useSessionTranscriptSource();
  switch (props.message.kind) {
    case 'user-text':
      if (props.isHostFollowInput && !props.returnedAnswer) {
        if (readHostFollowInputMeta(props.message.meta)) {
          return props.hostWakeCount ? <TranscriptHostWakeNotice count={props.hostWakeCount} /> : null;
        }
        return <TranscriptTextNoticeRow message={props.message} sessionId={props.sessionId} serverId={props.serverId} />;
      }
      return (
        <UserTextBlock
          message={props.message}
          returnedAnswer={props.returnedAnswer}
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
      if (!props.message.isThinking && isRuntimeIssueMessageMeta(props.message.meta)) {
        return <TranscriptTextNoticeRow message={props.message} sessionId={props.sessionId} serverId={props.serverId} tone="failure" />;
      }
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
      // A composer Ask or Send is one record in the asker's own transcript (its text, targets and results).
      if (isSessionMessageInvocationAnchor(props.message)) {
        return <SessionAskRecord message={props.message} sessionId={props.sessionId}
          serverId={props.toolChromeCommon.serverId ?? props.serverId ?? null} />;
      }
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
            followDeliveryProjection={props.message.event.type === 'worker-update'
              ? projectWorkerCardDelivery({ ...props.message.event,
                  ownProjection: props.message.followDeliveryProjection },
                  props.toolRouteCommon.followDeliveryByLocalId ?? EMPTY_FOLLOW_DELIVERY_BY_LOCAL_ID)
              : props.message.followDeliveryProjection}
            messageId={props.message.id}
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

/** Host notices reuse the event row without changing the persisted agent-input role. */
function TranscriptTextNoticeRow(props: Readonly<{
  message: AgentTextMessage | UserTextMessage;
  sessionId: string;
  serverId?: string | null;
  tone?: 'failure';
}>) {
  const transcriptSource = useSessionTranscriptSource();
  const find = useTranscriptFindRow(props.message.id);
  const findSourceRanges = find?.blocks.find((block) => block.id === 'text')?.sourceRanges;
  const event = React.useMemo<AgentEvent>(() => ({ type: 'message', message: props.message.text }), [props.message.text]);
  return (
    <TranscriptJumpAttention
      sessionAddress={transcriptSource.sessionId === props.sessionId ? normalizeSessionAddress(transcriptSource.serverId, props.sessionId) : null}
      routeMessageId={buildMessageRouteId(props.message)}
      seq={resolveTranscriptMessageSeq(props.message)}
      radius={TRANSCRIPT_EVENT_ROW_HIGHLIGHT_RADIUS}
      style={styles.eventHighlightSurface}
    >
      <TranscriptEventRow
        event={event}
        tone={props.tone}
        findSourceRanges={findSourceRanges}
        messageId={props.message.id}
        sessionId={props.sessionId}
        serverId={props.serverId}
        createdAt={props.message.createdAt}
      />
    </TranscriptJumpAttention>
  );
}

function UserTextBlock(props: {
  message: UserTextMessage;
  returnedAnswer: ReturnType<typeof readReturnedAnswer>;
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
  const { isHovered: isMessageHovered, hoverProps } = useRowActionHoverHost();
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const [isActionRowFocused, setIsActionRowFocused] = React.useState(false);
  const handleActionsFocus = React.useCallback(() => setIsActionRowFocused(true), []);
  const handleActionsBlur = React.useCallback(() => setIsActionRowFocused(false), []);
  const isWeb = Platform.OS === 'web';
	  const transcriptSource = useSessionTranscriptSource();
  const sourceCanSendMessages = transcriptSource.useInteraction().canSendMessages;
	  const isDiscarded = isCommittedMessageDiscarded(props.metadata, props.message.localId);
  const { onJumpToAnchor: handleJumpToAnchor, onMarkdownLinkPress: handleMarkdownLinkPress, openPath: handleOpenAttachmentPath } = useTranscriptFileLinks({
    sessionId: props.sessionId, serverId: props.serverId, canOpenFiles: props.canOpenFiles,
    workspacePath: props.messageDisplayCommon.workspacePath,
    routeMessageId: buildMessageRouteId(props.message), seq: resolveTranscriptMessageSeq(props.message),
  });

  const messageDisplay = React.useMemo(() => resolveTranscriptMessageDisplayText(props.message, {
    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
    preserveInlineReferences: true,
  }), [props.message, props.messageDisplayCommon.debugInformationEnabled]);
  const isVoiceAgentTurn = messageDisplay.isVoiceAgentTurn;
  // An answer another session returned here is quoted as information, not drawn as the person's bubble.
  const returnedAnswer = props.returnedAnswer;

  // Row-local hover/focus state must not re-admit the message's structured content.
  const structuredNode = React.useMemo(() => renderStructuredMessage({
	    message: props.message,
	    sessionId: props.sessionId,
        serverId: props.serverId,
        interaction: props.interaction,
	    onJumpToAnchor: handleJumpToAnchor,
	    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
	  }), [props.message, props.sessionId, props.serverId, props.interaction, handleJumpToAnchor,
    props.messageDisplayCommon.debugInformationEnabled]);
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

  const unsupportedContentMeta = React.useMemo(
    () => readUnsupportedContentMeta(props.message.meta),
    [props.message.meta],
  );
  const unsupportedContentText = messageDisplay.unsupportedContentText;
  const markdownText = messageDisplay.text;
  const renderedMarkdownText = markdownText ?? props.message.displayText ?? props.message.text;

  // One projection for both branches (D-6). Sessions come only from the envelope (INV-5);
  // files additionally keep the permanent text scan (D-5).
  const structuredReferenceProjection = useMessageStructuredReferences({
    meta: props.message.meta,
    text: renderedMarkdownText,
  });
  const structuredReferences = structuredReferenceProjection.row;
  const composerAttachments = useMessageComposerAttachments(props.message.meta, isStructuredOnly ? undefined : structuredReferenceProjection.inline);
  // D5: a message composed with inline references shows its pictures numbered above the text and
  // its chips in place; a legacy (0.2) message keeps today's composition.
  const inlineComposition = structuredReferenceProjection.inline.size > 0
    || (attachmentsMeta?.attachments.some((attachment) => attachment.id !== undefined) ?? false);
  const inlinePictureKeys = React.useMemo(() => [
    ...(attachmentsMeta?.attachments ?? []).map((attachment) => ({ path: attachment.path, numberKey: attachment.id ?? attachment.path })),
    ...(sessionMediaMeta?.inlineMedia ?? []).flatMap((media) => ('path' in media ? [{ path: media.path, numberKey: `session-media:${media.id}` }] : [])),
  ], [attachmentsMeta, sessionMediaMeta]);
  const { inlineReferences, pictures: inlinePictures } = useMessageInlineReferences({
    projection: structuredReferenceProjection,
    pictures: inlinePictureKeys,
    serverId: props.serverId,
    openPath: handleOpenAttachmentPath,
  });

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

  const selectableMessage = React.useMemo(() => {
    if (isDiscarded) return null;
    const base = resolveSelectableMessageText({
      message: props.message,
      isStructuredOnly,
      hasAttachmentBlockToStrip: attachmentsMeta != null,
    });
    return base && unsupportedContentText != null ? { ...base, text: unsupportedContentText } : base;
  }, [attachmentsMeta, isDiscarded, isStructuredOnly, props.message, props.messageRevision, unsupportedContentText]);
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
    pinActionEnabled: props.messageDisplayCommon.transcriptMessagePinActionEnabled,
  }), [props.message, props.messagePins, props.sessionId, props.messageDisplayCommon.transcriptMessagePinActionEnabled]);
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
  const timestampGlyph = messageDisplay.isVoiceAgentTurn ? 'planet' as const : undefined;
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
      <CommittedMessageActions
      message={props.message} sessionId={props.sessionId} serverId={props.serverId}
      selectableText={selectableMessage} copyText={copyText} isStructuredOnly={isStructuredOnly} hasUnsupportedContent={unsupportedContentMeta != null}
      canFork={props.canFork} forkCommon={props.forkCommon} isForkAllowed={props.isForkAllowed}
      settings={props.messageDisplayCommon} rollbackAction={props.rollbackAction}
      messagePins={props.messagePins} onToggleMessagePin={props.onToggleMessagePin}
      showActions={showMessageActions} showPinAction={showPinButton}
      timestampText={timestampText} timestampGlyph={timestampGlyph} invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
      onActionsFocus={handleActionsFocus} onActionsBlur={handleActionsBlur}
      onActionHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
      onActionHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
      hoverProps={hoverProps}
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
                routeMessageId={buildMessageRouteId(props.message)}
                seq={resolveTranscriptMessageSeq(props.message)}
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

  const bubblePictures = (
          <>
            {attachmentsMeta ? (
              <AttachmentsInlineImages
                sessionId={props.sessionId}
                attachments={attachmentsMeta.attachments}
                onOpenPath={handleOpenAttachmentPath}
                fileOpenEnabled={props.canOpenFiles}
                mediaPreviewEnabled={props.canPreviewMedia}
                {...(inlineComposition ? { numbers: inlinePictures.numbers, ringedPath: inlinePictures.ringedPath, onPreviewLoaded: inlinePictures.onPreviewLoaded } : {})}
              />
            ) : null}
            {sessionMediaMeta ? (
              <SessionMediaInlineImages
                sessionId={props.sessionId}
                media={sessionMediaMeta.inlineMedia}
                onOpenPath={handleOpenAttachmentPath}
                fileOpenEnabled={props.canOpenFiles}
                mediaPreviewEnabled={props.canPreviewMedia}
                {...(inlineComposition ? { numbers: inlinePictures.numbers, ringedPath: inlinePictures.ringedPath, onPreviewLoaded: inlinePictures.onPreviewLoaded } : {})}
              />
            ) : null}
          </>
  );
  const bubbleContent = (
          <>
            <MarkdownView codeBlockStateKey={JSON.stringify([props.sessionId, props.message.id])} markdown={renderedMarkdownText} findActive={findActive} findSourceRanges={findSourceRanges} renderCacheKey={buildMessageMarkdownRenderCacheKey(props.message.id, props.messageRevision)} onOptionPress={handleOptionPress} onOptionLongPress={handleOptionLongPress} onLinkPress={handleMarkdownLinkPress} selectable={true} profile="transcript" textStyle={styles.transcriptMarkdownText} inlineReferences={inlineReferences} />
            {inlineComposition ? null : bubblePictures}
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
                routeMessageId={buildMessageRouteId(props.message)}
                seq={resolveTranscriptMessageSeq(props.message)}
              />
            ) : null}
            {isDiscarded && (
              <Text selectable style={styles.discardedCommittedMessageLabel}>{t('message.discarded')}</Text>
            )}
          </>
  );

  return (
    <CommittedMessageActions
      message={props.message} sessionId={props.sessionId} serverId={props.serverId}
      selectableText={selectableMessage} copyText={copyText} isStructuredOnly={isStructuredOnly} hasUnsupportedContent={unsupportedContentMeta != null}
      canFork={props.canFork} forkCommon={props.forkCommon} isForkAllowed={props.isForkAllowed}
      settings={props.messageDisplayCommon} rollbackAction={props.rollbackAction}
      messagePins={props.messagePins} onToggleMessagePin={props.onToggleMessagePin}
      showActions={showMessageActions} showPinAction={showPinButton}
      timestampText={timestampText} timestampGlyph={timestampGlyph} invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
      onActionsFocus={handleActionsFocus} onActionsBlur={handleActionsBlur}
      onActionHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
      onActionHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
      hoverProps={hoverProps}
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
          {returnedAnswer ? (
          <ReturnedAnswerQuote message={props.message} answer={returnedAnswer} sessionId={props.sessionId} serverId={props.serverId}>
            {bubbleContent}
          </ReturnedAnswerQuote>
          ) : (
          <View style={styles.userMessageBubbleAligner}>
          {inlineComposition && (attachmentsMeta || sessionMediaMeta) ? (
            <View style={styles.userMessagePictures} testID={`transcript-message-pictures:${props.message.id}`}>{bubblePictures}</View>
          ) : null}
          <UserMessageBubble
            discarded={isDiscarded}
            attention={{ sessionAddress: transcriptSource.sessionId === props.sessionId ? normalizeSessionAddress(transcriptSource.serverId, props.sessionId) : null, routeMessageId: buildMessageRouteId(props.message), seq: resolveTranscriptMessageSeq(props.message), radius: TRANSCRIPT_MESSAGE_HIGHLIGHT_RADIUS }}
          >
            {bubbleContent}
          </UserMessageBubble>
          </View>
          )}
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
  const { isHovered: isMessageHovered, hoverProps } = useRowActionHoverHost();
  const [isCopyButtonHovered, setIsCopyButtonHovered] = React.useState(false);
  const [isActionRowFocused, setIsActionRowFocused] = React.useState(false);
  const handleActionsFocus = React.useCallback(() => setIsActionRowFocused(true), []);
  const handleActionsBlur = React.useCallback(() => setIsActionRowFocused(false), []);
  const isWeb = Platform.OS === 'web';
  const fallbackTextSelectable = shouldEnableFallbackTextNativeSelection(Platform.OS);
	  const transcriptSource = useSessionTranscriptSource();
  const sourceCanSendMessages = transcriptSource.useInteraction().canSendMessages;
  const { onJumpToAnchor: handleJumpToAnchor, onMarkdownLinkPress: handleMarkdownLinkPress, openPath: handleOpenAgentSessionMediaPath } = useTranscriptFileLinks({
    sessionId: props.sessionId, serverId: props.serverId, canOpenFiles: props.canOpenFiles,
    workspacePath: props.messageDisplayCommon.workspacePath,
    routeMessageId: buildMessageRouteId(props.message), seq: resolveTranscriptMessageSeq(props.message),
  });
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

  const structuredNode = React.useMemo(() => renderStructuredMessage({
	    message: props.message,
	    sessionId: props.sessionId,
        serverId: props.serverId,
        interaction: props.interaction,
	    onJumpToAnchor: handleJumpToAnchor,
	    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
	  }), [props.message, props.sessionId, props.serverId, props.interaction, handleJumpToAnchor,
    props.messageDisplayCommon.debugInformationEnabled]);
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
    pinActionEnabled: props.messageDisplayCommon.transcriptMessagePinActionEnabled,
  }), [props.message, props.messagePins, props.sessionId, props.messageDisplayCommon.transcriptMessagePinActionEnabled]);
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
  const timestampGlyph = messageDisplay.isVoiceAgentTurn ? 'planet' as const : undefined;
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
      props.message.peer === undefined &&
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
  const structuredReferenceProjectionDeferred = useMessageStructuredReferences({
    meta: props.message.meta,
    text: markdown,
    enabled: messageDisplay.text !== null && !shouldRenderStreamingPlain,
  });
  const structuredReferencesDeferred = structuredReferenceProjectionDeferred.row;
  const agentSessionMediaMeta = React.useMemo(() => {
    const primaryEnvelope = parseHappierMetaEnvelope(props.message.meta);
    const envelope = primaryEnvelope?.kind === 'session_media.v1'
      ? primaryEnvelope
      : parseHappierMetaEnvelope(props.message.meta, 'happierMedia');
    return parseSessionMediaMessageMeta(envelope);
  }, [props.message.meta]);

  // L7: an interactive transcript (one that can navigate) offers Second opinion and Discuss… on a committed answer.
  const navigateFromTranscript = transcriptSource.navigate;
  const answerText = selectableMessage?.text ?? null;
  const openDiscussionSource = React.useCallback((source: DiscussionSecondOpinionSourceV1, intent: 'second_opinion' | 'discuss') => {
    if (source.kind !== 'session' || answerText === null || !navigateFromTranscript) return;
    presentDiscussionSecondOpinion({ source, intent, sourceText: answerText, onNavigate: navigateFromTranscript });
  }, [answerText, navigateFromTranscript]);

  // Hidden thinking and filtered text keep the mounted row's hook order stable.
  if (messageDisplay.text === null) return null;

  return (
    <CommittedMessageActions
      message={props.message} sessionId={props.sessionId} serverId={props.serverId}
      selectableText={selectableMessage} copyText={copyText} isStructuredOnly={isStructuredOnly}
      openDiscussionSource={navigateFromTranscript ? openDiscussionSource : undefined}
      canFork={props.canFork} forkCommon={props.forkCommon} isForkAllowed={props.isForkAllowed}
      settings={props.messageDisplayCommon} rollbackAction={props.rollbackAction}
      messagePins={props.messagePins} onToggleMessagePin={props.onToggleMessagePin}
      showActions={showMessageActions} showPinAction={showPinButton}
      timestampText={timestampText} timestampGlyph={timestampGlyph} invertTimestampAndActions={timestampPresentation.invertTimestampAndActions}
      onActionsFocus={handleActionsFocus} onActionsBlur={handleActionsBlur}
      onActionHoverIn={isWeb ? () => setIsCopyButtonHovered(true) : undefined}
      onActionHoverOut={isWeb ? () => setIsCopyButtonHovered(false) : undefined}
      hoverProps={hoverProps}
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
              props.message.peer ? (
                <PeerMessageRow
                  id={props.message.id}
                  createdAt={props.message.createdAt}
                  peer={props.message.peer}
                  summary={deriveThinkingSummary(markdown)}
                  revealRequestId={findRevealId}
                >
                  <MarkdownView
                    markdown={markdown}
                    codeBlockStateKey={JSON.stringify([props.sessionId, props.message.id])}
                    findActive={findActive} findSourceRanges={findSourceRanges}
                    agentTexMath
                    renderCacheKey={buildMessageMarkdownRenderCacheKey(props.message.id, props.messageRevision)}
                    onOptionPress={handleOptionPress}
                    onOptionLongPress={handleOptionLongPress}
                    onLinkPress={handleMarkdownLinkPress}
                    selectable={true}
                    profile="transcript"
                    textStyle={styles.transcriptMarkdownText}
                  />
                </PeerMessageRow>
              ) : shouldRenderStreamingMarkdown ? (
                  <MarkdownView
                      markdown={streamingMarkdownText}
                      codeBlockStateKey={JSON.stringify([props.sessionId, props.message.id])}
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
                      codeBlockStateKey={JSON.stringify([props.sessionId, props.message.id])}
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
            routeMessageId={buildMessageRouteId(props.message)}
            seq={resolveTranscriptMessageSeq(props.message)}
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
  toolRouteCommon: TranscriptMessageRouteCommon;
}) {
  const message = React.useMemo(() => projectReviewToolMessage(props.message), [props.message]);
	  const transcriptSource = useSessionTranscriptSource();
  const contentDemand = useTranscriptRowContentDemand();
  const reviewSidechainIds = React.useMemo(() => readReviewToolRunId(props.message) !== null
    && message.tool.state === 'running'
    ? [resolveToolTranscriptSidechainId({ tool: props.message.tool, normalizedToolName: props.message.tool.name })] : [],
  [message.tool.state, props.message]);
  useEnsureSidechainsLoaded({
    enabled: contentDemand && reviewSidechainIds.length > 0 && transcriptSource.loadSidechain !== null,
    sessionId: props.sessionId,
    loadSidechain: transcriptSource.loadSidechain,
    sidechainIds: reviewSidechainIds,
  });
  const structuredPinHost = useRowActionHoverHost();
  const toolRouteMessageId = 'messageRouteId' in props.toolRouteCommon
    ? props.toolRouteCommon.messageRouteId
    : resolveMessageRouteIdForDisplay({ message: props.message, ...props.toolRouteCommon });
  // Narrow after the live message and its displayed route are known. Doing this at the list
  // renderer would miss streaming inputs and repeat the route owner's reverse-index lookup.
  const approvalRequests = selectToolApprovalRequestsForMessages({ requests: props.approvalRequests,
    sessionId: props.sessionId, rowId: props.message.id, messages: [message], messageId: toolRouteMessageId });
  const toolSeq = resolveTranscriptMessageSeq(props.message);
  const { onJumpToAnchor: handleJumpToAnchor, openPath: handleOpenToolSessionMediaPath } = useTranscriptFileLinks({
    sessionId: props.sessionId, serverId: props.toolChromeCommon.serverId,
    canOpenFiles: props.interaction.canOpenFiles === true,
    workspacePath: props.messageDisplayCommon.workspacePath,
    routeMessageId: toolRouteMessageId, seq: toolSeq,
  });
	  const toolViewTimelineChromeMode = props.toolChromeCommon.toolViewTimelineChromeMode;
  if (!message.tool) {
    return null;
  }
  const structuredNode = React.useMemo(() => renderStructuredMessage({
	    message,
	    sessionId: props.sessionId,
        serverId: props.toolChromeCommon.serverId,
        interaction: props.interaction,
	    onJumpToAnchor: handleJumpToAnchor,
	    debugInformationEnabled: props.messageDisplayCommon.debugInformationEnabled,
	  }), [message, props.sessionId, props.toolChromeCommon.serverId, props.interaction, handleJumpToAnchor,
    props.messageDisplayCommon.debugInformationEnabled]);
  const hasStructuredNode = structuredNode != null;
  const { turnChanges, shouldRenderToolChrome } = React.useMemo(() => deriveToolMessageDisplay({
    tool: message.tool,
    hasStructuredNode,
    toolViewTimelineChromeMode,
    permissionDisabledReason: props.interaction.permissionDisabledReason,
  }), [message.tool, hasStructuredNode, toolViewTimelineChromeMode, props.interaction.permissionDisabledReason]);
  const toolPinAction = resolveToolRowPinAction({
    sessionId: props.sessionId,
    seq: toolSeq,
    transcriptBlockIndex: resolveTranscriptMessageBlockIndex(props.message),
    routeMessageId: toolRouteMessageId ?? null,
    pins: props.messagePins,
    pinActionEnabled: props.messageDisplayCommon.transcriptMessagePinActionEnabled,
    readOnlyContext: props.interaction.permissionDisabledReason === 'readOnly',
    onTogglePin: props.onToggleToolPin,
    testID: `transcript-tool-call-pin:${props.message.id}`,
  });
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
    <TranscriptFindMessageProvider messageId={props.message.id} routeMessageId={toolRouteMessageId}>
      {structuredNode}
      {turnChanges ? (
        <TranscriptTurnChangesCard
          sessionId={props.sessionId}
          serverId={props.toolChromeCommon.serverId ?? null}
          turnId={turnChanges.turnId}
          files={turnChanges.files}
          firstHunkAnchors={turnChanges.firstHunkAnchors}
          messageId={toolRouteMessageId}
          fileOpenEnabled={props.interaction.canOpenFiles === true}
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
          tool={message.tool}
          metadata={props.metadata}
          messages={props.message.children}
          sessionId={props.sessionId}
          serverId={props.toolChromeCommon.serverId ?? undefined}
          messageId={toolRouteMessageId}
          jumpHighlightSeq={toolSeq}
          headerAction={toolPinAction}
          approvalRequests={approvalRequests}
          forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
          interaction={props.interaction}
          displaySettings={props.toolChromeCommon.toolDisplaySettings}
        />
      ) : (
        <ToolView
          tool={message.tool}
          metadata={props.metadata}
          messages={props.message.children}
          sessionId={props.sessionId}
          serverId={props.toolChromeCommon.serverId ?? undefined}
          messageId={toolRouteMessageId}
          jumpHighlightSeq={toolSeq}
          headerAction={toolPinAction}
          approvalRequests={approvalRequests}
          forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
          interaction={props.interaction}
          displaySettings={props.toolChromeCommon.toolDisplaySettings}
        />
      )) : null}
      {isSessionMessageInvocationAnchor(props.message) ? (
        <SessionAskRecord message={props.message} sessionId={props.sessionId} serverId={props.toolChromeCommon.serverId ?? null} embedded />
      ) : null}
      {toolSessionMediaMeta ? (
        <SessionMediaInlineImages
          sessionId={props.sessionId}
          media={toolSessionMediaMeta.inlineMedia}
          onOpenPath={handleOpenToolSessionMediaPath}
          fileOpenEnabled={props.interaction.canOpenFiles === true}
          mediaPreviewEnabled={props.interaction.canPreviewMedia === true}
        />
      ) : null}
    </TranscriptFindMessageProvider>
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
    marginHorizontal: theme.space.s16,
    marginBottom: theme.space.s6,
    fontSize: 12,
    color: theme.colors.message.event.foreground,
  },
    messageProvenanceAttribution: {
    ...Typography.variant('meta'),
    alignSelf: 'stretch',
    marginHorizontal: theme.space.s16,
    // The tag belongs to the bubble under it: the gap above (clear of the previous turn's meta row) is
    // wider than the one between tag and bubble.
    marginTop: theme.space.s12,
    marginBottom: theme.space.s4,
    color: theme.colors.text.secondary,
    textAlign: 'right',
  },
  workflowProvenanceRow: {
    alignSelf: 'stretch',
    alignItems: 'flex-end',
    paddingHorizontal: theme.space.s16,
    marginTop: theme.space.s12,
    marginBottom: theme.space.s4,
  },
  workflowProvenanceInline: {
    minWidth: 0,
    flexShrink: 1,
  },
  workflowProvenanceText: {
    ...Typography.variant('meta'),
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.space.s16,
  },
  structuredUserMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignSelf: 'stretch',
    paddingHorizontal: theme.space.s16,
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
    userMessagePictures: {
      // D5 / lab T1: numbered pictures sit above the bubble, right-aligned with it.
      alignSelf: 'flex-end',
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginBottom: theme.space.s6,
    },
    // Hug + right-align the bubble within the full-width wrapper, capped to the shared prompt
    // silhouette (queued prompts use the same aligner, so the crossover keeps its width).
    userMessageBubbleAligner: userMessageBubbleAlignerStyle,
  userStructuredMessageWrapper: {
    maxWidth: '100%',
  },
  historicalMessageContainer: {
    opacity: 0.55,
  },
  discardedCommittedMessageLabel: {
    marginTop: theme.space.s6,
    fontSize: 12,
    color: theme.colors.message.event.foreground,
  },
  agentMessageContainer: {
    marginHorizontal: theme.space.s16,
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
    marginHorizontal: theme.space.s16,
  },
  toolContainerEmbedded: {
    marginHorizontal: 0,
  },
  structuredToolPinAction: {
    alignSelf: 'flex-end',
    marginTop: theme.space.s4,
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
      marginBottom: theme.space.s6,
      marginLeft: theme.space.s2,
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
