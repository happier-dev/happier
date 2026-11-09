import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { DetailsStartSheetHost } from '@/components/appShell/panes/panePresentation';
import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { storage, useMessage, useTranscriptApprovalArtifactsForSession, useResolvedSessionMessageRouteId, useSession, useSessionTranscriptLoaded } from "@/sync/domains/state/storage";
import { resolveSessionMessageRouteId } from '@happier-dev/session-core/messages';
import { sync } from '@/sync/sync';
import { Deferred } from "@/components/ui/forms/Deferred";
import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';
import { normalizeToolCallForRendering } from '@happier-dev/session-core/tools';
import { useDestinationInstanceKey, useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { usePageBackControl } from '@/components/ui/layout/usePageBackControl';
import { NavigationBackChromeProvider, useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { readDeclinedApprovalAtToolCall, useToolApprovalRequestsIndex } from '@/components/tools/shell/views/toolApprovalPromptMatching';
import { TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS } from '@/components/tools/shell/approvals/transcriptSettledApprovalPresentations';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { ToolDetailsPageHeader } from '@/components/tools/shell/presentation/ToolDetailsPageHeader';
import { isQuestionRoutedToManager } from '@/components/tools/renderers/workflow/askUserQuestionCardState';
import { readInboxSessionTitle } from '@/components/inbox/sessionAttention/inboxSessionPrivacy';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useSessionRealtimeTranscriptConsumer } from '@/hooks/session/useSessionRealtimeTranscriptConsumer';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import {
    createSessionMessageDetailsStyles,
    SessionMessageDetailsView,
} from '@/components/sessions/transcript/details/SessionMessageDetailsView';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';

const SessionDestinationBody = retryableLazy<NonNullable<React.ComponentProps<typeof import('@/components/sessions/shell/SessionDestinationBody')['SessionDestinationBody']>>>(
    () => import('@/components/sessions/shell/SessionDestinationBody').then(module => ({ default: module.SessionDestinationBody })),
);

type SessionMessageRouteTheme = Parameters<typeof createSessionMessageDetailsStyles>[0];

type SessionMessageRouteStyles = Readonly<{
    loadingContainer: ViewStyle;
}> & ReturnType<typeof createSessionMessageDetailsStyles>;

export const createSessionMessageRouteStyles = (theme: SessionMessageRouteTheme): SessionMessageRouteStyles => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    ...createSessionMessageDetailsStyles(theme),
});

type MessageRouteParams = Readonly<{
    id?: string | string[];
    serverId?: string | string[];
    messageId?: string | string[];
    jumpChildId?: string | string[];
}>;

const MESSAGE_ROUTE_BACKFILL_RETRY_DELAY_MS = 100;

function normalizeRouteParam(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
        const first = value[0];
        if (typeof first === 'string') return first.trim();
    }
    return '';
}

export const WorkspaceRouteBody = React.memo(function SessionMessageRoute() {
    const params = useLocalSearchParams<MessageRouteParams>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
    const sessionId = normalizeSessionId(params.id);
    const messageId = normalizeRouteParam(params.messageId);
    const jumpChildId = normalizeRouteParam(params.jumpChildId) || null;

    if (!sessionId || !messageId) {
        return <SessionInvalidLinkFallback />;
    }

    return <SessionMessageRouteLoaded sessionId={sessionId} messageId={messageId} jumpChildId={jumpChildId} routeScope={routeScope} />;
});

function SessionMessageRouteLoaded(props: { sessionId: string; messageId: string; jumpChildId: string | null; routeScope: ReturnType<typeof createSessionRouteServerScope> }) {
    const router = useRouter();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const session = useSession(props.sessionId);
    const messagesLoaded = useSessionTranscriptLoaded(props.sessionId);
    const resolvedMessageId = useResolvedSessionMessageRouteId(props.sessionId, props.messageId);
    const resolvedJumpChildId = useResolvedSessionMessageRouteId(props.sessionId, props.jumpChildId ?? '');
    const jumpChildId = props.jumpChildId ? (resolvedJumpChildId ?? props.jumpChildId) : null;
    const message = useMessage(props.sessionId, resolvedMessageId ?? props.messageId);
    const messageTarget = React.useMemo(() => message && message.kind !== 'tool-call'
        && typeof message.seq === 'number' && Number.isFinite(message.seq)
        ? { routeMessageId: props.messageId, seq: message.seq }
        : undefined, [message, props.messageId]);
    const { theme } = useUnistyles();
    const styles = React.useMemo(() => createSessionMessageRouteStyles(theme), [theme]);
    const [messageBackfillComplete, setMessageBackfillComplete] = React.useState(false);

    const tool = message?.kind === 'tool-call' ? message.tool : null;
    useDestinationPageTitle(tool ? resolveToolHeaderTextPresentation({ tool: normalizeToolCallForRendering(tool), metadata: null }).title
        : message ? t('common.message') : null);
    const ownerMetadata = React.useMemo(() => session ? readSessionOwnerMetadataView(session) : null, [session]);
    // The page names the call and its outcome itself, in the transcript row's vocabulary, for every tool kind.
    // The Agent that asked is the Session itself; the Inbox names it by this same title.
    const agentState = session?.agentState;
    const sessionServerId = session?.serverId ?? null;
    const askedBy = React.useMemo(
        () => session && tool && isQuestionRoutedToManager({ tool, agentState }) ? readInboxSessionTitle(session, sessionServerId) : null,
        [agentState, session, sessionServerId, tool],
    );
    // The call's Action approval is a separate artifact: a declined one makes the call read as refused.
    const approvalRequests = useTranscriptApprovalArtifactsForSession(
        normalizeSessionAddress(session?.serverId, props.sessionId),
        TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS,
    );
    useToolApprovalRequestsIndex(approvalRequests);
    const declinedApproval = tool
        ? readDeclinedApprovalAtToolCall({ requests: approvalRequests, sessionId: props.sessionId, messageId: message?.id, tool })
        : null;
    const toolPageHeader = React.useMemo(
        () => tool ? <ToolDetailsPageHeader tool={tool} metadata={ownerMetadata} askedBy={askedBy} declinedApproval={declinedApproval} /> : null,
        [askedBy, declinedApproval, ownerMetadata, tool],
    );

    // A call's page is opened from its Session: Back returns there, even on a deep link with no history. A hosted
    // destination puts it on the page header's title line (the phone bar or the page's own gutter), as a Run does.
    const hosted = useDestinationInstanceKey() !== null;
    const inheritedBack = useNavigationBackControl();
    const { routeScope, sessionId } = props;
    const goBack = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: routeScope.buildHref(sessionId) });
    }, [routeScope, router, sessionId]);
    const pageBack = usePageBackControl('tool-details-back', goBack);

    // Trigger session visibility when component mounts
    React.useEffect(() => {
        sync.onSessionVisible(props.sessionId);
    }, [props.sessionId]);

    // This detail route renders live transcript-derived content but is a separate navigation screen
    // that does not mark the session surface visible. Register it as an explicit transcript consumer
    // so realtime projection routing keeps materializing transcript content while it is open.
    useSessionRealtimeTranscriptConsumer(props.sessionId);

    React.useEffect(() => {
        setMessageBackfillComplete(false);
    }, [props.messageId, props.sessionId]);

    // Best-effort hydration for deep links / hard refreshes: sessions list is paginated, and message fetch
    // is guarded when a session isn't known on the active server snapshot yet.
    const routeHydrationState = useHydrateSessionForRoute(
        props.sessionId,
        'MessageRoute.ensureSessionVisible',
        props.routeScope.hydrationOptions,
    );
    const sessionMissingAfterHydration = isSessionRouteHydrationMissing(routeHydrationState);

    // Message deep links may target messages older than the initial `/messages` page. If we can't find
    // the message after the initial load, try paging older messages until we either find it or run out.
    React.useEffect(() => {
        let canceled = false;
        if (sessionMissingAfterHydration || !messagesLoaded || message || messageBackfillComplete) return;

        fireAndForget((async () => {
            let exhausted = false;
            try {
                try {
                    await sync.ensureSessionVisibleForMessageRoute(props.sessionId, props.routeScope.hydrationOptions);
                } catch {
                    // best-effort only
                }
                while (!canceled) {
                    const transcript = storage.getState().sessionMessages[props.sessionId];
                    const currentId = transcript ? resolveSessionMessageRouteId({
                        routeMessageId: props.messageId, messagesById: transcript.messagesById, reducerState: transcript.reducerState,
                    }) : null;
                    if (currentId && transcript?.messagesById[currentId]) return;
                    const result = await sync.loadOlderMessages(props.sessionId);
                    if (canceled) return;

                    if (result.status === 'not_ready' || result.status === 'in_flight') {
                        await new Promise((r) => setTimeout(r, MESSAGE_ROUTE_BACKFILL_RETRY_DELAY_MS));
                        continue;
                    }

                    if (result.status === 'no_more' || result.hasMore === false) {
                        exhausted = true;
                        break;
                    }

                    if (result.loaded <= 0) {
                        // A page with no display rows is not proof of absence.
                        await new Promise((r) => setTimeout(r, MESSAGE_ROUTE_BACKFILL_RETRY_DELAY_MS));
                    }
                }
            } finally {
                if (!canceled && exhausted) {
                    setMessageBackfillComplete(true);
                }
            }
        })(), { tag: 'MessageRoute.loadOlderMessages' });

        return () => {
            canceled = true;
        };
    }, [message, messageBackfillComplete, messagesLoaded, props.messageId, props.routeScope.hydrationOptions, props.sessionId, resolvedMessageId, sessionMissingAfterHydration]);

    // Show loader while waiting for session and messages to load
    if (sessionMissingAfterHydration) {
        return <SessionInvalidLinkFallback />;
    }

    if (!session || !messagesLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            </View>
        );
    }
    
    // Only the exhausted history frontier establishes a missing message. Keep
    // that result on this route; a timed Back must not discard a source open.
    if (!message) {
        if (messageBackfillComplete) return <SessionInvalidLinkFallback />;
        return (
            <View style={styles.loadingContainer}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            </View>
        );
    }

    // An ordinary committed-message link is a location in its Session, not an
    // isolated text preview. Keep tool details on their existing detail surface.
    if (messageTarget) {
        return <React.Suspense fallback={<PaneLoadingFallback />}><SessionDestinationBody messageTarget={messageTarget} /></React.Suspense>;
    }
    
    return (
        <>
            <View style={{ ...styles.routeContent, paddingBottom: bottomChromeHeight }}>
                <NavigationBackChromeProvider control={hosted ? pageBack : inheritedBack}>
                    <DetailsStartSheetHost><Deferred>
                        <SessionMessageDetailsView
                            message={message}
                            sessionId={props.sessionId}
                            session={session}
                            jumpChildId={jumpChildId}
                            header={toolPageHeader}
                            declinedApproval={declinedApproval}
                        />
                    </Deferred></DetailsStartSheetHost>
                </NavigationBackChromeProvider>
            </View>
        </>
    );
}

export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
