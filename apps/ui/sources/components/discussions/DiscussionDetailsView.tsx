import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { DiscussionPhonePageStrip } from '@/components/navigation/mobile/chrome/bars/DiscussionCockpitTabBar';
import * as React from 'react';
import { resolveActionExecutionErrorMessage, resolveActionExecutionFailureTitle } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { projectDiscussionMessageReferences } from './discussionTimelineProjection';
import { projectDiscussionMessageLabels, EMPTY_DISCUSSION_MESSAGE_LABELS, type DiscussionMessageLabelProjection } from './discussionTimelineProjection';
import { prepareDiscussionContentForPassage, readDiscussionContentPassage } from './discussionComposerDocument';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { Platform, View, type ViewToken } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierThreadMessage } from '@happier-dev/plugin-ui/components';
import {
    type DiscussionMessageContentV1} from '@happier-dev/protocol/discussions/content';
import {
    type DiscussionOpenedMessageV1,
    type DiscussionOpenedSummaryV1,
    type DiscussionDetailsResultV1,
} from '@happier-dev/protocol/discussions/actions';
import { isDiscussionDocEditProposalContentV1, readDiscussionAttachmentPayloadsV1, readDiscussionMentionedParticipantIdsV1, type DiscussionMessagePartV1 } from '@happier-dev/protocol/discussions/content';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { DiscussionDetailsTarget, DiscussionHomeAddress } from './discussionDetailsTarget';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { requestRegisteredSessionComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { SessionDraftConflictResolution } from '@/components/sessions/drafts/SessionDraftConflictResolution';
import { useSessionAwareness } from '@/sync/domains/session/awareness/useSessionAwareness';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { isSessionWriteKnownDenied } from '@/utils/sessions/deriveTranscriptInteraction';
import { SelectMessageButton } from '@/components/sessions/transcript/messageSelection/SelectMessageButton';
import { useCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { shouldShowTranscriptRowActions } from '@/components/sessions/transcript/transcriptRowActionVisibility';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { TranscriptMessageSelectionBoundary } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { TranscriptSelectionToolbar, type TranscriptSelectionToolbarAction, type TranscriptSelectionToolbarMessage } from '@/components/sessions/transcript/messageSelection/TranscriptSelectionToolbar';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { PaneHeaderScrollScope } from '@/components/appShell/panes/paneHeaderScroll';
import { TranscriptListShell } from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import { resolveConversationTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import { Text, TextInput } from '@/components/ui/text/Text';
import { DiscussionMessageContent } from './DiscussionMessageContent';
import { ReplyQuote } from '@/components/ui/text/ReplyQuote';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import { ArtifactPassageQuote } from '@/components/artifacts/ArtifactPassageQuote';
import { useArtifactTitleProjections } from '@/components/artifacts/useArtifactTitleProjections';
import { ArtifactEditProposal, type AdmittedDocRead } from '@/components/artifacts/ArtifactEditProposal';
import { docProposalSelections } from '@/components/artifacts/docProposalSelection';
import { createArtifactActionsClient, type ArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import { buildDiscussionRouteHref } from './discussionRoutes';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { DiscussionSpeakerFace } from '@/components/discussions/DiscussionSpeakerFace';
import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { DetailsTabHeader, type DetailsTabHeaderMetaFact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { getStorage, selectSessionDisplayNameSource, useSessionDisplayNameProjections, useDiscussionRequesterApprovals, type SessionDisplayNameSource } from '@/sync/domains/state/storage';
import { ApprovalRequesterThreadCard } from '@/components/approvals/ApprovalRequesterThreadCard';
import { DiscussionWaitingApprovalCard } from './DiscussionWaitingApprovalCard';
import { DiscussionParticipantRequestLine } from '@/components/discussions/DiscussionParticipantRequestLine';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { useLentHeaderMenuRows } from '@/components/navigation/stackHeaderActions';
import { useDiscussionSettings } from './useDiscussionSettings';
import { buildDiscussionCheckInMenuAction } from './discussionCheckInMenu';
import { useDiscussionRecipientSelection } from './useDiscussionRecipientSelection';
import { DiscussionPatternCapturePanel, type DiscussionPatternCaptureMessage } from './DiscussionPatternCapturePanel';
import type { DiscussionParticipantRefV1 } from '@happier-dev/protocol/discussions/references';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SaveMemoryDecisionSheet, seedMemoryDecisionFromMessage } from '@/components/memory/SaveMemoryDecisionSheet';
import { DiscussionMessageMenu, type DiscussionMessageMenuItemId } from './DiscussionMessageMenu';
import { DiscussionCheckInBanner } from './DiscussionCheckInBanner';
import { DiscussionReplySendToSession } from './DiscussionReplySendToSession';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useSessionAgentActivityRoster } from '@/hooks/session/useSessionAgentActivity';
import { useSessionCollaborationAvailabilityState } from '@/hooks/session/useSessionCollaborationAvailability';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { randomUUID } from '@/platform/randomUUID';
import { createDiscussionClient, type DiscussionClientOutcome, type DiscussionExecutableParticipantInviteOutcome } from '@/sync/api/discussions/discussionActions';
import { prepareDiscussionParticipantMentions } from './prepareDiscussionParticipantMentions';
import type { DiscussionComposerValue } from './DiscussionComposer';
import {
    useServerCredentialAccountScopeBindings,
    type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { isSessionSurfaceVisible, useSessionSurfaceVisibilitySnapshot } from '@/sync/domains/session/sessionSurfaceVisibility';
import { createDiscussionVisibleReadController } from '@/sync/domains/discussions/discussionVisibleReadController';
import { useDiscussionHumanPresence } from '@/sync/domains/session/humanPresence/useSessionHumanPresence';
import { registerDiscussionHumanPresence } from '@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime';
import { useSetting } from '@/sync/domains/state/storage';
import { appendSessionDraftText } from '@/components/sessions/composer/sessionDraftAppendAction';
import type { DiscussionRepository, DiscussionRepositoryMutation } from '@/sync/ops/discussions/discussionRepository';
import { useDiscussionPost } from './useDiscussionPost';
import { selectDiscussionThreadAccessState } from '@/sync/ops/discussions/discussionRepository';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { formatSessionPresenceViewerNames } from '@/components/sessions/collaboration/sessionPresenceNames';
import { STALE_PRESENCE_OPACITY } from '@/components/sessions/collaboration/SessionViewerFacepile';
import { useOptionalTranscriptSelectionRow } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { pageTitleTypography } from '@/components/ui/layout/pageTitleTypography';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Typography } from '@/constants/Typography';
import type { SessionHumanPresenceViewer } from '@/sync/domains/session/humanPresence/sessionHumanPresenceStore';
import { useDeviceType } from '@/utils/platform/responsive';
import { readableSessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { useDiscussionSessionLabelProjection, useDiscussionSessionAgentIdProjection } from './discussionSessionLabel';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { formatShortRelativeTimeAt, readShortRelativeTimeRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { DiscussionAgentActivityReference } from '@/components/discussions/DiscussionAgentActivityReference';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { useOpenSessionAgentConversation } from '@/components/sessions/conversations/useOpenSessionAgentConversation';
import { DiscussionWorkflowRoundRow, DiscussionWorkflowRunEndRow, DiscussionWorkflowRunRow } from '@/components/discussions/DiscussionWorkflowRunRow';
import { useWorkflowInlineRunInvocations } from '@/components/workflows/run/useWorkflowInlineRunControls';
import { useDiscussionManagedWorkflowRuns } from '@/components/discussions/useDiscussionManagedWorkflowRuns';
import { useDiscussionRunChips } from '@/components/discussions/useDiscussionRunChips';
import { buildDiscussionContent } from '@/components/discussions/discussionComposerDocument';
import { buildDiscussionTimelineItems, projectDiscussionWorkflowRounds, resolveReadableVisibleDiscussionSeqs, resolveDiscussionMessageAuthorLabel, resolveDiscussionMessageSpeakerLabel, readDiscussionExternalSource, resolveDiscussionOutwardReply, resolveDiscussionReplyAttributionLine, resolveDiscussionReplyOutcome, resolveDiscussionReplyPresentation, resolveDiscussionWorkflowAttribution, readDiscussionWorkflowResultDetail, startsDiscussionMessageGroup, type DiscussionTimelineItem, placeDiscussionRequesterApprovals } from '@/components/discussions/discussionTimelineProjection';
import { DiscussionWorkflowInvocationRetry, DiscussionWorkflowResult } from '@/components/discussions/DiscussionWorkflowResult';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import { useDiscussionParticipantProfiles } from './useDiscussionParticipantProfiles';
import { joinList } from '@/utils/text/joinList';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { useDiscussionParticipantManagement } from './useDiscussionParticipantManagement';
import { isSelectableDiscussionMessage, prepareDiscussionSelectionHandoff, projectWorkflowRunPublishedAnswerIds } from '@/components/discussions/prepareDiscussionSelectionHandoff';
import { sendDiscussionSelectionToSession } from '@/components/discussions/sendDiscussionSelectionToSession';
import { DiscussionComposer } from '@/components/discussions/DiscussionComposer';
import { DiscussionProposalDocRead, LOADING_PROPOSAL_DOC, type ReportProposalDocRead } from '@/components/discussions/DiscussionProposalDocRead';
import { discussionFailureLabel } from '@/components/discussions/discussionFailureLabel';
import { DiscussionMessageAttachments, type DiscussionAttachmentReader } from '@/components/discussions/DiscussionMessageAttachments';
import { DiscussionDeliveryNotice } from './DiscussionDeliveryNotice';
import { AgentContentView } from '@/components/sessions/transcript/AgentContentView';
import { ComposerKeyboardScrollInset } from '@/components/sessions/keyboardAvoidance';
import { useDiscussionRightSidebarHosted, usePublishDiscussionRightSidebarPanels } from './discussionRightSidebarPanels';
import { DiscussionDetailsPanel } from './DiscussionDetailsPanel';
import { createDiscussionPassageBadge, createDiscussionReplyBadge } from './discussionComposerContextItems';
import { useDiscussionDraft } from './useDiscussionDraft';
import { useDiscussionRepository as useRepository, useNewDiscussionCreate } from './useNewDiscussionCreate';
import { formatDiscussionPresenceLine } from '@/components/discussions/discussionPresenceLine';
import { DiscussionAgentsPanel, DiscussionParticipantsPanel, DiscussionParticipantsPopover, DiscussionRosterFaces, formatDiscussionRosterLine, summarizeDiscussionRoster } from '@/components/discussions/DiscussionParticipantsPopover';
import { DiscussionInviteButton } from '@/components/discussions/DiscussionInviteSheet';
import { useDiscussionListRows } from '@/sync/ops/discussions/useDiscussionListRows';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';


/** The thread's face column (the shared thread message's 28-point face slot). */
const SPEAKER_FACE_PX = 28;
/** `HappierThreadMessage`'s selection edge (its left border), which offsets the face column. */
const THREAD_ROW_SELECTION_EDGE_PX = 2;
const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0, minWidth: 0 },
    input: { minHeight: 46, borderWidth: 1, borderColor: theme.colors.border.default, borderRadius: 14, paddingHorizontal: 14, paddingVertical: theme.space.s10, backgroundColor: theme.colors.surface.inset, color: theme.colors.text.primary, fontSize: 16, fontWeight: '600' },
    presenceRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: theme.space.s8, minWidth: 0 },
    loadingRows: { width: '100%', alignSelf: 'center', paddingHorizontal: theme.space.s16 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
    headerMeta: {  flexShrink: 1, color: theme.colors.text.secondary, ...Typography.variant('body') },
    messages: { flex: 1, minHeight: 0 },
    // A thread that could not be read has no list to host its state: it sits in the middle of the column, header and composer kept.
    readFailure: { flex: 1, justifyContent: 'center' },
    // A speaker mark stands on its own in the avatar's square (identity marks take no tile).
    messageAuthor: {  color: theme.colors.text.primary, ...Typography.variant('label', 'semiBold') },
    // A body reads at the Session transcript's step (one reading size across conversations).
    messageText: { ...Typography.default(), color: theme.colors.text.primary, ...transcriptMarkdownTextStyle },
    reference: { marginLeft: 46, marginRight: theme.space.s16, marginTop: theme.space.s6 },
    selectionToolbar: { position: 'absolute', left: 12, right: 12, bottom: 12 },
    meta: {  color: theme.colors.text.secondary, ...Typography.variant('meta') },
    timestamp: {  color: theme.colors.text.tertiary, ...Typography.variant('meta'), fontVariant: ['tabular-nums'] },
    selectAffordance: { alignSelf: 'center' },
    rowActions: { flexDirection: 'row', alignItems: 'center' },
    savedDecision: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    stateLine: { width: '100%', alignSelf: 'center', paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 },
    // A line about the conversation (needs your approval, a participant's request, who left) starts at the
    // messages' text, past the face column and the row's selection edge, as the lab's request card does (T2-A).
    threadTextLine: { paddingLeft: theme.space.s16 + THREAD_ROW_SELECTION_EDGE_PX + SPEAKER_FACE_PX + theme.space.s10 },
    deliveryStatus: { color: theme.colors.text.secondary, fontSize: 12 },
    error: { color: theme.colors.text.destructive, textAlign: 'center' },
    retry: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
    retryText: { color: theme.colors.accent.blue, fontWeight: '600' },
    fieldHint: { color: theme.colors.text.destructive },
    outcomeFailed: { color: theme.colors.text.destructive },
    outcomeLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: theme.space.s8 },
    outcomeText: { flexShrink: 1 },
    // The new page's name field is the header's title, at the title's own step, with no field chrome.
    titleInput: { flex: 1, minWidth: 0, padding: 0, color: theme.colors.text.primary, ...Typography.variant('heading', 'semiBold') },
    // A phone header takes the large title step; the name field follows it.
    titleInputLarge: { ...pageTitleTypography() },
    newNotice: { paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s8, ...Typography.variant('meta') },
    newBody: { flex: 1, minHeight: 0, justifyContent: 'center' },
    // The first message sits where the thread will show it: at the foot, above the composer.
    newBodySent: { justifyContent: 'flex-end' },
}));
const VIEWABILITY = Object.freeze({ itemVisiblePercentThreshold: 1 });
const NO_MESSAGE_IDS: readonly string[] = Object.freeze([]);
const NO_CONTEXT_ITEMS: readonly ReturnType<typeof createDiscussionPassageBadge>[] = Object.freeze([]);
const NO_VIEWERS: readonly SessionHumanPresenceViewer[] = Object.freeze([]);
const PRESENCE_FACE_LIMIT = 3;
/** Retained last-known presence is quieter than live presence (the facepile's own de-emphasis). */
const STALE_PRESENCE_FACE_OPACITY = STALE_PRESENCE_OPACITY;
/** Pending rows render locally but have no committed message reference or selection authority. */
type DiscussionDisplayMessage = Omit<DiscussionOpenedMessageV1, 'messageRef'> & Readonly<{ messageRef?: DiscussionOpenedMessageV1['messageRef'] }>;

function isSameDocPassage(left: DocPassageRefV1, right: DocPassageRefV1): boolean {
    return left.ref.artifactId === right.ref.artifactId
        && left.revision.headerVersion === right.revision.headerVersion
        && left.revision.bodyVersion === right.revision.bodyVersion
        && left.range.start === right.range.start && left.range.end === right.range.end;
}

function isCommittedDisplayMessage(message: DiscussionDisplayMessage): message is DiscussionOpenedMessageV1 {
    return message.messageRef !== undefined;
}

function discussionLifecycleFailureLabel(
    outcome: Exclude<DiscussionClientOutcome<DiscussionDetailsResultV1> | DiscussionExecutableParticipantInviteOutcome, { kind: 'succeeded' }>,
    operation: 'rename' | 'archive' | 'restore' | 'invite',
): string {
    if (outcome.kind === 'approval_request_created') return t('approvals.status.open');
    if (outcome.kind === 'checking') return t(operation === 'invite'
        ? 'session.collaboration.discussion.manage.checking' : 'session.collaboration.discussion.deliveryUnknown');
    return resolveActionExecutionErrorMessage(outcome, discussionFailureLabel(outcome.errorCode), { safeToRetry: true });
}

function mutationStatusLabel(mutation: Pick<DiscussionRepositoryMutation, 'status' | 'errorCode' | 'failureCause'>): string | null {
    if (mutation.status === 'observed_success') return null;
    if (mutation.status === 'outcome_unknown' || mutation.status === 'failed')
        return resolveActionExecutionErrorMessage(mutation, discussionFailureLabel(mutation.errorCode), { safeToRetry: true });
    if (mutation.status === 'approval_pending') return t('approvals.status.open');
    if (mutation.status === 'sending') return t('session.planOutput.sending');
    return t('session.collaboration.discussion.checking');
}

/**
 * Sending and checking are on their way, not outcomes: they take the time's place beside the name, so the
 * message already stands in its final form and nothing moves when it is confirmed. Outcomes that need the
 * person (refused, unknown, waiting for approval) keep their own line with its recovery.
 */
function isTransientMutationStatus(mutation: Pick<DiscussionRepositoryMutation, 'status'>): boolean {
    return mutation.status !== 'observed_success' && mutation.status !== 'outcome_unknown'
        && mutation.status !== 'failed' && mutation.status !== 'approval_pending';
}

/**
 * A message the person just sent rises into its place once; reduced motion shows it at once. A style
 * animation, not a layout one: the thread's virtualized list measures the row at its real size from the start.
 */
function SentMessageRise(props: Readonly<{ rises: boolean; children: React.ReactNode }>) {
    const reducedMotion = useReducedMotionPreference();
    // Decided at mount: a confirmed row keeps its mount (same key), so it never rises twice.
    const [rises] = React.useState(() => props.rises && !reducedMotion);
    const progress = useSharedValue(rises ? 0 : 1);
    React.useEffect(() => {
        if (!rises) return;
        progress.value = withTiming(1, { duration: motionTokens.sentMessage.riseMs, easing: reanimatedMotionTokens.easing.standard });
    }, [progress, rises]);
    const risePx = motionTokens.sentMessage.risePx;
    const style = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: (1 - progress.value) * risePx }],
    }));
    return rises ? <Animated.View style={style}>{props.children}</Animated.View> : <>{props.children}</>;
}

function textOf(
    content: DiscussionMessageContentV1 | null,
    resolveAccountLabel: (accountId: string) => string | null = () => null,
    resolveSessionLabel: (sessionId: string) => string | null = () => null,
): string {
    if (!content) return t('session.collaboration.discussion.contentUnavailable');
    return projectDiscussionMessageReferences(content, { account: resolveAccountLabel, session: resolveSessionLabel }).readableText;
}


export function DiscussionDetailsView(props: Readonly<{
    target: DiscussionDetailsTarget;
    /** True only while this Details surface is the one actually on screen (active tab, focused route). */
    active: boolean;
    /**
     * The host is itself the visible surface (the standalone mobile Discussion route),
     * so `active` alone states visibility. A Session-hosted Details pane leaves this
     * unset: it is visible only while its Session surface is.
     */
    standaloneSurface?: boolean;
    /** Visibility belongs to the actual hosting Session pane, never the optional anchor. */
    hostSessionAddress?: SessionAddress;
    /** Leaves this conversation surface (the phone route goes back); Details closes its own tab. */
    onClose?: () => void;
    onCreated?: (discussion: DiscussionOpenedSummaryV1, passageRoot?: DiscussionMessageRefV1) => void;
    onOpened?: (discussion: DiscussionOpenedSummaryV1) => void;
}>): React.ReactElement {
    const requestedServerIds = React.useMemo(() => [props.target.address.serverId], [props.target.address.serverId]);
    const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    // The binding resolves local profile aliases to the authenticated Home. Pass that same
    // identity to every repository/navigation consumer; the repository stays exact-scope only.
    const target = React.useMemo(() => binding
        ? { ...props.target, address: { serverId: binding.scope.serverId } }
        : props.target, [binding?.scope.serverId, props.target]);
    const availability = useSessionCollaborationAvailabilityState(props.target.address.serverId);
    const enabled = useFeatureEnabled('sessions.conversations', { scopeKind: 'spawn', serverId: props.target.address.serverId });
    const phoneChrome = useDiscussionPhoneChrome(props.standaloneSurface === true && props.target.kind === 'discussion');
    if (availability === 'loading') {
        return <DiscussionPhoneChrome enabled={phoneChrome} onBack={props.onClose}><SurfaceStateCard
            testID="session-discussion-details-loading"
            kind="loading"
            title={t('common.loading')}
        /></DiscussionPhoneChrome>;
    }
    if (!enabled || availability !== 'available' || !binding) {
        return <DiscussionPhoneChrome enabled={phoneChrome} onBack={props.onClose}><SurfaceStateCard
            testID="session-discussion-details-empty-state"
            kind="unavailable"
            title={t('sessionConversation.discussion.unavailableTitle')}
            reason={t('session.collaboration.discussion.unavailable')}
        /></DiscussionPhoneChrome>;
    }
    return target.kind === 'new'
        ? <NewDiscussion key={JSON.stringify([binding.scope.serverId, binding.scope.accountId, target.draftId ?? null])}
            target={target} scope={binding.scope} accountLifetime={binding} onCreated={props.onCreated} />
        : <Discussion target={target} scope={binding.scope} accountLifetime={binding} active={props.active} standaloneSurface={props.standaloneSurface === true} hostSessionAddress={props.hostSessionAddress} onClose={props.onClose} onOpened={props.onOpened} />;
}

/**
 * The composer binds its own draft text, so a keystroke renders the composer and never the Discussion page
 * around it (the page reads the same draft with `composer: false`).
 */
function DiscussionDraftComposer(props: Omit<React.ComponentProps<typeof DiscussionComposer>, 'value' | 'onChange'>) {
    const { text, mentions, setComposer } = useDiscussionDraft({ scope: props.scope, address: props.draftAddress });
    const value = React.useMemo(() => ({ text, mentions }), [mentions, text]);
    return <DiscussionComposer {...props} value={value} onChange={setComposer} />;
}

function NewDiscussion(props: Readonly<{ target: Extract<DiscussionDetailsTarget, { kind: 'new' }>; scope: ServerAccountScope; accountLifetime: ServerCredentialAccountScopeBinding; onCreated?: (discussion: DiscussionOpenedSummaryV1, passageRoot?: DiscussionMessageRefV1) => void }>) {
    const { theme } = useUnistyles();
    const contentWidth = useLayoutMaxWidthStyle();
    // The first message is the viewer's own: the same byline owner the thread uses once it is confirmed.
    const viewerProfile = useShareViewerProfile(props.scope);
    const viewerByline = resolveAccountActorPresentation({ v: 1, serverId: props.scope.serverId, accountId: props.scope.accountId, profile: viewerProfile }, props.scope);
    // The one create path for a new Discussion, shared with a Doc's inline comment.
    const { draftAddress, draft, mutation, accessRevoked, sourceRefused, createDisabled, createUnavailableLabel,
        titleRequired, setTitleRequired, dismissRefusal, submit, retry } = useNewDiscussionCreate({
        scope: props.scope, address: props.target.address, accountLifetime: props.accountLifetime,
        draftId: props.target.draftId, anchor: props.target.anchor, onCreated: props.onCreated });
    const phone = useSurfaceStateSize() === 'phone';
    const invited = draft.participants;
    const invitedFaces = React.useMemo(() => ({
        accountIds: [props.scope.accountId, ...invited.flatMap((participant) => participant.kind === 'account' ? [participant.accountId] : [])],
        agents: invited.flatMap((participant) => participant.kind === 'session' ? ['session' as const] : []),
    }), [invited, props.scope.accountId]);
    const invitedSessionAddresses = React.useMemo(() => invited.flatMap((participant) => participant.kind === 'session'
        ? [{ serverId: props.scope.serverId, sessionId: participant.sessionId }] : []), [invited, props.scope.serverId]);
    const invitedSessionTitles = useSessionDisplayNameProjections(invitedSessionAddresses, useDiscussionSessionLabelProjection());
    const invitedProfiles = useDiscussionParticipantProfiles({ scope: props.scope, accountLifetime: props.accountLifetime,
        roster: null, accountIds: invitedFaces.accountIds, enabled: invited.length > 0 });
    // Names, not counts, say who the empty page is waiting for (lab T2-ST "Ana and Checkout UI retry states are invited").
    const invitedNames = [
        ...invitedFaces.accountIds.slice(1).map((accountId) => resolveAccountDisplayName({ profile: invitedProfiles.accounts.get(accountId)?.profile,
            accountId, viewerAccountId: props.scope.accountId }).name),
        ...invitedSessionTitles.map((title) => title ?? t('session.collaboration.discussion.participants.session')),
    ];
    const rosterLine = formatDiscussionRosterLine({ peopleCount: invitedFaces.accountIds.length, agentCount: invitedFaces.agents.length, inherited: false });
    const composerInvited = React.useMemo(() => ({ participants: invited, accounts: invitedProfiles.accounts }), [invited, invitedProfiles.accounts]);
    // The passage being commented on is the composer's context badge, as a Session's carried context is.
    const newRouter = useRouter();
    const { passage: draftPassage, setPassage: setDraftPassage } = draft;
    const contextItems = React.useMemo(() => draftPassage || sourceRefused ? [createDiscussionPassageBadge({
        passage: sourceRefused ? null : draftPassage,
        onOpen: draftPassage ? () => newRouter.push(artifactViewRoute(draftPassage.ref.artifactId) as Href) : undefined,
        onRemove: () => setDraftPassage(null),
    })] : NO_CONTEXT_ITEMS, [draftPassage, newRouter, setDraftPassage, sourceRefused]);
    if (accessRevoked) {
        return <SurfaceStateCard
            testID="session-discussion-details-empty-state"
            kind="denied"
            title={t('sessionConversation.discussion.revokedTitle')}
            reason={t('sessionConversation.discussion.revokedReason')}
        />;
    }
    // Lab T2-ST "New Discussion": the name is the header's own title, who is here and who reads it sit on its
    // line, the page says how addressing works, and the composer starts the conversation.
    return <View style={styles.root} testID="session-discussion-new-details">
        <DetailsTabHeader
            testID="session-discussion-new-header"
            title=""
            columnMaxWidthPx={contentWidth.maxWidth}
            titleControl={<TextInput testID="session-discussion-title" style={[styles.titleInput, phone ? styles.titleInputLarge : null]} value={draft.title} onChangeText={(title) => { draft.setTitle(title); if (title.trim()) setTitleRequired(false); }} placeholder={t('session.collaboration.discussion.newPage.namePlaceholder')} accessibilityLabel={t('session.collaboration.discussion.titlePlaceholder')} aria-invalid={titleRequired} autoFocus />}
            meta={[
                { key: 'people', text: rosterLine, testID: 'session-discussion-new-roster' },
                { key: 'audience', text: t('session.collaboration.discussion.participants.invitedOnly'), icon: 'lock' },
            ]}
            metaLeadingKind="mark"
            metaLeading={invited.length ? <DiscussionRosterFaces members={invitedFaces} accountActors={invitedProfiles.accounts}
                viewerAccountId={props.scope.accountId} accessibilityLabel={rosterLine} /> : null}
            actions={<View style={styles.headerActions}>
                <DiscussionInviteButton scope={props.scope} accountLifetime={props.accountLifetime}
                    draft={{ participants: invited, onChange: draft.setParticipants, accounts: invitedProfiles.accounts }} />
            </View>}
            notice={titleRequired ? <Text testID="session-discussion-title-required" accessibilityLiveRegion="polite" style={[styles.fieldHint, styles.newNotice]}>{t('session.collaboration.discussion.titleRequired')}</Text> : undefined}
        />
        {/* The Session keyboard scaffold, as on a running thread: the composer rises with a phone's keyboard. */}
        <AgentContentView
            content={<View style={[styles.newBody, mutation?.content ? styles.newBodySent : null]}>
            {mutation?.content ? <SentMessageRise rises><HappierThreadMessage startsGroup space={theme.space} selectionColors={theme.colors.state.active} style={contentWidth}
                face={<View testID={`session-discussion-message-face-person-${mutation.messageLocalId ?? mutation.localId}`}><Avatar id={viewerByline.avatar.id} imageUrl={viewerByline.avatar.imageUrl ?? null} size={SPEAKER_FACE_PX} /></View>}
                attribution={<>
                    <Text style={styles.messageAuthor}>{viewerByline.name}</Text>
                    {isTransientMutationStatus(mutation) ? <Text testID={`session-discussion-message-status-${mutation.messageLocalId}`} accessibilityLiveRegion="polite" style={styles.timestamp}>{mutationStatusLabel(mutation)}</Text> : null}
                </>}>
                <DiscussionMessageContent message={{ id: mutation.messageLocalId ?? mutation.localId, content: mutation.content }} serverId={props.scope.serverId} textStyle={styles.messageText} profile="transcript" />
                {!isTransientMutationStatus(mutation) && mutationStatusLabel(mutation) ? <Text testID={`session-discussion-message-status-${mutation.messageLocalId}`} accessibilityLiveRegion="polite" style={mutation.status === 'failed' ? styles.error : styles.deliveryStatus}>{mutationStatusLabel(mutation)}</Text> : null}
                <MutationRecovery mutation={mutation} onRetry={retry} onDismiss={dismissRefusal} />
            </HappierThreadMessage></SentMessageRise>
                : <EmptyState testID="session-discussion-new-empty" layout="centered" iconName="chats-circle"
                    title={invitedNames.length
                        ? t('session.collaboration.discussion.newPage.invitedTitle', { names: joinList(invitedNames), count: invitedNames.length })
                        : t('session.collaboration.discussion.newPage.emptyTitle')}
                    subtitle={t('session.collaboration.discussion.newPage.emptyBody')} />}
        </View>}
            input={<>
        {draft.conflict ? <SessionDraftConflictResolution scope={props.scope} address={draftAddress} conflict={draft.conflict} /> : null}
        {createUnavailableLabel ? <View style={styles.stateLine}><SurfaceStateCard size="line" kind="warning" title={createUnavailableLabel} /></View> : null}
        <DiscussionDraftComposer scope={props.scope} accountLifetime={props.accountLifetime} address={props.target.address} availability="available" disabled={createDisabled} onSend={(content, attachments) => void submit(content, attachments)} draftAddress={draftAddress} invited={composerInvited} contextItems={contextItems} />
            </>}
        />
    </View>;
}

type DiscussionProps = Readonly<{ target: Extract<DiscussionDetailsTarget, { kind: 'discussion' }>; scope: ServerAccountScope; accountLifetime: ServerAccountScopeLifetime; active: boolean; standaloneSurface: boolean; hostSessionAddress?: SessionAddress; onClose?: () => void; onOpened?: (discussion: DiscussionOpenedSummaryV1) => void }>;
type DiscussionSource = Readonly<{
    scope: ServerAccountScope;
    address: SessionAddress;
    contentPending: boolean;
    canLaunchExecutionRuns: boolean;
    canSendToSession: boolean;
    activity: Pick<ReturnType<typeof useSessionAgentActivityRoster>, 'subagents' | 'readExecutionRunEntry'>;
    agentConversation: ReturnType<typeof useOpenSessionAgentConversation>;
}>;
/** Source navigation has archive eligibility in addition to ordinary title readability. */
function readableDiscussionAnchorTitle(source: SessionDisplayNameSource | null): string | null {
    return source?.archivedAt == null ? readableSessionDisplayTitle(source) : null;
}
/**
 * A thread that could not be read says so in its own words (the same ones whether the page or only the messages are
 * missing), with the one way out: Try again. Revoked access has its own state, and Loading none.
 */
function threadReadFailureCard(
    thread: Readonly<{ status: string; errorCode: string | null }>,
    action: Readonly<{ label: string; onPress: () => void }>,
) {
    if (thread.status === 'offline') {
        return { kind: 'unavailable', title: t('sessionConversation.discussion.offlineTitle'),
            reason: t('sessionConversation.discussion.offlineReason'), action } as const;
    }
    if (thread.status === 'locked') {
        return { kind: 'error', title: t('sessionConversation.discussion.lockedTitle'),
            reason: t('sessionConversation.discussion.lockedReason'), action, diagnosticCode: thread.errorCode ?? 'locked' } as const;
    }
    const failure = { code: thread.errorCode };
    return { kind: 'error', title: resolveActionExecutionFailureTitle(failure, t('sessionConversation.discussion.errorTitle')),
        reason: resolveActionExecutionErrorMessage(failure, t('sessionConversation.discussion.errorReason'), { safeToRetry: true }), action, diagnosticCode: thread.errorCode ?? null } as const;
}
const NO_SOURCE_SUBAGENTS: ReturnType<typeof useSessionAgentActivityRoster>['subagents'] = Object.freeze([]);
const readNoSourceExecutionRunEntry: ReturnType<typeof useSessionAgentActivityRoster>['readExecutionRunEntry'] = () => null;
type ProposalDocObservation = Readonly<{ client: ArtifactActionsClient; read: AdmittedDocRead }>;

/**
 * Source-only subscriptions mount only when the resource actually has a Session anchor. A memoized leaf: it
 * renders for its own subscriptions, never because publishing its source re-rendered the parent (that loop
 * re-published a fresh source on every render of a Session-anchored Discussion).
 */
const DiscussionSourceObserver = React.memo(function DiscussionSourceObserver(props: Readonly<{ scope: ServerAccountScope; accountLifetime: ServerAccountScopeLifetime; address: SessionAddress; onChange: (source: DiscussionSource | null) => void }>) {
    // A cold anchor is not a denied source. The shared scoped owner acquires and retains
    // current metadata without reading messages or borrowing another Home/Account's Session.
    const shellSession = useSessionViewShellSession(props.address.sessionId, props.address.serverId);
    const { session, contentPending } = useSessionAwareness(props.address.sessionId, props.address.serverId, shellSession ?? undefined,
        { accountLifetime: props.accountLifetime });
    const { canLaunchExecutionRuns } = useSessionExecutionRunLaunchability(props.address.sessionId, session, props.address.serverId);
    const { subagents, readExecutionRunEntry } = useSessionAgentActivityRoster({ sessionId: props.address.sessionId, serverId: props.address.serverId });
    const activity = React.useMemo(() => ({ subagents, readExecutionRunEntry }), [readExecutionRunEntry, subagents]);
    const agentConversation = useOpenSessionAgentConversation({ address: props.address });
    const canSendToSession = session != null && !isSessionWriteKnownDenied(session);
    React.useEffect(() => {
        props.onChange({ scope: props.scope, address: props.address, contentPending, canLaunchExecutionRuns, canSendToSession, activity, agentConversation });
        return () => props.onChange(null);
    }, [activity, agentConversation, contentPending, canLaunchExecutionRuns, canSendToSession, props.address, props.onChange, props.scope]);
    return null;
});

function Discussion(props: Omit<DiscussionProps, 'accountLifetime'> & Readonly<{ accountLifetime: ServerCredentialAccountScopeBinding }>) {
    const [repository, snapshot, discussionClient] = useRepository(props.scope, props.target.address, props.accountLifetime, props.target.discussionId, props.active);
    return <DiscussionDetailsContentView {...props} repository={repository} snapshot={snapshot} discussionClient={discussionClient} />;
}

/** The admitted Discussion page shared by route hosts and local product previews. */
export function DiscussionDetailsContentView(props: DiscussionProps & Readonly<{
    repository: DiscussionRepository;
    snapshot: ReturnType<DiscussionRepository['getSnapshot']>;
    discussionClient: ReturnType<typeof createDiscussionClient>;
}>) {
    const { repository, snapshot, discussionClient } = props;
    const attachmentReader = React.useMemo<DiscussionAttachmentReader>(() => ({ repository, client: discussionClient,
        discussionId: props.target.discussionId }), [discussionClient, props.target.discussionId, repository]);
    const thread = snapshot.threads[props.target.discussionId];
    const anchor = thread?.status === 'revoked' ? null : thread?.summary?.anchor;
    const anchorSessionId = anchor?.kind === 'session' ? anchor.sessionId : null;
    const sourceAddress = React.useMemo(() => anchorSessionId
        ? { serverId: props.target.address.serverId, sessionId: anchorSessionId }
        : null, [anchorSessionId, props.target.address.serverId]);
    const [observedSource, setObservedSource] = React.useState<DiscussionSource | null>(null);
    const source = props.active && sourceAddress && observedSource?.scope.serverId === props.scope.serverId
        && observedSource.scope.accountId === props.scope.accountId && observedSource.address.serverId === sourceAddress.serverId
        && observedSource.address.sessionId === sourceAddress.sessionId ? observedSource : null;
    return <>
        {props.active && sourceAddress ? <DiscussionSourceObserver scope={props.scope} accountLifetime={props.accountLifetime} address={sourceAddress} onChange={setObservedSource} /> : null}
        <DiscussionContent {...props} repository={repository} snapshot={snapshot} source={source} attachmentReader={attachmentReader} />
    </>;
}

function DiscussionContent(props: DiscussionProps & Readonly<{
    repository: DiscussionRepository;
    snapshot: ReturnType<DiscussionRepository['getSnapshot']>;
    source: DiscussionSource | null;
    attachmentReader: DiscussionAttachmentReader;
}>) {
    const router = useRouter();
    const device = useDeviceType();
    const { theme } = useUnistyles();
    const { repository, snapshot, attachmentReader } = props;
    const thread = snapshot.threads[props.target.discussionId];
    const discussion = thread?.summary ?? null;
    const { accessRevoked, sourceRefused } = selectDiscussionThreadAccessState(snapshot, props.target.discussionId);
    const hostViewed = useHostActivelyViewed();
    const layoutPresented = useLayoutPresentationActive();
    const visibility = useSessionSurfaceVisibilitySnapshot();
    const surfaceVisible = React.useMemo(() => !props.hostSessionAddress || isSessionSurfaceVisible(props.hostSessionAddress.sessionId, props.hostSessionAddress.serverId), [props.hostSessionAddress, visibility]);
    const pane = useAppPaneScope(useDestinationPaneScopeId(props.hostSessionAddress
        ? createSessionPaneScopeId(props.hostSessionAddress.sessionId, props.hostSessionAddress.serverId)
        : 'discussion'));
    const presenceTarget = React.useMemo(() => ({ serverId: props.target.address.serverId, discussionId: props.target.discussionId }), [props.target.address.serverId, props.target.discussionId]);
    // Data stays active for a covering phone panel. Seen/presentation work also
    // requires the layout owner to say the retained thread is actually shown.
    const threadViewed = props.active && hostViewed && layoutPresented && (props.standaloneSurface || surfaceVisible);
    // The covering Participants panel still consumes live room presence; its
    // data demand is distinct from reading messages in the hidden thread.
    const presenceEligible = props.active && hostViewed && (props.standaloneSurface || surfaceVisible) && !accessRevoked;
    const presence = useDiscussionHumanPresence(presenceEligible ? presenceTarget : null, props.accountLifetime);
    React.useEffect(() => presenceEligible ? registerDiscussionHumanPresence(presenceTarget, props.accountLifetime) : undefined, [presenceEligible, presenceTarget, props.accountLifetime]);
    // The one presence-name owner, as in the facepile and Viewing now: a retained
    // last-known observation keeps its names, says so, and makes no typing claim.
    const presenceStale = presence.status === 'stale';
    const presentViewers = presence.viewers.length === 0 || (presence.status !== 'live' && !presenceStale)
        ? NO_VIEWERS
        : presence.viewers;
    const presenceLabel = React.useMemo(
        () => formatDiscussionPresenceLine(presentViewers, { stale: presenceStale }),
        [presenceStale, presentViewers],
    );
    const threadColumn = useLayoutMaxWidthStyle();
    const transcriptBulkCopyFormat = useSetting('transcriptBulkCopyFormat');
    const sendTemplate = useSetting('transcriptMessageSendToSessionTemplate');
    const draftAddress = React.useMemo(() => ({ kind: 'discussion' as const, discussionId: props.target.discussionId }), [props.target.discussionId]);
    const draft = useDiscussionDraft({ scope: props.scope, address: draftAddress, composer: false });
    // A discussion opened from a link, an Activity item or a mention carries no title yet, so
    // its Details tab shows the generic label. Report the opened summary through the same
    // channel creation uses; the tab owner replaces the tab under its existing key.
    const onOpenedRef = React.useRef(props.onOpened);
    onOpenedRef.current = props.onOpened;
    const openedTitle = discussion?.title ?? null;
    useDestinationPageTitle(props.standaloneSurface ? openedTitle : undefined);
    React.useEffect(() => {
        if (!discussion || !openedTitle) return;
        onOpenedRef.current?.(discussion);
        // The summary identity that matters here is the discussion and its current title.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [discussion?.id, openedTitle]);
    const messages = thread?.messages ?? [];
    const messageById = React.useMemo(() => new Map(messages.map(message => [message.id, message])), [messages]);
    const openQuotedMessage = React.useCallback((messageId: string) => {
        router.push(buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: props.target.address.serverId },
            discussionId: props.target.discussionId, messageId } }) as Href);
    }, [props.target.address.serverId, props.target.discussionId, router]);
    // A suggested edit is decided through the Doc Actions on this Discussion's own Home.
    const proposalClient = React.useMemo(() => createArtifactActionsClient(props.scope), [props.scope]);
    const participantManagement = useDiscussionParticipantManagement({ accountLifetime: props.accountLifetime,
        discussionId: props.target.discussionId, repository, summary: discussion,
        enabled: props.active && thread?.status !== 'revoked' });
    const refreshRoster = participantManagement.refresh;
    const participantProfiles = useDiscussionParticipantProfiles({ scope: props.scope, accountLifetime: props.accountLifetime,
        roster: participantManagement.roster,
        participantAccounts: discussion?.participantAccounts,
        enabled: props.active && thread?.status !== 'revoked' });
    // The viewer's own unacknowledged message is authored with their scoped profile, not "Collaborator".
    const viewerProfile = useShareViewerProfile(props.scope);
    const viewer = React.useMemo(() => ({ serverId: props.scope.serverId, accountId: props.scope.accountId, profile: viewerProfile }), [props.scope.accountId, props.scope.serverId, viewerProfile]);
    const historicalActorLabels = React.useMemo(() => new Map(messages.flatMap((message) => {
        const actor = message.accountActor;
        if (actor === null || actor.accountId !== message.authorAccountId) return [];
        return [[actor.accountId, resolveDiscussionMessageAuthorLabel(message, viewer)] as const];
    })), [messages, viewer]);
    const resolveAccountLabel = React.useCallback((accountId: string): string | null => {
        const actor = participantProfiles.accounts.get(accountId);
        // A current server's explicit relationship fact beats historical row snapshots.
        // A roster/profile without accessibility is not evidence that a Team-derived author left.
        if (actor?.accessibility !== undefined) return resolveAccountActorPresentation(actor, props.scope).name;
        const historicalLabel = historicalActorLabels.get(accountId);
        if (historicalLabel) return historicalLabel;
        return actor ? resolveAccountActorPresentation(actor, props.scope).name : null;
    }, [historicalActorLabels, participantProfiles.accounts, props.scope]);
    // Mentions and receiver holds identify Sessions, but grant no Session read
    // authority. Only this Home's accessible title projection supplies labels.
    const mentionedSessionAddresses = React.useMemo(() => [...new Set(messages.flatMap((message) => [
        ...(message.content ? readDiscussionMentionedParticipantIdsV1(message.content).mentionedSessionIds : []),
        ...(message.participantDeliveryV1?.map((delivery) => delivery.participantSessionId) ?? []),
        // Every Agent answer's byline names the Session that answered (a Bot asked by a person, a reviewer
        // a Workflow started, a suggested edit's author), through the same title projection.
        ...(message.producerV1?.kind === 'agent' ? [message.producerV1.sessionId] : []),
    ]))]
        .map((sessionId) => ({ serverId: props.scope.serverId, sessionId })), [messages, props.scope.serverId]);
    const mentionedSessionTitles = useSessionDisplayNameProjections(mentionedSessionAddresses, useDiscussionSessionLabelProjection());
    const isSessionVisible = useSessionRecordingVisibility();
    const readVisibleAgentId = useDiscussionSessionAgentIdProjection();
    const readVisibleAnchorTitle = React.useCallback((source: SessionDisplayNameSource | null) => source
        && isSessionVisible({ sessionId: source.id, serverId: source.serverId }) ? readableDiscussionAnchorTitle(source) : null, [isSessionVisible]);
    // An Agent answer wears its Agent's mark (lab T2-A), read from the same title projection.
    const mentionedSessionAgentIds = useSessionDisplayNameProjections(mentionedSessionAddresses, readVisibleAgentId);
    // The Session this Discussion hangs off, named in the header (lab T2-A anchor); only this Home's
    // accessible title projection names it, as for mentions.
    const anchorSessionId = discussion?.anchor?.kind === 'session' ? discussion.anchor.sessionId : null;
    const anchorAddresses = React.useMemo(() => anchorSessionId ? [{ serverId: props.scope.serverId, sessionId: anchorSessionId }] : [], [anchorSessionId, props.scope.serverId]);
    const anchorTitle = useSessionDisplayNameProjections(anchorAddresses, readVisibleAnchorTitle)[0] ?? null;
    const anchorPending = props.active && (!props.source || props.source.contentPending);
    const anchorDocId = discussion?.anchor?.kind === 'doc' ? discussion.anchor.doc.ref.artifactId : null;
    const anchorDocIds = React.useMemo(() => anchorDocId ? [anchorDocId] : [], [anchorDocId]);
    const anchorDocTitle = useArtifactTitleProjections(props.scope, anchorDocIds, props.active)[0] ?? null;
    // Retained source identity is not source readability. Tasks has not supplied the configured read/open
    // target for an identity-only anchor; never infer a connection or expose its raw id as a title.
    const anchorFact = React.useMemo<DetailsTabHeaderMetaFact | null>(() => {
        const anchor = discussion?.anchor;
        if (!anchor) return null;
        if (anchor.kind === 'session') {
            if (!anchorTitle) return { key: 'anchor', text: anchorPending ? t('common.loading') : t('session.collaboration.discussion.quote.unavailable'),
                icon: 'chats-circle', tone: 'muted', testID: 'session-discussion-anchor' };
            const href = buildScopedSessionRouteHref({ serverId: props.scope.serverId, sessionId: anchor.sessionId,
                ...(anchor.messageId ? { messageId: anchor.messageId } : {}) });
            return { key: 'anchor', text: anchorTitle, icon: 'chats-circle', testID: 'session-discussion-anchor',
                accessibilityLabel: t('session.collaboration.discussion.openAnchor', { name: anchorTitle }),
                onPress: () => {
                    if (!props.accountLifetime.isCurrent() || !readableDiscussionAnchorTitle(selectSessionDisplayNameSource(
                        getStorage().getState(), anchor.sessionId, props.scope.serverId))) return;
                    router.push(href as Href);
                } };
        }
        if (anchor.kind === 'doc') {
            const name = anchorDocTitle || t('artifacts.browser.kindOne.document');
            return { key: 'anchor', text: name, icon: 'file-text', testID: 'session-discussion-anchor',
                accessibilityLabel: t('session.collaboration.discussion.openAnchor', { name }),
                onPress: () => router.push(artifactViewRoute(anchor.doc.ref.artifactId) as Href) };
        }
        return { key: 'anchor', text: t('session.collaboration.discussion.quote.unavailable'), icon: 'check-square',
            tone: 'muted', testID: 'session-discussion-anchor' };
    }, [anchorDocTitle, anchorPending, anchorTitle, discussion?.anchor, props.accountLifetime, props.scope.serverId, router]);
    // A private draft or request waiting on this viewer (lab T2-ST "Drafts for approval"): the same Inbox
    // approval owner the column's Needs you reads. Reviewing it (Post or Decline) stays that owner's page.
    const attentionItems = React.useMemo(() => discussion ? [discussion] : [], [discussion]);
    const attention = useDiscussionListRows(props.scope, attentionItems)[0] ?? null;
    const waitingApprovalId = attention?.attentionReason === 'draft_waiting' || attention?.attentionReason === 'approval_pending'
        ? attention.approvalArtifactIds[0] ?? null : null;
    const reviewWaiting = React.useCallback(() => {
        if (!waitingApprovalId) return;
        router.push(buildApprovalHref(waitingApprovalId, props.scope.serverId,
            buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: props.target.address.serverId }, discussionId: props.target.discussionId } })) as Href);
    }, [props.scope.serverId, props.target.address.serverId, props.target.discussionId, router, waitingApprovalId]);
    const sessionLabels = React.useMemo(() => new Map(mentionedSessionAddresses.map((address, index) => [address.sessionId, mentionedSessionTitles[index] ?? null])), [mentionedSessionAddresses, mentionedSessionTitles]);
    const resolveSessionLabel = React.useCallback((sessionId: string) => sessionLabels.get(sessionId) ?? null, [sessionLabels]);
    const sessionAgentIds = React.useMemo(() => new Map(mentionedSessionAddresses.map((address, index) => [address.sessionId, mentionedSessionAgentIds[index] ?? null])), [mentionedSessionAddresses, mentionedSessionAgentIds]);
    const selectableMessages = React.useMemo<readonly TranscriptSelectionToolbarMessage[]>(() => messages
        .filter(isSelectableDiscussionMessage)
        .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
        .map((message) => ({ id: message.id, role: 'user' as const, text: textOf(message.content, resolveAccountLabel, resolveSessionLabel) })), [messages, resolveAccountLabel, resolveSessionLabel]);
    // Save as pattern chooses from the same committed messages, named as the thread names their speaker.
    const patternCaptureMessages = React.useMemo<readonly DiscussionPatternCaptureMessage[]>(() => messages
        .filter(isSelectableDiscussionMessage)
        .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
        .map((message) => {
            const author = resolveDiscussionMessageSpeakerLabel(message, {
                account: resolveAccountLabel,
                session: resolveSessionLabel,
                workflowRun: () => null,
            }, viewer);
            return { id: message.id, author,
                text: textOf(message.content, resolveAccountLabel, resolveSessionLabel) };
        }), [messages, resolveAccountLabel, resolveSessionLabel, viewer]);
    const patternCaptureAnchorRef = React.useRef<View>(null);
    // What each Workflow Run published here: its answers, as the thread's committed replies carrying its provenance.
    const publishedByRun = React.useMemo(() => projectWorkflowRunPublishedAnswerIds(messages), [messages]);
    const prepareSelection = React.useCallback((selected: ReadonlyArray<TranscriptSelectionToolbarMessage>) => prepareDiscussionSelectionHandoff({
        serverId: props.target.address.serverId,
        discussionId: props.target.discussionId,
        selectedMessageIds: selected.map((message) => message.id),
        messages,
        resolveAccountLabel,
        resolveSessionLabel,
        format: transcriptBulkCopyFormat,
        roleLabels: { user: t('session.collaboration.discussion.collaborator'), assistant: t('voiceActivity.format.assistant') },
        agentAttributionLabel: t('session.collaboration.discussion.viaAgent'),
    }), [messages, props.target.address.serverId, props.target.discussionId, resolveAccountLabel, resolveSessionLabel, transcriptBulkCopyFormat]);
    // P3 (CL-B): an agent's finished reply can go to the Session this Discussion hangs off, as information.
    // CL-B's row owns the send and its receipt; this page only says where and which reply.
    const replySendSessionId = discussion?.capabilities.sendToSession === true && props.source?.canSendToSession === true
        ? props.source.address.sessionId : null;
    const renderReplySend = React.useCallback((message: DiscussionDisplayMessage) => {
        if (!replySendSessionId || message.producerV1?.kind !== 'agent' || message.producerV1.sessionId === replySendSessionId) return null;
        return <DiscussionReplySendToSession scope={props.scope} sessionId={replySendSessionId} sessionName={anchorTitle}
            discussionId={props.target.discussionId} messageId={message.id}
            prepare={() => {
                const selected = selectableMessages.find((candidate) => candidate.id === message.id);
                return selected ? prepareSelection([selected]) : null;
            }} />;
    }, [anchorTitle, prepareSelection, props.scope, props.target.discussionId, replySendSessionId, selectableMessages]);
    const draftUnavailable = draft.status === 'offline' || draft.status === 'error' || draft.status === 'conflict';
    const threadUnavailable = thread?.status === 'offline' || thread?.status === 'locked' || thread?.status === 'error';
    const mutationsDisabled = draftUnavailable || threadUnavailable;
    React.useEffect(() => {
        if (sourceRefused) void draft.purgeSourcePresentation();
        else if (accessRevoked) void draft.purgePresentation();
    }, [accessRevoked, draft, sourceRefused]);
    const [rename, setRename] = React.useState<string | null>(null);
    const [lifecycleFailure, setLifecycleFailure] = React.useState<Readonly<{
        operation: 'rename' | 'archive' | 'restore' | 'invite';
        outcome: Exclude<DiscussionClientOutcome<DiscussionDetailsResultV1> | DiscussionExecutableParticipantInviteOutcome, { kind: 'succeeded' }>;
    }> | null>(null);
    const inviteExecutable = participantManagement.inviteExecutable;
    const prepareParticipantMentions = React.useCallback(async (document: DiscussionComposerValue, isCurrent: () => boolean) => {
        setLifecycleFailure(null);
        const result = await prepareDiscussionParticipantMentions({ document, discussionId: props.target.discussionId,
            repository, inviteExecutable, isCurrent: () => props.accountLifetime.isCurrent() && isCurrent() });
        if (result.kind === 'ready') return result.content;
        if (props.accountLifetime.isCurrent() && isCurrent()) setLifecycleFailure({ operation: 'invite', outcome: result.outcome });
        return null;
    }, [inviteExecutable, props.accountLifetime, props.target.discussionId, repository]);
    const roster = participantManagement.roster;
    // DISC-18: admit the persisted Send to defaults through the same roster used by the chip.
    const rosterSessionAddresses = React.useMemo(() => (roster?.participants ?? []).flatMap((row) => {
        const sessionId = row.participant.kind === 'session' ? row.participant.sessionId : 'sessionId' in row ? row.sessionId : null;
        return sessionId ? [{ serverId: props.scope.serverId, sessionId }] : [];
    }), [props.scope.serverId, roster?.participants]);
    const rosterSessionTitles = useSessionDisplayNameProjections(rosterSessionAddresses, useDiscussionSessionLabelProjection());
    const rosterSessionIds = React.useMemo(() => rosterSessionAddresses.map((address) => address.sessionId), [rosterSessionAddresses]);
    const recipientLabel = React.useCallback((participant: DiscussionParticipantRefV1): string => {
        if (participant.kind === 'session') {
            const index = rosterSessionAddresses.findIndex((address) => address.sessionId === participant.sessionId);
            return (index >= 0 ? rosterSessionTitles[index] : null) ?? resolveSessionLabel(participant.sessionId)
                ?? t('session.collaboration.discussion.participants.session');
        }
        const grant = roster?.grants.find((entry) => entry.principal.kind === 'account' && entry.principal.accountId === participant.accountId);
        return resolveAccountLabel(participant.accountId) ?? grant?.display.name ?? grant?.display.username ?? t('session.collaboration.unnamed');
    }, [resolveAccountLabel, resolveSessionLabel, roster?.grants, rosterSessionAddresses, rosterSessionTitles]);
    const recipientSelection = useDiscussionRecipientSelection({ draft, roster, label: recipientLabel });
    React.useEffect(() => {
        if (!props.active) return;
        if (props.target.messageId) void repository.openMessage({ kind: 'discussion', discussion: {
            serverId: props.target.address.serverId, discussionId: props.target.discussionId,
        }, messageId: props.target.messageId });
        else void repository.refreshDiscussion(props.target.discussionId);
    }, [props.active, props.target.address.serverId, props.target.discussionId, props.target.messageId, repository]);
    const threadRoot = draft.replyTarget?.kind === 'message' ? messageById.get(draft.replyTarget.messageId) : null;
    // Reply is a deliberate per-message choice held in the draft; a focused route only navigates.
    const { setReplyTarget, setRecipients } = draft;
    const replyToMessage = React.useCallback((messageId: string) => setReplyTarget({ kind: 'message', messageId }), [setReplyTarget]);
    const clearReplyTarget = React.useCallback(() => setReplyTarget(null), [setReplyTarget]);
    // The reply target and a re-attached Doc passage are the composer's context badges (as a Session's are):
    // each opens its source and can be removed. Committed messages keep their quotes.
    const { passage: draftPassage, setPassage: setDraftPassage } = draft;
    const postable = discussion?.archivedAt === null && discussion.capabilities.postMessages;
    const replyMessageId = draft.replyTarget?.kind === 'message' ? draft.replyTarget.messageId : null;
    // A reply under an inbound channel message is sent out to that conversation too; the composer says so first.
    const outwardReply = React.useMemo(() => resolveDiscussionOutwardReply(replyMessageId, messageById), [replyMessageId, messageById]);
    const contextItems = React.useMemo(() => {
        if (!postable) return NO_CONTEXT_ITEMS;
        const items: ReturnType<typeof createDiscussionPassageBadge>[] = [];
        if (replyMessageId) items.push(createDiscussionReplyBadge({
            authorLabel: threadRoot?.content ? resolveDiscussionMessageSpeakerLabel(threadRoot, {
                account: resolveAccountLabel,
                session: resolveSessionLabel,
                workflowRun: () => null,
            }, viewer) : null,
            text: threadRoot?.content ? textOf(threadRoot.content, resolveAccountLabel, resolveSessionLabel) : null,
            onOpen: threadRoot ? () => openQuotedMessage(threadRoot.id) : undefined,
            onRemove: clearReplyTarget,
        }));
        if (draftPassage) items.push(createDiscussionPassageBadge({
            passage: sourceRefused ? null : draftPassage,
            onOpen: () => router.push(artifactViewRoute(draftPassage.ref.artifactId) as Href),
            onRemove: () => setDraftPassage(null),
        }));
        return items;
    }, [clearReplyTarget, draftPassage, openQuotedMessage, postable, replyMessageId, resolveAccountLabel, resolveSessionLabel,
        router, setDraftPassage, sourceRefused, threadRoot, viewer]);
    const { mutation, composerBlocked, dismissRefusal, send } = useDiscussionPost({ scope: props.scope,
        discussionId: props.target.discussionId, repository, mutations: snapshot.mutations, messages, draft, draftAddress,
        canPost: discussion?.capabilities.postMessages === true, recipientSelection });
    const discussionAddress = React.useMemo(() => ({ serverId: props.target.address.serverId, discussionId: props.target.discussionId }), [props.target.address.serverId, props.target.discussionId]);
    const managedRuns = useDiscussionManagedWorkflowRuns({ discussion: discussionAddress, accountLifetime: props.accountLifetime,
        enabled: props.active && !accessRevoked });
    const { chips: runChips, capture: patternCapture } = useDiscussionRunChips({ discussion: discussionAddress, accountLifetime: props.accountLifetime,
        paneScopeId: pane.scopeId,
        disabled: !discussion?.capabilities.postMessages || composerBlocked || mutationsDisabled || discussion?.archivedAt !== null });
    const lifecycle = React.useCallback(async (kind: 'rename' | 'archive' | 'restore') => {
        if (!discussion) return; setLifecycleFailure(null);
        const result = kind === 'rename' ? await repository.rename(discussion.id, rename?.trim() ?? '') : kind === 'archive' ? await repository.archive(discussion.id) : await repository.restore(discussion.id);
        if (result.kind === 'succeeded') setRename(null); else setLifecycleFailure({ operation: kind, outcome: result });
    }, [discussion, rename, repository]);
    const checkInSettings = useDiscussionSettings({ repository, discussionId: props.target.discussionId, accountLifetime: props.accountLifetime,
        enabled: props.active && !accessRevoked && discussion?.capabilities.manageAccess === true });
    const accountCheckIn = useSetting('coordinationAutonomousCheckIn');
    const { status: checkInStatus, override: checkInOverride, saving: checkInSaving, canManage: checkInCanManage, dontPause, inherit } = checkInSettings;
    const checkInAction = React.useMemo(() => buildDiscussionCheckInMenuAction({
        settings: { status: checkInStatus, override: checkInOverride, saving: checkInSaving, canManage: checkInCanManage, dontPause, inherit },
        accountAfterTurns: accountCheckIn.afterTurns,
    }), [accountCheckIn.afterTurns, checkInCanManage, checkInOverride, checkInSaving, checkInStatus, dontPause, inherit]);
    // C4 capture-review composition consumes this controller; it owns no graph or save path here.
    const lifecycleActions = React.useMemo<readonly PageHeaderMenuAction[]>(() => discussion ? [
        { id: 'save-as-pattern', title: t('workflows.start.capture.title'), testID: 'discussion-save-as-pattern',
            disabled: !props.accountLifetime.isCurrent(), onSelect: () => patternCapture.open() },
        ...(discussion.capabilities.rename ? [{ id: 'rename', title: t('session.collaboration.discussion.rename'), disabled: mutationsDisabled, onSelect: () => setRename(discussion.title ?? '') }] : []),
        ...(discussion.capabilities.archive ? [{ id: 'archive', title: t('session.collaboration.discussion.archive'), disabled: mutationsDisabled, onSelect: () => lifecycle('archive') }] : []),
        ...(discussion.capabilities.restore ? [{ id: 'restore', title: t('session.collaboration.discussion.restore'), disabled: mutationsDisabled, onSelect: () => lifecycle('restore') }] : []),
        // DISC-17: this Discussion's own check-in, after the lifecycle rows (its own kind, so the menu divides them).
        ...(checkInAction && discussion.archivedAt === null ? [{ ...checkInAction, disabled: checkInAction.disabled || mutationsDisabled }] : []),
    ] : [], [checkInAction, discussion, lifecycle, mutationsDisabled, patternCapture.open, props.accountLifetime]);
    const displayMessages = React.useMemo<readonly DiscussionDisplayMessage[]>(() => {
        if (!mutation?.content || mutation.status === 'observed_success' || messages.some((message) => message.localId === mutation.localId)) return messages;
        return [...messages, {
            id: mutation.localId,
            discussionId: props.target.discussionId,
            localId: mutation.localId,
            seq: (messages.at(-1)?.seq ?? thread?.messageSeq ?? 0) + 1,
            authorAccountId: props.scope.accountId,
            // Authored as the confirmed row will be (same face and name), so confirmation changes nothing visible.
            accountActor: { v: 1, accountId: props.scope.accountId, profile: viewerProfile },
            producerV1: null,
            content: mutation.content,
            mentionedAccountIds: [...(mutation.mentionedAccountIds ?? [])],
            createdAt: 0,
        }];
    }, [messages, mutation, props.scope.accountId, props.target.discussionId, thread?.messageSeq, viewerProfile]);
    const sourceSubagents = props.source?.activity.subagents ?? NO_SOURCE_SUBAGENTS;
    const readSourceExecutionRunEntry = props.source?.activity.readExecutionRunEntry ?? readNoSourceExecutionRunEntry;
    const previousMessageLabels = React.useRef<ReadonlyMap<string, DiscussionMessageLabelProjection>>(new Map<string, DiscussionMessageLabelProjection>());
    const messageLabels = React.useMemo(() => {
        const next = projectDiscussionMessageLabels(displayMessages, { account: resolveAccountLabel, session: resolveSessionLabel }, previousMessageLabels.current);
        previousMessageLabels.current = next;
        return next;
    }, [displayMessages, resolveAccountLabel, resolveSessionLabel]);
    const workflowMessageRunIds = React.useMemo(() => {
        const referenced = new Set(messages.flatMap(message => {
            const workflow = resolveDiscussionWorkflowAttribution(message);
            return workflow ? [workflow.runId] : [];
        }));
        return managedRuns.runs.filter(run => referenced.has(run.id)).map(run => run.id);
    }, [managedRuns.runs, messages]);
    const workflowInvocations = useWorkflowInlineRunInvocations({ runIds: workflowMessageRunIds, accountLifetime: props.accountLifetime, enabled: threadViewed });
    const workflowRunsById = React.useMemo(() => new Map(managedRuns.runs.map(run => [run.id, run])), [managedRuns.runs]);
    const workflowRounds = React.useMemo(() => managedRuns.runs.flatMap(run => projectDiscussionWorkflowRounds({
        run, messages: displayMessages, invocations: workflowInvocations.byRunId.get(run.id) ?? [],
    })), [displayMessages, managedRuns.runs, workflowInvocations.byRunId]);
    const dataKey = React.useMemo(() => `discussion:${JSON.stringify([props.scope.serverId, props.scope.accountId, props.target.discussionId])}`, [props.scope.accountId, props.scope.serverId, props.target.discussionId]);
    const previousTimelineItems = React.useRef<Readonly<{ dataKey: string; items: readonly DiscussionTimelineItem<DiscussionDisplayMessage>[] }> | null>(null);
    const items = React.useMemo(() => {
        const previous = previousTimelineItems.current?.dataKey === dataKey ? previousTimelineItems.current.items : [];
        const next = buildDiscussionTimelineItems({ serverId: props.target.address.serverId, discussionId: props.target.discussionId, messages: displayMessages, subagents: sourceSubagents, readExecutionRunEntry: readSourceExecutionRunEntry, workflowRuns: managedRuns.runs, workflowRunAnswerIds: publishedByRun, workflowRounds, messageLabels }, previous);
        previousTimelineItems.current = { dataKey, items: next };
        return next;
    }, [dataKey, displayMessages, managedRuns.runs, workflowRounds, messageLabels, props.target.address.serverId, props.target.discussionId, publishedByRun, readSourceExecutionRunEntry, sourceSubagents]);
    // C7: a shared Bot's outward request waits in the thread that asked, under the Bot's reply to that
    // ask (or the ask itself while the Bot is blocked on it), joined by the request's admitted cause.
    const requesterApprovals = useDiscussionRequesterApprovals(discussionAddress, mentionedSessionAddresses);
    const previousApprovalPlacement = React.useRef<ReadonlyMap<string, ReadonlyArray<ReturnType<typeof useDiscussionRequesterApprovals>[number]>>>(new Map());
    const requesterApprovalsByMessage = React.useMemo(() => {
        const next = placeDiscussionRequesterApprovals(displayMessages, requesterApprovals, previousApprovalPlacement.current);
        previousApprovalPlacement.current = next;
        return next;
    }, [displayMessages, requesterApprovals]);
    const discussionReturnHref = React.useMemo(() => buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: props.target.address.serverId }, discussionId: props.target.discussionId } }), [props.target.address.serverId, props.target.discussionId]);
    const messageTimelineItems = React.useMemo(() => items.flatMap(item => item.kind === 'workflow_round' ? [...item.rows] : [item]), [items]);
    const proposalSelections = React.useMemo(() => docProposalSelections(messageTimelineItems.flatMap(item =>
        item.kind === 'human_message' ? [item.message] : [])), [messageTimelineItems]);
    const messageGroupStarts = React.useMemo(() => new Set(messageTimelineItems.flatMap((item, index) => {
        if (item.kind !== 'human_message') return [];
        const previous = messageTimelineItems[index - 1];
        return previous?.kind !== 'human_message' || startsDiscussionMessageGroup(item.message, previous.message)
            ? [item.message.id]
            : [];
    })), [messageTimelineItems]);
    // A passage is quoted where talk about it starts; replies and suggestions on the same passage don't repeat it.
    const repeatedPassages = React.useMemo(() => {
        const repeated = new Set<string>();
        let shown: DocPassageRefV1 | null = null;
        for (const item of messageTimelineItems) {
            if (item.kind !== 'human_message') continue;
            const passage = readDiscussionContentPassage(item.message.content);
            if (passage && shown && isSameDocPassage(passage, shown)) repeated.add(item.message.id);
            shown = passage;
        }
        return repeated;
    }, [messageTimelineItems]);
    // A suggestion a later one in this thread replaced is history: it no longer asks its author to redo it.
    const supersededProposals = React.useMemo(() => {
        const superseded = new Set<string>();
        let latest: string | null = null;
        for (const item of messageTimelineItems) {
            if (item.kind !== 'human_message' || !item.message.content || !isDiscussionDocEditProposalContentV1(item.message.content)) continue;
            if (latest) superseded.add(latest);
            latest = item.message.id;
        }
        return superseded;
    }, [messageTimelineItems]);
    const openRun = React.useCallback((item: Extract<DiscussionTimelineItem, { kind: 'agent_activity_reference' }>) => {
        const runId = item.entry.runId ?? item.subagent.runRef?.runId;
        if (runId) props.source?.agentConversation.openAgentConversation(runId, resolveSessionAgentActivityPresentation({ entry: item.entry, subagent: item.subagent }).title);
    }, [props.source]);
    const askAgentAboutSelection = React.useCallback((selected: ReadonlyArray<TranscriptSelectionToolbarMessage>) => {
        const prepared = prepareSelection(selected);
        if (!prepared || !props.source) return;
        const source = { ...prepared.source, draftCorrelationId: randomUUID() };
        pane.openDetailsTab(createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab({
            source,
            initialText: prepared.text,
        }), { intent: 'preview', start: true });
    }, [pane, prepareSelection, props.source]);
    type PreparedSelectionHandoff = NonNullable<ReturnType<typeof prepareSelection>>;
    const [selectionHandoffRetry, setSelectionHandoffRetry] = React.useState<PreparedSelectionHandoff | null>(null);
    const [selectionHandoffRetrying, setSelectionHandoffRetrying] = React.useState(false);
    const selectionHandoffInFlight = React.useRef<Promise<void> | null>(null);
    const performSelectionHandoff = React.useCallback(async (prepared: PreparedSelectionHandoff) => {
        const source = props.source;
        if (!source?.canSendToSession) return;
        if (selectionHandoffInFlight.current) {
            await selectionHandoffInFlight.current;
            return;
        }
        const operation = sendDiscussionSelectionToSession({
            sessionId: source.address.sessionId,
            serverId: source.address.serverId,
            selectedText: prepared.text,
            source: prepared.source,
            template: sendTemplate,
            sourceSessionName: null,
            appendToDraft: appendSessionDraftText,
            revealPrimaryComposer: device === 'phone'
                ? () => router.replace(buildScopedSessionRouteHref(source.address) as Href)
                : pane.closeDetails,
            focusPrimaryComposer: () => requestRegisteredSessionComposerFocus(source.address),
        }).then(() => undefined);
        selectionHandoffInFlight.current = operation;
        try {
            await operation;
        } finally {
            if (selectionHandoffInFlight.current === operation) {
                selectionHandoffInFlight.current = null;
            }
        }
    }, [device, pane.closeDetails, props.source, router, sendTemplate]);
    // The selection bar's one primary: Ask an agent about what was selected (CR5).
    const canAskAgent = discussion?.capabilities.askAgent === true && props.source?.canLaunchExecutionRuns === true;
    const selectionActions = React.useMemo<readonly TranscriptSelectionToolbarAction[] | undefined>(() => canAskAgent
        ? [{ testID: 'session-discussion-selection-ask-agent', label: t('session.collaboration.discussion.selection.askAgent'), primary: true, onPress: askAgentAboutSelection }]
        : undefined, [askAgentAboutSelection, canAskAgent]);
    const sendSelectionToComposer = React.useCallback(async (selected: ReadonlyArray<TranscriptSelectionToolbarMessage>) => {
        const prepared = prepareSelection(selected);
        if (!prepared) return;
        try {
            await performSelectionHandoff(prepared);
            setSelectionHandoffRetry(null);
        } catch {
            setSelectionHandoffRetry(prepared);
        }
    }, [performSelectionHandoff, prepareSelection]);
    const retrySelectionHandoff = React.useCallback(async () => {
        if (!selectionHandoffRetry || selectionHandoffRetrying) return;
        setSelectionHandoffRetrying(true);
        try {
            await performSelectionHandoff(selectionHandoffRetry);
            setSelectionHandoffRetry(null);
        } catch {
            // The immutable prepared selection stays available for another explicit retry.
        } finally {
            setSelectionHandoffRetrying(false);
        }
    }, [performSelectionHandoff, selectionHandoffRetry, selectionHandoffRetrying]);
    const observation = React.useMemo(() => createWebDomScrollObservation(), []);
    // A conversation the reader writes into: the transcript's frame with its jump to the newest message.
    const frame = React.useMemo(() => resolveConversationTranscriptListShellFrame({ platformOS: Platform.OS }), []);
    const read = React.useMemo(() => createDiscussionVisibleReadController({
        writeCursor: (seq) => repository.setReadState(props.target.discussionId, seq),
    }), [props.target.discussionId, repository]);
    React.useEffect(() => read.updateEligibility({
        activeAndVisible: threadViewed,
        lastReadSeq: discussion?.lastReadSeq ?? null,
    }), [discussion?.lastReadSeq, read, threadViewed, thread?.status]);
    // The rows the list last reported on screen. Readability can change while a row
    // stays visible (a locked placeholder opens once the Discussion key arrives), which
    // produces no new viewability callback, so admission is re-evaluated from here.
    const [visibleStandaloneMessageIds, setVisibleMessageIds] = React.useState<ReadonlySet<string>>(() => new Set());
    const [visibleRoundMessageIds, setVisibleRoundMessageIds] = React.useState<Readonly<Record<string, readonly string[]>>>({});
    const reportVisibleRoundMessageIds = React.useCallback((key: string, ids: readonly string[] | null) => {
        setVisibleRoundMessageIds(previous => {
            const known = previous[key];
            if (ids !== null && known?.length === ids.length && ids.every((id, index) => id === known[index])) return previous;
            if (ids === null) {
                if (known === undefined) return previous;
                const next = { ...previous };
                delete next[key];
                return next;
            }
            return { ...previous, [key]: ids };
        });
    }, []);
    const visibleMessageIds = React.useMemo(() => new Set([...visibleStandaloneMessageIds, ...Object.values(visibleRoundMessageIds).flat()]), [visibleRoundMessageIds, visibleStandaloneMessageIds]);
    const onVisible = React.useCallback((info: Readonly<{ viewableItems: readonly ViewToken<DiscussionTimelineItem<DiscussionDisplayMessage>>[] }>) => {
        setVisibleMessageIds(new Set(info.viewableItems.flatMap((token) => (
            token.isViewable !== false && token.item?.kind === 'human_message' ? [token.item.message.id] : []
        ))));
    }, []);
    const shownProposalDocs = React.useMemo(() => threadViewed
        ? [...new Set(messages.flatMap(message => visibleMessageIds.has(message.id)
            && message.content && isDiscussionDocEditProposalContentV1(message.content)
            // An accepted receipt needs the same current-Doc fact as an open card so its restore
            // eligibility is derived before Undo is offered on a cold Discussion mount.
            && message.docEditProposalDispositionV1?.state !== 'declined'
                ? [message.content.proposal.target.ref.artifactId] : []))]
        : [], [messages, threadViewed, visibleMessageIds]);
    const [proposalDocReads, setProposalDocReads] = React.useState<Readonly<Record<string, ProposalDocObservation>>>({});
    const reportProposalDocRead = React.useCallback<ReportProposalDocRead>((artifactId, client, read) => {
        setProposalDocReads(previous => {
            if (read === null) {
                if (previous[artifactId]?.client !== client) return previous;
                const next = { ...previous };
                delete next[artifactId];
                return next;
            }
            if (previous[artifactId]?.client === client && previous[artifactId]?.read === read) return previous;
            return { ...previous, [artifactId]: { client, read } };
        });
    }, []);
    const readProposalDoc = (artifactId: string): AdmittedDocRead => {
        const entry = proposalDocReads[artifactId];
        return shownProposalDocs.includes(artifactId) && entry?.client === proposalClient ? entry.read : LOADING_PROPOSAL_DOC;
    };
    // Only a real name speaks for the Run; an unnamed or unreadable one falls back to "Workflow run" in the row.
    const workflowRunLabel = (runId: string): string | null => {
        const name = resolveWorkflowRunDisplayName(managedRuns.metadataByRunId?.[runId]);
        return name.kind === 'name' ? formatWorkflowRunDisplayName(name) : null;
    };
    // The viewport caches cells, not just messages. Its explicit non-item inputs
    // must deliver real access/approval/label changes even when history is unchanged.
    // Rows still receive narrow props, so waking a cell need not rerender its Markdown.
    const rowContext = React.useMemo(() => ({
        requesterApprovalsByMessage, proposalDocReads, proposalClient, shownProposalDocs,
        workflowMetadata: managedRuns.metadataByRunId,
        workflowAccess: managedRuns.callerAccessByRunId,
        supportsAnotherRound: managedRuns.supportsAnotherRoundByRunId,
        retryRun: managedRuns.retry,
        workflowRoundErrors: workflowInvocations.errors,
        workflowInvocationFacts: workflowInvocations.byInvocationId,
        canReply: discussion?.archivedAt === null && discussion.capabilities.postMessages,
        viewer, mutation, source: props.source, mentionedSessionTitles, mentionedSessionAgentIds, clockEnabled: threadViewed && !accessRevoked,
        openQuotedMessage, replyToMessage, dismissRefusal,
    }), [requesterApprovalsByMessage, proposalDocReads, proposalClient, shownProposalDocs,
        managedRuns.metadataByRunId, managedRuns.callerAccessByRunId, managedRuns.supportsAnotherRoundByRunId, managedRuns.retry, workflowInvocations.errors, workflowInvocations.byInvocationId,
        discussion?.archivedAt, discussion?.capabilities.postMessages, viewer, mutation, props.source, mentionedSessionTitles, mentionedSessionAgentIds, threadViewed, accessRevoked,
        openQuotedMessage, replyToMessage, dismissRefusal]);
    // The canonical Legend adapter admits only a primitive dataVersion. Adapt
    // actual context changes to that key; do not serialize the entire history.
    const rowContextVersion = React.useRef({ context: rowContext, revision: 0 });
    if (rowContextVersion.current.context !== rowContext) {
        rowContextVersion.current = { context: rowContext, revision: rowContextVersion.current.revision + 1 };
    }
    const readableVisibleSeqs = React.useMemo(
        () => resolveReadableVisibleDiscussionSeqs({ messages, visibleMessageIds, lastReadSeq: discussion?.lastReadSeq ?? null }),
        [discussion?.lastReadSeq, messages, visibleMessageIds],
    );
    // Also re-observed when the surface itself becomes visible: rows already on screen
    // at that moment are seen then, although the list reports no new viewability.
    React.useEffect(
        () => read.observeVisibleMessageSeqs(readableVisibleSeqs),
        [read, readableVisibleSeqs, threadViewed],
    );
    const closeSurface = React.useCallback(() => {
        if (props.onClose) {
            props.onClose();
            return;
        }
        pane.closeDetails();
    }, [pane, props.onClose, props.target]);
    const retryDiscussion = React.useCallback(() => repository.refreshDiscussion(props.target.discussionId), [props.target.discussionId, repository]);
    const viewerRecipientId = `account:${props.scope.accountId}`;
    const recipientChoices = React.useMemo(() => ({
        ...recipientSelection,
        targets: recipientSelection.targets.filter((target) => target.id !== viewerRecipientId),
        selectedIds: recipientSelection.selectedIds.filter((id) => id !== viewerRecipientId),
    }), [recipientSelection, viewerRecipientId]);
    const presentAccountIds = React.useMemo(() => new Set(presentViewers.map((viewer) => viewer.account.accountId)), [presentViewers]);
    const leaveDiscussion = React.useCallback(() => {
        void participantManagement.requestLeave().then((outcome) => { if (outcome?.kind === 'succeeded') closeSurface(); });
    }, [closeSurface, participantManagement.requestLeave]);
    const retryAction = React.useMemo(() => ({ label: t('session.collaboration.discussion.retry'), onPress: () => {
        void retryDiscussion();
        managedRuns.retry();
    } }), [managedRuns.retry, retryDiscussion]);
    const phoneChrome = useDiscussionPhoneChrome(props.standaloneSurface);
    const stateChrome = (node: React.ReactElement) => <DiscussionPhoneChrome enabled={phoneChrome} onBack={closeSurface}>{node}</DiscussionPhoneChrome>;
    // Beside the column the page has its own rail (Participants, Agents, Details), as a Session does, and a
    // cockpit phone shows the same tabs as surfaces of its bar; the header then keeps only Invite. A phone
    // without that bar keeps them in its navigation band.
    const railHosted = useDiscussionRightSidebarHosted();
    // The header's own `⋯` carries what its pane lends (a phone group's other pages, close) after the page's rows.
    const lentMenuRows = useLentHeaderMenuRows() ?? [];
    const discussionTitle = discussion?.title ?? t('session.collaboration.discussion.encryptedTitle');
    const canManageParticipants = discussion !== null && discussion.capabilities.manageAccess && discussion.archivedAt === null;
    usePublishDiscussionRightSidebarPanels(railHosted && discussion ? {
        discussionParticipants: <DiscussionParticipantsPanel
            scope={props.scope}
            accountLifetime={props.accountLifetime}
            onChanged={refreshRoster}
            discussionId={props.target.discussionId}
            discussionTitle={discussionTitle}
            serverId={props.target.address.serverId}
            viewerAccountId={props.scope.accountId}
            roster={roster}
            accountActors={participantProfiles.accounts}
            presentAccountIds={presentAccountIds}
            resolveAccountLabel={resolveAccountLabel}
            onLeave={leaveDiscussion}
            management={participantManagement}
            canManage={canManageParticipants}
            onLeft={closeSurface}
        />,
        discussionAgents: <DiscussionAgentsPanel
            accountLifetime={props.accountLifetime}
            serverId={props.target.address.serverId}
            roster={roster}
            management={participantManagement}
            canManage={canManageParticipants}
        />,
        discussionDetails: <DiscussionDetailsPanel actions={lifecycleActions} />,
    } : null);
    if (accessRevoked) {
        return stateChrome(<SurfaceStateCard
            testID="session-discussion-details-state"
            kind="denied"
            title={t('sessionConversation.discussion.revokedTitle')}
            reason={t('sessionConversation.discussion.revokedReason')}
            action={{ label: t('sessionConversation.discussion.closeTab'), onPress: closeSurface }}
        />);
    }
    if (!thread || thread.status === 'idle' || (thread.status === 'loading' && !discussion)) {
        return stateChrome(<SurfaceStateCard testID="session-discussion-details-state" kind="loading" title={t('sessionConversation.discussion.loadingTitle')} />);
    }
    if (!discussion) {
        return stateChrome(<SurfaceStateCard testID="session-discussion-details-state" {...threadReadFailureCard(thread, retryAction)} />);
    }
    // Retained content stays at full strength; a failed or offline refresh is one line under the
    // header with its Retry, never a second state over the messages.
    // With no messages to keep, a failed read is the thread's own state in its body, not a line over nothing.
    const threadReadFailed = items.length === 0
        && (thread.status === 'offline' || thread.status === 'locked' || thread.status === 'error');
    const threadStaleLabel = threadReadFailed ? null : thread.status === 'offline'
        ? t('session.collaboration.discussion.offline')
        : thread.status === 'locked'
            ? t('session.access.preparing')
            : thread.status === 'error'
                ? threadReadFailureCard(thread, retryAction).reason
                : managedRuns.refreshFailed && managedRuns.phase !== 'failed'
                    ? t('session.collaboration.discussion.loadError') : null;
    const operationNotice = lifecycleFailure
        ? discussionLifecycleFailureLabel(lifecycleFailure.outcome, lifecycleFailure.operation)
        : threadStaleLabel === null && draft.status === 'offline'
            ? t('session.collaboration.discussion.offline')
            : draft.status === 'unsupported'
                ? t('sessionDrafts.status.unsupported')
                : draft.status === 'error'
                    ? t('session.collaboration.discussion.loadError')
                    : null;
    const renderMessageRow = (item: Extract<DiscussionTimelineItem<DiscussionDisplayMessage>, { kind: 'human_message' }>) => {
        const pendingMutation = item.message.localId === mutation?.localId ? mutation : null;
        const parentMessage = item.message.replyTarget?.kind === 'message'
            ? messageById.get(item.message.replyTarget.messageId) : undefined;
        const labels = item.labels ?? EMPTY_DISCUSSION_MESSAGE_LABELS;
        const workflowLabel = item.message.producerV1?.kind === 'workflow'
            ? workflowRunLabel(item.message.producerV1.runId) : null;
        const workflow = resolveDiscussionWorkflowAttribution(item.message);
        const workflowRun = workflow ? workflowRunsById.get(workflow.runId) : undefined;
        const invocation = workflow
            ? workflowInvocations.byInvocationId.get(workflow.runId)?.get(workflow.invocationRecordId) : undefined;
        return <DiscussionMessageRow
            workflowRetry={workflowRun && invocation ? <DiscussionWorkflowInvocationRetry messageId={item.message.id}
                run={workflowRun} invocation={invocation} accountLifetime={props.accountLifetime}
                canEdit={managedRuns.callerAccessByRunId?.[workflowRun.id]?.canEdit === true} /> : undefined}
            message={item.message}
            parentMessage={parentMessage}
            parentAuthorLabel={parentMessage ? resolveDiscussionMessageSpeakerLabel(parentMessage, {
                account: labels.account,
                session: resolveSessionLabel,
                workflowRun: workflowRunLabel,
            }, viewer) : null}
            onOpenMessage={openQuotedMessage}
            onReply={discussion.archivedAt === null && discussion.capabilities.postMessages ? replyToMessage : undefined}
            speakerLabel={resolveDiscussionMessageSpeakerLabel(item.message, {
                account: labels.account,
                session: resolveSessionLabel,
                workflowRun: workflowRunLabel,
            }, viewer)}
            agentId={item.message.producerV1?.kind === 'agent' ? sessionAgentIds.get(item.message.producerV1.sessionId) ?? null : null}
            workflowRunNamed={workflowLabel !== null}
            startsGroup={messageGroupStarts.has(item.message.id)}
            repeatsPassage={repeatedPassages.has(item.message.id)}
            selectedPassage={proposalSelections.get(item.message.id)}
            supersededProposal={supersededProposals.has(item.message.id)}
            selectable={isCommittedDisplayMessage(item.message) && isSelectableDiscussionMessage(item.message) && item.message.id !== mutation?.localId}
            resolveAccountLabel={labels.account}
            resolveSessionLabel={labels.session}
            serverId={props.scope.serverId}
            proposalClient={proposalClient}
            proposalDocRead={item.message.content && isDiscussionDocEditProposalContentV1(item.message.content)
                ? readProposalDoc(item.message.content.proposal.target.ref.artifactId) : LOADING_PROPOSAL_DOC}
            viewerAccountId={props.scope.accountId}
            attributionLine={resolveDiscussionReplyAttributionLine(item.message, props.scope, { account: labels.account })}
            requesterApprovals={requesterApprovalsByMessage.get(item.message.id)}
            returnHref={discussionReturnHref}
            renderReplySend={replySendSessionId ? renderReplySend : undefined}
            pendingMutation={pendingMutation}
            onRetryMutation={repository.retry}
            onRetryDelivery={isCommittedDisplayMessage(item.message) && repository.canRetryDelivery(item.message)
                ? () => repository.retryDelivery(props.target.discussionId, item.message.id) : undefined}
            onDismissMutation={dismissRefusal}
            clockEnabled={presenceEligible}
            attachmentReader={attachmentReader}
        />;
    };
    const participantsPopover = (
        <DiscussionParticipantsPopover
            scope={props.scope}
            accountLifetime={props.accountLifetime}
            onChanged={refreshRoster}
            discussionId={props.target.discussionId}
            discussionTitle={discussion.title ?? t('session.collaboration.discussion.encryptedTitle')}
            serverId={props.target.address.serverId}
            viewerAccountId={props.scope.accountId}
            roster={roster}
            accountActors={participantProfiles.accounts}
            presentAccountIds={presentAccountIds}
            resolveAccountLabel={resolveAccountLabel}
            onLeave={leaveDiscussion}
            management={participantManagement}
            canManage={discussion.capabilities.manageAccess && discussion.archivedAt === null}
            onLeft={closeSurface}
        />
    );
    const headerActions = <View style={styles.headerActions} ref={railHosted && !phoneChrome ? patternCaptureAnchorRef : undefined} collapsable={false}>
        {discussion.capabilities.manageAccess && discussion.archivedAt === null ? <DiscussionInviteButton
            scope={props.scope}
            accountLifetime={props.accountLifetime}
            roster={roster}
            management={participantManagement}
            discussionId={props.target.discussionId}
            discussionTitle={discussion.title ?? t('session.collaboration.discussion.encryptedTitle')}
            onChanged={refreshRoster}
        /> : null}
        {railHosted ? null : participantsPopover}
    </View>;
    const rosterLine = roster ? formatDiscussionRosterLine(summarizeDiscussionRoster(roster)) : null;
    // A phone folds the header into its one navigation band; the way back to the source moves into ⋯.
    const anchorOpen = anchorFact && anchorFact.kind !== 'diffStat' ? anchorFact.onPress : undefined;
    // With the phone bar's Details surface, the band keeps only what that surface does not offer.
    const phoneLifecycleActions = railHosted ? [] : lifecycleActions;
    const phoneMenuActions: readonly PageHeaderMenuAction[] = anchorFact && anchorOpen
        ? [{ id: 'open-anchor', title: t('session.collaboration.discussion.openAnchor', { name: anchorFact.kind !== 'diffStat' ? anchorFact.text : '' }), onSelect: anchorOpen }, ...phoneLifecycleActions]
        : phoneLifecycleActions;
    const phoneHeader = phoneChrome && rename === null ? <DetailsTabHeader
        testID="session-discussion-header"
        title={discussion.title ?? t('session.collaboration.discussion.encryptedTitle')}
        meta={[rosterLine, anchorFact && anchorFact.kind !== 'diffStat' ? anchorFact.text : null].filter((text): text is string => Boolean(text))
            .map((text, index) => ({ key: `fact:${index}`, text }))}
        navigation={{ onBack: closeSurface, includeTopInset: true }}
        actionsFit="compact"
        actions={headerActions}
        menu={phoneMenuActions.length > 0 ? <View ref={patternCaptureAnchorRef} collapsable={false}><PageHeaderMenu triggerTestID="session-discussion-actions-menu" actions={[...phoneMenuActions, ...lentMenuRows]} /></View> : undefined}
    /> : null;
    // Approval content shares the transcript scroll owner; it must not grow the composer band.
    const waitingApprovalCard = waitingApprovalId && attention ? <View style={[styles.stateLine, threadColumn, items.length > 0 ? styles.threadTextLine : null]}>
        {/* The waiting draft or request is decided here like a Session decides its own; one that needs its page keeps the line. */}
        <DiscussionWaitingApprovalCard approvalId={waitingApprovalId} serverId={props.scope.serverId} returnHref={buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: props.target.address.serverId }, discussionId: props.target.discussionId } })}
            fallback={<SurfaceStateCard
                testID="session-discussion-waiting-approval"
                size="line"
                kind="warning"
                accessibilitySemantics="status"
                title={attention.attentionReason === 'draft_waiting'
                    ? t('session.collaboration.discussion.home.draftWaiting')
                    : t('session.collaboration.discussion.home.approvalPending')}
                action={{ testID: 'session-discussion-waiting-approval-review', label: t('approvals.review'), onPress: reviewWaiting }}
            />} />
    </View> : null;
    return <TranscriptMessageSelectionBoundary sessionId={dataKey} eligibleMessageIdsInOrder={selectableMessages.map((message) => message.id)}>
        {shownProposalDocs.map(artifactId => <DiscussionProposalDocRead key={artifactId} artifactId={artifactId}
            client={proposalClient} accountLifetime={props.accountLifetime} onRead={reportProposalDocRead} />)}
        <View style={styles.root} testID="session-discussion-details">
            {/* The header and the thread beneath it are one pair: the thread's scroll drives the header's shade. */}
            <PaneHeaderScrollScope>
            {phoneHeader ?? <DetailsTabHeader
                testID="session-discussion-header"
                columnMaxWidthPx={threadColumn.maxWidth}
                title={discussion.title ?? t('session.collaboration.discussion.encryptedTitle')}
                // Who is in it and who can read it (lab T2-A header line); live presence leads it.
                meta={roster ? (() => {
                    const facts = summarizeDiscussionRoster(roster);
                    return [
                        { key: 'roster', text: formatDiscussionRosterLine(facts), testID: 'session-discussion-roster' },
                        ...(anchorFact ? [anchorFact] : []),
                        { key: 'audience', text: facts.inherited ? t('session.collaboration.discussion.participants.teamCanRead') : t('session.collaboration.discussion.participants.invitedOnly'), icon: facts.inherited ? 'users' as const : 'lock' as const },
                    ];
                })() : undefined}
                // With the rail, Save as pattern (from Details) hangs from the header's actions instead of a ⋯ menu.
                actions={headerActions}
                // Who is in it leads the line (lab T2-A); live presence follows the faces when someone is here.
                metaLeadingKind="mark"
                metaLeading={roster || presenceLabel ? <View style={styles.presenceRow}>
                            {roster ? <DiscussionRosterFaces roster={roster} serverId={props.scope.serverId} accountActors={participantProfiles.accounts} viewerAccountId={props.scope.accountId} accessibilityLabel={formatDiscussionRosterLine(summarizeDiscussionRoster(roster))} /> : null}
                            {presenceLabel ? <>
                                <DiscussionPresenceFaces viewers={presentViewers} stale={presenceStale} />
                                <Text testID="session-discussion-presence" accessibilityLiveRegion="polite" style={styles.headerMeta} numberOfLines={1}>{presenceLabel}</Text>
                                {roster ? <Text style={styles.headerMeta}>·</Text> : null}
                            </> : null}
                </View> : null}
                controls={rename !== null ? <TextInput testID="session-discussion-rename-input" style={[styles.input, { flex: 1 }]} value={rename} onChangeText={setRename} accessibilityLabel={t('session.collaboration.discussion.rename')} autoFocus /> : undefined}
                buttons={rename !== null ? [{ label: t('common.save'), disabled: !rename.trim() || mutationsDisabled, onPress: () => void lifecycle('rename') }] : undefined}
                menu={rename === null && lifecycleActions.length > 0 && !railHosted ? <View ref={patternCaptureAnchorRef} collapsable={false}><PageHeaderMenu triggerTestID="session-discussion-actions-menu" actions={[...lifecycleActions, ...lentMenuRows]} /></View> : undefined}
            />}
            {phoneChrome && railHosted ? <DiscussionPhonePageStrip /> : null}
            {threadStaleLabel ? <SurfaceFreshnessLine
                testID="session-discussion-freshness"
                reason={threadStaleLabel}
                tone={thread.status === 'offline' ? 'neutral' : 'warning'}
                action={retryAction}
            /> : null}
            {operationNotice ? <View style={[styles.stateLine, threadColumn]}>
                <SurfaceStateCard testID="session-discussion-notice" size="line" kind={lifecycleFailure ? 'error' : 'warning'} title={operationNotice} />
            </View> : null}
            {draft.conflict ? <SessionDraftConflictResolution scope={props.scope} address={draftAddress} conflict={draft.conflict} /> : null}
            {/* The Session keyboard scaffold: the thread above, what is being written (state lines and the
                composer) below, lifted with the software keyboard on a phone as a Session's composer is. */}
            <AgentContentView
                content={<View style={styles.messages}>
                {threadReadFailed ? <View style={[styles.stateLine, threadColumn, styles.readFailure]}>
                    <SurfaceStateCard testID="session-discussion-thread-state" {...threadReadFailureCard(thread, retryAction)} />
                </View> : <TranscriptListShell<DiscussionTimelineItem<DiscussionDisplayMessage>>
                    key={dataKey}
                    dataKey={dataKey}
                    viewportRetention={repository}
                    data={items}
                    extraData={rowContextVersion.current.revision}
                    frame={frame}
                    webDomObservation={observation}
                    keyExtractor={(item) => item.kind === 'human_message' ? `message:${item.message.localId ?? item.message.id}` : item.kind === 'workflow_run' ? `workflow:${item.run.id}` : item.kind === 'workflow_run_end' ? `workflow-end:${item.run.id}` : item.kind === 'workflow_round' ? `round:${JSON.stringify([item.round.runId, item.round.index, item.rows[0]!.message.id])}` : item.kind === 'participant_reply' ? `participant:${JSON.stringify([item.message.id, item.sessionId])}` : `run:${item.entry.runId ?? item.subagent.id}`}
                    onViewableItemsChanged={onVisible}
                    viewabilityConfig={VIEWABILITY}
                    onStartReached={thread.hasMoreOlder ? () => void repository.loadOlderMessages(props.target.discussionId) : undefined}
                    onStartReachedThreshold={0.2}
                    header={thread.hasMoreOlder || managedRuns.phase === 'failed' ? <>{thread.hasMoreOlder ? <HappierPressable style={styles.retry} accessibilityRole="button" accessibilityLabel={t('session.collaboration.discussion.loadOlder')} onPress={() => void repository.loadOlderMessages(props.target.discussionId)}><Text style={styles.retryText}>{t('session.collaboration.discussion.loadOlder')}</Text></HappierPressable> : null}
                        {managedRuns.phase === 'failed' ? <View style={threadColumn}><SurfaceStateCard
                            testID="session-discussion-workflow-runs-state" size="line" kind="unavailable"
                            title={t('workflows.destination.history.loadFailedTitle')}
                            reason={t('workflows.destination.history.loadFailedBody')}
                            action={{ label: t('session.collaboration.discussion.retry'), onPress: managedRuns.retry }}
                        /></View> : null}</> : null}
                    // While the messages are still on their way the header and composer stay and the thread shows
                    // its loading rows (lab T2-ST "Loading"), never an empty claim it hasn't checked.
                    footer={<>{waitingApprovalCard}{items.length === 0 ? thread.status === 'loading'
                        ? <View testID="session-discussion-loading" style={[styles.loadingRows, threadColumn]}><SkeletonRows rows={4} /></View>
                        : <SurfaceStateCard testID="session-discussion-empty" kind="empty" title={t('session.collaboration.discussion.emptyActive')} /> : null}
                        {/* The composer floats over the thread on a phone; the last message scrolls clear of it. */}
                        <ComposerKeyboardScrollInset /></>}
                    renderItem={({ item }) => {
                        if (item.kind === 'workflow_run' || item.kind === 'workflow_run_end') {
                            // The header under the asking message and, for a finished run with replies, the end row
                            // after its last reply; the run's operations sit on exactly one of them (lab T4 FD).
                            const runProps = { run: item.run, metadata: managedRuns.metadataByRunId?.[item.run.id],
                                supportsAnotherRound: managedRuns.supportsAnotherRoundByRunId?.[item.run.id],
                                canEdit: managedRuns.callerAccessByRunId?.[item.run.id]?.canEdit === true,
                                accountLifetime: props.accountLifetime, onStarted: managedRuns.onStarted,
                                publishedMessageIds: publishedByRun.get(item.run.id) ?? NO_MESSAGE_IDS, onSaveAsPattern: patternCapture.open };
                            const factError = workflowInvocations.errors[item.run.id];
                            return <>{item.kind === 'workflow_run_end'
                                ? <DiscussionWorkflowRunEndRow {...runProps} replyTextInset={THREAD_ROW_SELECTION_EDGE_PX + SPEAKER_FACE_PX + theme.space.s10} />
                                : <DiscussionWorkflowRunRow {...runProps} endRow={item.endRow === true} />}
                                {item.kind === 'workflow_run' && factError ? <SurfaceStateCard size="line" kind="unavailable" title={factError.title} reason={factError.message}
                                    action={{ label: t('common.retry'), onPress: () => workflowInvocations.retry(item.run.id) }} /> : null}</>;
                        }
                        if (item.kind === 'participant_reply') return null;
                        if (item.kind === 'workflow_round') {
                            const digest = item.rows.find(row => row.message.id === item.round.digestMessageId);
                            return <DiscussionWorkflowRoundRow round={item.round} resolveSessionLabel={resolveSessionLabel}
                                rows={item.rows}
                                onVisibleMessageIdsChange={reportVisibleRoundMessageIds}
                                digest={digest ? renderMessageRow(digest) : null}>
                                {item.rows.map(row => <React.Fragment key={row.message.id}>{renderMessageRow(row)}</React.Fragment>)}
                            </DiscussionWorkflowRoundRow>;
                        }
                        if (item.kind === 'agent_activity_reference') {
                            return <View style={styles.reference}>
                                <DiscussionAgentActivityReference entry={item.entry} subagent={item.subagent} onPress={() => openRun(item)} />
                            </View>;
                        }
                        return renderMessageRow(item);
                    }}
                />}
                {/* The shared selection bar floats over the thread's foot (collab lab D1), so it never
                    reserves a band of its own while nothing is selected. */}
                <DiscussionPatternCapturePanel capture={patternCapture} anchorRef={patternCaptureAnchorRef}
                    discussionTitle={discussion.title ?? t('session.collaboration.discussion.encryptedTitle')}
                    messages={patternCaptureMessages} accountLifetime={props.accountLifetime} />
                <View pointerEvents="box-none" style={styles.selectionToolbar}>
                <TranscriptSelectionToolbar selectableMessagesInOrder={selectableMessages} bulkCopyFormat={transcriptBulkCopyFormat} roleLabels={{ user: t('session.collaboration.discussion.collaborator'), assistant: t('voiceActivity.format.assistant') }} sendToSessionEnabled={discussion.capabilities.sendToSession && props.source?.canSendToSession === true} onSendToSession={sendSelectionToComposer} formatSelection={(selected) => prepareSelection(selected)?.text ?? null} selectionUnavailableText={t('session.collaboration.discussion.contentUnavailable')} additionalActions={selectionActions} />
            </View>
            </View>}
                input={<>
            {selectionHandoffRetry ? <View style={[styles.stateLine, threadColumn, styles.threadTextLine]}><SurfaceStateCard
                testID="session-discussion-selection-handoff-error"
                size="line"
                kind="error"
                accessibilitySemantics="status"
                title={t('session.collaboration.discussion.selection.handoffError')}
                action={{ testID: 'session-discussion-selection-handoff-retry', label: t('common.retry'), onPress: retrySelectionHandoff, disabled: selectionHandoffRetrying, busy: selectionHandoffRetrying }}
            /></View> : null}
            {threadReadFailed ? waitingApprovalCard : null}
            {/* C3 §10 step 5: a participant Session waiting on its owner says so here and leads to the request in
                that Session; only a viewer who can see that Session gets the line, and nothing here answers it. */}
            {discussion.archivedAt === null ? rosterSessionAddresses.map((address, index) => <DiscussionParticipantRequestLine
                key={address.sessionId} style={[styles.stateLine, threadColumn, styles.threadTextLine]} sessionId={address.sessionId} serverId={address.serverId}
                accountLifetime={props.accountLifetime} enabled={props.active && !accessRevoked}
                label={rosterSessionTitles[index] ?? resolveSessionLabel(address.sessionId) ?? t('session.collaboration.discussion.participants.session')} />) : null}
            {/* Send to drops anyone who left; say so once, and OK keeps only who is still here. */}
            {recipientSelection.removedRecipients.length > 0 && discussion.archivedAt === null && discussion.capabilities.postMessages
                ? <View style={[styles.stateLine, threadColumn, styles.threadTextLine]}><SurfaceStateCard
                    testID="session-discussion-recipients-removed"
                    size="line"
                    kind="warning"
                    accessibilitySemantics="status"
                    title={t('session.collaboration.discussion.replyDraft.removedTitle', {
                        names: recipientSelection.removedRecipients.map(recipientLabel).join(', '),
                    })}
                    reason={t('session.collaboration.discussion.replyDraft.removedBody')}
                    action={{ testID: 'session-discussion-recipients-removed-ok', label: t('common.ok'),
                        onPress: () => setRecipients(recipientSelection.selectedRecipients) }}
                /></View> : null}
            {outwardReply && discussion.archivedAt === null && discussion.capabilities.postMessages
                ? <View style={[styles.stateLine, threadColumn, styles.threadTextLine]}><SurfaceStateCard
                    testID="session-discussion-reply-outward"
                    size="line"
                    kind="empty"
                    iconName="arrow-square-out"
                    accessibilitySemantics="status"
                    title={t('session.collaboration.discussion.outwardReply', { conversation: outwardReply.conversationDisplayName })}
                /></View> : null}
            {discussion.archivedAt !== null
                ? <View style={[styles.stateLine, threadColumn, styles.threadTextLine]}><SurfaceStateCard testID="session-discussion-archived" size="line" kind="unavailable" iconName="archive" title={t('session.collaboration.discussion.archivedNotice')} /></View>
                : discussion.capabilities.postMessages
                    ? <>
                    {/* R3 slot 2: a participant's held check-in, above the composer (P1). */}
                    <DiscussionCheckInBanner serverId={props.scope.serverId} participantSessionIds={rosterSessionIds} />
                    <DiscussionDraftComposer scope={props.scope} accountLifetime={props.accountLifetime} address={props.target.address} discussionId={props.target.discussionId} roster={roster} onRefreshParticipants={refreshRoster} availability="available" disabled={composerBlocked || mutationsDisabled} onSend={(content, attachments) => void send(content, attachments)} draftAddress={draftAddress} prepareParticipantMentions={prepareParticipantMentions} extraActionChips={runChips} recipients={recipientChoices} contextItems={contextItems} />
                    </>
                    : <View style={[styles.stateLine, threadColumn, styles.threadTextLine]}><SurfaceStateCard testID="session-discussion-read-only" size="line" kind="denied" title={t('session.collaboration.discussion.locked')} /></View>}
                </>}
            />
            </PaneHeaderScrollScope>
        </View>
    </TranscriptMessageSelectionBoundary>;
}

/**
 * A phone shows a Discussion the way it shows a Session (lab T2-Ap): one navigation band with Back, the
 * name and its who-and-where line, and the band's few controls. The pushed route hides its own bar for
 * it, so every state of the page, loading and refused included, keeps Back.
 */
function useDiscussionPhoneChrome(standaloneDiscussion: boolean): boolean {
    return useSurfaceStateSize() === 'phone' && standaloneDiscussion;
}

function DiscussionPhoneChrome(props: Readonly<{
    enabled: boolean;
    title?: string;
    subtitle?: string;
    right?: React.ReactNode;
    onBack?: () => void;
    children: React.ReactNode;
}>) {
    if (!props.enabled) return <>{props.children}</>;
    return <View style={styles.root} testID="session-discussion-phone-chrome">
        <DetailsTabHeader
            testID="session-discussion-header"
            title={props.title ?? t('session.collaboration.discussion.title')}
            meta={props.subtitle ? [{ key: 'subtitle', text: props.subtitle }] : undefined}
            navigation={props.onBack ? { onBack: props.onBack, includeTopInset: true } : undefined}
            actionsFit="compact"
            actions={props.right}
        />
        {props.children}
    </View>;
}

/** The faces of the people in this conversation right now; the names are read from the line beside. */
const DiscussionPresenceFaces = React.memo((props: Readonly<{ viewers: readonly SessionHumanPresenceViewer[]; stale: boolean }>) => {
    if (props.viewers.length === 0) return null;
    return <View
        testID="session-discussion-presence-faces"
        accessible
        accessibilityLabel={formatSessionPresenceViewerNames(props.viewers, { stale: props.stale })}
        style={props.stale ? { opacity: STALE_PRESENCE_FACE_OPACITY } : undefined}
    >
        <AvatarStack size={20} entries={props.viewers.slice(0, PRESENCE_FACE_LIMIT).map((viewer) => ({
            key: viewer.account.accountId,
            content: <Avatar id={viewer.account.accountId} imageUrl={viewer.account.avatarUrl} size={20} />,
        }))} />
    </View>;
});

/**
 * One message in a conversation. A leaf with its own selection subscription, so selecting one row
 * re-renders that row alone.
 */
const DiscussionMessageRow = React.memo((props: Readonly<{
    message: DiscussionDisplayMessage;
    workflowRetry?: React.ReactNode;
    /** P3: the page's Send-to-Session row for a finished agent reply (CL-B owns it); absent where it can't send. */
    renderReplySend?: (message: DiscussionDisplayMessage) => React.ReactNode;
    parentMessage?: DiscussionDisplayMessage;
    parentAuthorLabel: string | null;
    onOpenMessage: (messageId: string) => void;
    /** Choose this message as what the next post answers; absent where nobody can post. */
    onReply?: (messageId: string) => void;
    startsGroup: boolean;
    repeatsPassage: boolean;
    selectedPassage?: DocPassageRefV1;
    /** A later suggestion in this thread replaced this one. */
    supersededProposal: boolean;
    selectable: boolean;
    resolveAccountLabel: (accountId: string) => string | null;
    resolveSessionLabel: (sessionId: string) => string | null;
    serverId: string;
    speakerLabel: string;
    /** That Session's Agent, for its mark; null when this Home cannot read it (the neutral agent glyph stands in). */
    agentId: string | null;
    /** Whether Account-private metadata supplied a name beyond the generic Run label. */
    workflowRunNamed: boolean;
    proposalClient: ArtifactActionsClient;
    proposalDocRead: AdmittedDocRead;
    viewerAccountId: string;
    /** "Asked by … · answered by …" from the reply's stamped cause; null when no person asked. */
    attributionLine: string | null;
    requesterApprovals: ReadonlyArray<ReturnType<typeof useDiscussionRequesterApprovals>[number]> | undefined;
    returnHref: string;
    pendingMutation: DiscussionRepositoryMutation | null;
    onRetryMutation: (localId: string) => void;
    onRetryDelivery?: React.ComponentProps<typeof DiscussionDeliveryNotice>['onRetry'];
    onDismissMutation: () => void;
    clockEnabled: boolean;
    attachmentReader: DiscussionAttachmentReader;
}>) => {
    const { message, pendingMutation } = props;
    // Committed files open through the Discussion's exact read; a send still in flight has no bytes to read yet.
    const attachments = React.useMemo(() => message.content ? readDiscussionAttachmentPayloadsV1(message.content) : [], [message.content]);
    const committedAttachments = attachments.length > 0 && isCommittedDisplayMessage(message) && message.id !== pendingMutation?.localId;
    const { theme } = useUnistyles();
    const selection = useOptionalTranscriptSelectionRow(message.id);
    // The transcript's one row-action policy: on a fine pointer the select mark waits for hover, focus
    // or selection mode, so the conversation reads as messages rather than a column of checkboxes.
    const hover = useRowActionHoverHost();
    const selectRevealed = shouldShowTranscriptRowActions({
        platformOS: Platform.OS,
        isRowHovered: hover.isHovered,
        isActionHovered: false,
        coarsePrimaryPointer: useCoarsePrimaryPointer(),
        selectionModeActive: selection.isSelectionMode,
    });
    // Save as decision opens from this message's action, as on a Session answer; its state lives out here
    // because the revealed action slot hides as soon as the pointer leaves the row for the sheet.
    const decisionAnchorRef = React.useRef<View>(null);
    const [decisionOpen, setDecisionOpen] = React.useState(false);
    const [decisionSaved, setDecisionSaved] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const decisionSource = props.selectable && message.messageRef && message.content
        && !isDiscussionDocEditProposalContentV1(message.content) ? message.messageRef : null;
    const contentWidth = useLayoutMaxWidthStyle();
    const passage = props.repeatsPassage ? null : readDiscussionContentPassage(message.content);
    // A Workflow speaks as its Run, never as a Session; its outcome is the one its publisher stamped.
    const workflow = resolveDiscussionWorkflowAttribution(message);
    const agentOutcome = resolveDiscussionReplyOutcome(message);
    const presentation = resolveDiscussionReplyPresentation(message);
    const notice = presentation.kind === 'notice' ? presentation.outcome : null;
    const stopped = presentation.kind === 'message' && presentation.stopped;
    // An inbound channel message is posted by its connection's Account, but the outside sender speaks: their
    // self-chosen name shows with the channel mark and where it came from, never a member's face.
    const external = readDiscussionExternalSource(message);
    const speaker = props.speakerLabel;
    const actions = props.selectable && notice === null;
    const toggleSelection = selection.toggle;
    const chooseMenuItem = React.useCallback((id: DiscussionMessageMenuItemId) => {
        if (id === 'saveDecision') setDecisionOpen(true);
        else toggleSelection();
    }, [toggleSelection]);
    return <SentMessageRise rises={pendingMutation?.status === 'sending'}><HappierThreadMessage
        testID={`session-discussion-message-group-${props.startsGroup ? 'start' : 'continuation'}-${message.id}`}
        startsGroup={props.startsGroup}
        selected={selection.isSelected}
        space={theme.space}
        selectionColors={theme.colors.state.active}
        style={contentWidth}
        {...(actions ? hover.hoverProps : null)}
        face={props.startsGroup
                ? <DiscussionSpeakerFace message={message} serverId={props.serverId} viewerAccountId={props.viewerAccountId}
                    agentId={props.agentId} size={SPEAKER_FACE_PX} markSize={ICON_SIZE.md}
                    testID={(kind) => `session-discussion-message-face-${kind}-${message.id}`} />
                : null}
        attribution={props.startsGroup ? <>
                <Text testID={`session-discussion-message-actor-${message.id}`} style={styles.messageAuthor}>{speaker}</Text>
                {/* An unnamed Run already reads "Workflow run"; the tag would only repeat it. */}
                {message.producerV1 && (message.producerV1.kind === 'agent' || props.workflowRunNamed) ? <Text testID={`session-discussion-message-producer-${message.id}`} style={styles.meta}>
                    {message.producerV1.kind === 'agent' ? t('session.collaboration.discussion.viaAgent') : t('workflows.start.workflow')}</Text> : null}
                {external ? <Text testID={`session-discussion-message-external-${message.id}`} style={styles.meta}>
                    {t('session.collaboration.discussion.viaExternal', { conversation: external.conversationDisplayName })}</Text> : null}
                {pendingMutation && isTransientMutationStatus(pendingMutation)
                    ? <Text testID={`session-discussion-message-status-${message.localId}`} accessibilityLiveRegion="polite" style={styles.timestamp}>{mutationStatusLabel(pendingMutation)}</Text>
                    : message.createdAt > 0 ? <DiscussionMessageTimestamp messageId={message.id} createdAt={message.createdAt} enabled={props.clockEnabled} /> : null}
        </> : null}
        trailing={actions ? <RowActionRevealSlot revealed={selectRevealed || decisionOpen || menuOpen} style={styles.selectAffordance} testID={`session-discussion-select-slot-${message.id}`}>
            {/* CR5: Reply plus one ⋯; while selecting, each row carries only its select mark. */}
            {selection.isSelectionMode
                ? <View style={styles.rowActions}>
                    <SelectMessageButton messageId={message.id} enabled visible role="user" previewText={textOf(message.content, props.resolveAccountLabel, props.resolveSessionLabel)} ownerLabel={speaker} testID={`session-discussion-select-${message.id}`} />
                </View>
                : <View style={styles.rowActions}>
                    {props.onReply ? <IconButton testID={`session-discussion-reply-${message.id}`} size={28} variant="plain"
                        icon={<Icon name="arrow-elbow-up-left" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                        // Each message's Reply names whose message it answers, so a screen reader can tell them apart.
                        accessibilityLabel={t('session.collaboration.discussion.replyDraft.actionTo', { name: speaker })} tooltip={t('session.collaboration.discussion.replyDraft.action')}
                        onPress={() => props.onReply!(message.id)} /> : null}
                    {decisionSaved ? <View testID={`session-discussion-saved-decision-${message.id}`} style={styles.savedDecision} accessible
                        accessibilityRole="text" accessibilityLabel={t('memoryContext.memory.savedAsDecision')} accessibilityLiveRegion="polite">
                        <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.state.success.foreground} />
                    </View> : null}
                    {/* The decision sheet anchors to the ⋯ it was chosen from. */}
                    <View ref={decisionAnchorRef} collapsable={false}>
                        <DiscussionMessageMenu messageId={message.id} speakerLabel={speaker}
                            saveDecision={decisionSource !== null && !decisionSaved}
                            open={menuOpen} onOpenChange={setMenuOpen} onSelect={chooseMenuItem} />
                    </View>
                </View>}
        </RowActionRevealSlot> : null}
    >
            {/* Passed, failed or stopped with nothing kept: one quiet line under the speaker's byline (lab T2-A),
                nothing anyone has to read past. A stopped reply that kept a partial answer reads as the answer it is. */}
            {notice ? <View style={styles.outcomeLine} testID={`session-discussion-outcome-${notice}-${message.id}`}>
                {notice === 'failed' && props.workflowRetry ? props.workflowRetry : <Text accessibilityLiveRegion="polite" style={[styles.meta, styles.outcomeText, notice === 'failed' ? styles.outcomeFailed : null]}>
                    {[t(notice === 'pass' ? 'session.collaboration.discussion.reply.passed'
                        : notice === 'failed' ? 'session.collaboration.discussion.reply.failed'
                            : 'session.collaboration.discussion.reply.cancelled'),
                    message.content ? textOf(message.content, props.resolveAccountLabel, props.resolveSessionLabel).trim() : '',
                    ].filter(Boolean).join(' · ')}
                </Text>}
            </View> : <>
            {props.repeatsPassage ? null : passage || message.replyTarget?.kind === 'doc_passage'
                        ? <ArtifactPassageQuote testID={`discussion-reply-quote-${message.id}`} passage={passage} />
                        : message.replyTarget?.kind === 'message' ? <ReplyQuote testID={`discussion-reply-quote-${message.id}`} kind="message"
                            source={props.parentMessage?.content
                                ? { state: 'available', label: props.parentAuthorLabel ?? t('session.collaboration.discussion.quote.message'),
                                    text: textOf(props.parentMessage.content, props.resolveAccountLabel, props.resolveSessionLabel),
                                    onPress: () => props.onOpenMessage(props.parentMessage!.id) }
                                : { state: 'unavailable', label: t('session.collaboration.discussion.quote.message'),
                                    reason: t('session.collaboration.discussion.quote.unavailable') }} />
                        : message.replyTarget?.kind === 'task' ? <ReplyQuote testID={`discussion-reply-quote-${message.id}`} kind="task"
                            source={{ state: 'unavailable', label: t('session.collaboration.discussion.quote.task'),
                                reason: t('session.collaboration.discussion.quote.unavailable') }} /> : null}
            {message.content && isDiscussionDocEditProposalContentV1(message.content)
                ? <ArtifactEditProposal testID={`discussion-proposal-${message.id}`} client={props.proposalClient}
                    docRead={props.proposalDocRead}
                    proposalRef={message.messageRef ?? null} proposal={message.content.proposal}
                    selectedPassage={props.selectedPassage}
                    disposition={message.docEditProposalDispositionV1} viewerAccountId={props.viewerAccountId}
                    resolveAccountLabel={props.resolveAccountLabel} superseded={props.supersededProposal}
                    proposer={message.producerV1?.kind === 'agent' ? { label: speaker, mention: { sessionId: message.producerV1.sessionId } }
                        // A Run can't be asked to redo: Ask to redo addresses only a Session or a person.
                        : message.producerV1 === null && message.authorAccountId ? { label: speaker, mention: { accountId: message.authorAccountId } } : null} />
                : <DiscussionMessageContent message={message} serverId={props.serverId} attachmentsBelow={committedAttachments}
                    resolveAccountLabel={props.resolveAccountLabel} resolveSessionLabel={props.resolveSessionLabel} textStyle={styles.messageText} profile="transcript" />}
            {committedAttachments ? <DiscussionMessageAttachments reader={props.attachmentReader} messageId={message.id} attachments={attachments} /> : null}
            {/* Open run belongs to the Run: its header under the asking message carries it, and no reply repeats it
                (a Session's answer in a round is that Session's words; a Workflow's result is its message). */}
            {workflow && message.producerV1?.kind === 'workflow' ? <DiscussionWorkflowResult messageId={message.id}
                detail={readDiscussionWorkflowResultDetail(message.content)} /> : null}
            {/* One quiet line under an answer (lab T2-A): who asked, and that it read the conversation only up to
                that question (C3 cutoff). Explicit and final-return replies share it. */}
            {props.attributionLine || agentOutcome === 'answer' || stopped ? <Text style={styles.meta}>
                {props.attributionLine ? <Text testID={`session-discussion-message-attribution-${message.id}`}>{props.attributionLine}</Text> : null}
                {props.attributionLine && (agentOutcome === 'answer' || stopped) ? ' · ' : null}
                {agentOutcome === 'answer' ? <Text testID={`session-discussion-message-cutoff-${message.id}`}>{t('session.collaboration.discussion.reply.readUpTo')}</Text> : null}
                {/* DISC-19: the kept partial stays a readable answer; this says only that it isn't finished. */}
                {stopped ? <Text testID={`session-discussion-message-stopped-${message.id}`}>{t('session.collaboration.discussion.reply.stopped')}</Text> : null}
            </Text> : null}
            {props.renderReplySend && agentOutcome === 'answer' && !stopped && isCommittedDisplayMessage(message)
                ? props.renderReplySend(message) : null}
            {isCommittedDisplayMessage(message) ? <DiscussionDeliveryNotice message={message} resolveSessionLabel={props.resolveSessionLabel}
                onRetry={props.onRetryDelivery} textStyle={styles.meta} errorStyle={styles.error} retryStyle={styles.retry} retryTextStyle={styles.retryText} /> : null}
            </>}
            {props.requesterApprovals?.map((approval) => <ApprovalRequesterThreadCard
                key={approval.artifact.id} approval={approval} serverId={props.serverId}
                requesterAccountActor={message.requesterAccountActor} returnHref={props.returnHref} />)}
            {pendingMutation && !isTransientMutationStatus(pendingMutation) && mutationStatusLabel(pendingMutation) ? <Text testID={`session-discussion-message-status-${message.localId}`} accessibilityLiveRegion="polite" style={pendingMutation.status === 'failed' ? styles.error : styles.deliveryStatus}>{mutationStatusLabel(pendingMutation)}</Text> : null}
            {pendingMutation ? <MutationRecovery mutation={pendingMutation} onRetry={() => void props.onRetryMutation(pendingMutation.localId)} onDismiss={props.onDismissMutation} /> : null}
            {decisionOpen && decisionSource ? <SaveMemoryDecisionSheet
                seed={seedMemoryDecisionFromMessage(decisionSource, textOf(message.content, props.resolveAccountLabel, props.resolveSessionLabel))}
                anchorRef={decisionAnchorRef} onClose={() => setDecisionOpen(false)}
                onSaved={() => { setDecisionOpen(false); setDecisionSaved(true); }} /> : null}
    </HappierThreadMessage></SentMessageRise>;
});

/**
 * Exactly one exit per settled state: an unknown outcome or transient failure
 * retries the same identity; a definitive refusal is dismissed and the draft
 * stays for a fresh attempt.
 */
function DiscussionMessageTimestamp(props: Readonly<{ messageId: string; createdAt: number; enabled: boolean }>) {
    const readNextRefresh = React.useCallback((nowMs: number) => readShortRelativeTimeRefreshAtMs(props.createdAt, nowMs), [props.createdAt]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, props.enabled);
    return <Text testID={`session-discussion-message-timestamp-${props.messageId}`} accessibilityRole="text" accessibilityLabel={new Date(props.createdAt).toLocaleString()} style={styles.timestamp}>{formatShortRelativeTimeAt(props.createdAt, nowMs)}</Text>;
}

function MutationRecovery(props: Readonly<{ mutation: DiscussionRepositoryMutation; onRetry: () => void; onDismiss: () => void }>) {
    const dismissable = props.mutation.status === 'failed' && props.mutation.recovery === 'dismiss';
    const retryable = props.mutation.status === 'outcome_unknown' || (props.mutation.status === 'failed' && !dismissable);
    if (dismissable) {
        return <HappierPressable testID="session-discussion-mutation-dismiss" style={styles.retry} accessibilityRole="button" accessibilityLabel={t('session.collaboration.discussion.dismiss')} onPress={props.onDismiss}><Text style={styles.retryText}>{t('session.collaboration.discussion.dismiss')}</Text></HappierPressable>;
    }
    if (retryable) {
        return <HappierPressable testID="session-discussion-mutation-retry" style={styles.retry} accessibilityRole="button" accessibilityLabel={t('session.collaboration.discussion.retry')} onPress={props.onRetry}><Text style={styles.retryText}>{t('session.collaboration.discussion.retry')}</Text></HappierPressable>;
    }
    return null;
}
