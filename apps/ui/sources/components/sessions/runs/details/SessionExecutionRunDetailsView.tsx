import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import {
    isExecutionRunNotRunningMutationError,
    sessionExecutionRunGet,
    sessionExecutionRunStop,
} from '@/sync/ops/sessionExecutionRuns';
import {
    useMessage,
    useResolvedSessionMessageRouteId,
    useSessionMessages,
    useSessionPendingMessages,
    useSessionSidechainMessages,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import { renderExecutionRunStructuredMeta } from '@/components/sessions/runs/renderExecutionRunStructuredMeta';
import { SessionExecutionRunInfoCard } from '@/components/sessions/runs/details/SessionExecutionRunInfoCard';
import {
    resolveDaemonExecutionRunFallback,
    type ExecutionRunTranscriptFallback,
} from '@/components/sessions/runs/details/resolveDaemonExecutionRunFallback';
import { resolveExecutionRunGetFailureLoadedState } from '@/components/sessions/runs/details/resolveExecutionRunGetFailureLoadedState';
import { SessionMessageDetailsView } from '@/components/sessions/transcript/details/SessionMessageDetailsView';
import { StructuredResultView } from '@/components/tools/renderers/system/StructuredResultView';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import {
    NO_EXECUTION_RUN_INTERACTION,
    resolveExecutionRunInteractionAffordances,
} from '@/sync/domains/executionRuns/executionRunInteractionAffordances';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { buildToolCallMessageRouteId } from "@happier-dev/session-core/messages";
import type { Message, ToolCall } from "@happier-dev/session-core/messages";
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { findTranscriptExecutionRunState } from '@/sync/domains/session/subagents/executionRuns/deriveTranscriptExecutionRunStateIndex';
import { buildExecutionRunPublicStateFromTranscriptState } from '@/sync/domains/session/subagents/executionRuns/executionRunPublicStateFromTranscript';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
    isSidechainHydrationPendingStatus,
    useEnsureSidechainsLoaded,
} from '@/hooks/session/useEnsureSidechainsLoaded';
import { ChainTranscriptList } from '@/components/sessions/transcript/ChainTranscriptList';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { PendingMessagesTranscriptBlock } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { useSessionRecipientState } from '@/components/sessions/agentInput/routing/useSessionRecipientState';
import { useSessionAgentInputRoutingControls } from '@/components/sessions/agentInput/routing/useSessionAgentInputRoutingControls';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { useSessionBrowserContextRuntimeContext } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { useSessionDiscussionTitles } from '@/components/sessions/conversations/useSessionDiscussionTitles';
import { readRunDiscussionOrigin } from '@/components/sessions/agents/presentation/useSessionAgentRowOriginLabels';
import { ExecutionRunContextChip } from '@/components/sessions/runs/ExecutionRunContextChip';
import { useSessionAgentActivityRoster } from '@/hooks/session/useSessionAgentActivity';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { ExecutionRunStopFailedState } from '@/components/sessions/runs/details/ExecutionRunStopFailedState';
import { useExecutionRunMachineName } from '@/components/sessions/runs/details/useExecutionRunMachineName';
import { resolveExecutionRunTitle } from '@/components/sessions/runs/resolveExecutionRunTitle';
import {
    awaitTranscriptNavigationJumpHandler,
    readTranscriptNavigationJumpHandler,
} from '@/components/sessions/transcript/navigation/transcriptNavigationPaneStore';
import type { TranscriptNavigationEntry } from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';
import { ExecutionRunStepsRow } from '@/components/sessions/runs/details/ExecutionRunStepsRow';
import { AppSessionTranscriptSourceProvider, createAppSidechainHistoryLoader } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { requestRegisteredSessionComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useSetting } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { sendExecutionRunResultToSession } from './sendExecutionRunResultToSession';

type LoadState =
    | { status: 'loading' }
    | { status: 'error'; error: string }
    /** Neither the Run's host nor the loaded transcript has it (agents lab ST "gone", audit B16). */
    | { status: 'gone' }
    | {
        status: 'loaded';
        run: ExecutionRunPublicState;
        latestToolResult?: unknown;
        structuredMeta?: unknown;
        source: 'session_rpc' | 'transcript_fallback' | 'daemon_fallback';
    };

const NO_DISCUSSION_IDS: readonly string[] = Object.freeze([]);

/** The Run result projection is read standalone; it carries no transcript around it. */
const NO_TRANSCRIPT_MESSAGES: Message[] = [];

function isSessionEncryptionNotFoundError(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const code = typeof (input as { errorCode?: unknown }).errorCode === 'string' ? String((input as { errorCode?: string }).errorCode) : '';
    if (code === 'session_encryption_not_found') return true;
    const message = typeof (input as { error?: unknown }).error === 'string' ? String((input as { error?: string }).error) : '';
    return /session encryption not found/i.test(message);
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveExecutionRunTranscriptToolId(params: Readonly<{
    run?: ExecutionRunPublicState | null;
    latestToolResult?: unknown;
}>): string | null {
    return (
        readNonEmptyString((params.run as { sidechainId?: unknown } | null)?.sidechainId)
        ?? readNonEmptyString((params.run as { callId?: unknown } | null)?.callId)
        ?? readNonEmptyString((params.latestToolResult as { sidechainId?: unknown } | null)?.sidechainId)
        ?? readNonEmptyString((params.latestToolResult as { callId?: unknown } | null)?.callId)
    );
}

export type SessionExecutionRunDetailsViewHandle = Readonly<{
    reload: () => Promise<void>;
}>;

type SessionExecutionRunDetailsViewProps = Readonly<{
    sessionId: string;
    runId: string;
    serverId?: string | null;
    presentation?: 'screen' | 'panel';
    showInfoCard?: boolean;
    showSendComposer?: boolean;
    retryInputLocalId?: string;
    /** The name the opener already knows (the tab's title), so the wait says what is opening. */
    openingTitle?: string | null;
    /** Closes the surface hosting this Run (its Details tab), offered when the Run is gone. */
    onRequestClose?: () => void;
    /**
     * Hands the host a better name for this Run once it is known: the title the Run was given, or
     * its intent where the opener only had its id (a tab restored from before titles existed).
     */
    onTitleResolved?: (title: string) => void;
}>;

export const SessionExecutionRunDetailsView = React.memo(React.forwardRef<SessionExecutionRunDetailsViewHandle, SessionExecutionRunDetailsViewProps>((props, ref) => (
    <AppSessionTranscriptSourceProvider sessionId={props.sessionId} serverId={props.serverId}>
        <SessionExecutionRunDetailsContent {...props} ref={ref} />
    </AppSessionTranscriptSourceProvider>
)));

const SessionExecutionRunDetailsContent = React.forwardRef<SessionExecutionRunDetailsViewHandle, SessionExecutionRunDetailsViewProps>((props, ref) => {
    const source = useSessionTranscriptSource();
    const { theme } = useUnistyles();
    const router = useRouter();
    const interactiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const interactiveTargetStyle = React.useMemo(() => ({
        minWidth: interactiveTargetSize,
        minHeight: interactiveTargetSize,
        justifyContent: 'center' as const,
    }), [interactiveTargetSize]);
    const explicitServerId = props.serverId?.trim() || null;
    const session = useSessionViewShellSession(props.sessionId, explicitServerId);
    const hasQualifiedSession = explicitServerId === null || session !== null;
    const [state, setState] = React.useState<LoadState>({ status: 'loading' });
    const [daemonProcessLine, setDaemonProcessLine] = React.useState<string | null>(null);
    const [stopError, setStopError] = React.useState<string | null>(null);
    /** The Run's machine did not confirm a stop: the whole-session fallback is on offer. */
    const [stopUnconfirmed, setStopUnconfirmed] = React.useState(false);
    const [isStopping, setIsStopping] = React.useState(false);
    const [interactionError, setInteractionError] = React.useState<string | null>(null);
    const [pendingInteraction, setPendingInteraction] = React.useState<'cancel_turn' | 'resume' | null>(null);
    const [rawToolResultExpanded, setRawToolResultExpanded] = React.useState(false);
    const { messages: sessionMessages, isLoaded: sessionMessagesLoaded } = useSessionMessages(
        props.sessionId,
        { enabled: hasQualifiedSession },
    );
    const transcriptFallback = React.useMemo<ExecutionRunTranscriptFallback | null>(() => {
        const transcriptState = findTranscriptExecutionRunState(sessionMessages, props.runId);
        if (!transcriptState) return null;
        const run = buildExecutionRunPublicStateFromTranscriptState(transcriptState);
        if (!run) return null;
        const matchingMessage = sessionMessages.find((message) => message.id === transcriptState.toolMessageRouteId) ?? null;
        return {
            run,
            latestToolResult: matchingMessage && matchingMessage.kind === 'tool-call' ? matchingMessage.tool?.result : undefined,
            message: matchingMessage,
        };
    }, [props.runId, sessionMessages]);

    // One Run address owns the loaded tree. A load for the address already on
    // screen is a background refresh: it must not replace the loaded surface
    // (and the mounted composer with its text and selection) with a spinner.
    // Only an address that is not loaded yet, or an error, enters `loading`.
    const runAddressKey = `${explicitServerId ?? ''}\u0000${props.sessionId}\u0000${props.runId}`;
    const loadedRunAddressRef = React.useRef<string | null>(null);
    // Request currentness: concurrent loads (route effect, bus notification,
    // interaction, header Refresh) settle in arbitrary order, so only the newest
    // request may write state. Without this an older response overwrites a newer
    // one and the surface silently shows a superseded Run.
    const loadGenerationRef = React.useRef(0);

    const load = React.useCallback(async () => {
        const generation = loadGenerationRef.current + 1;
        loadGenerationRef.current = generation;
        const isCurrentRequest = () => loadGenerationRef.current === generation;
        if (!props.sessionId || !props.runId) {
            setState({ status: 'error', error: t('runs.runDetails.failedToLoad') });
            return;
        }
        // A qualified Run route may only use the Session materialized for that
        // exact Home. A same-id Session from the active Home cannot authorize an
        // RPC or seed transcript/daemon fallback state for this address.
        if (!hasQualifiedSession) {
            setState({ status: 'error', error: t('common.unavailable') });
            return;
        }
        const rpcOptions = explicitServerId ? { serverId: explicitServerId } : undefined;
        const getRun = (request: Readonly<{ runId: string; includeStructured: true }>) => (
            rpcOptions
                ? sessionExecutionRunGet(props.sessionId, request, rpcOptions)
                : sessionExecutionRunGet(props.sessionId, request)
        );
        if (loadedRunAddressRef.current !== runAddressKey) {
            setState({ status: 'loading' });
            setDaemonProcessLine(null);
        }
        const first = await getRun({ runId: props.runId, includeStructured: true });
        if (!isCurrentRequest()) return;
        const result =
            first.ok === false && isSessionEncryptionNotFoundError(first)
                ? await getRun({ runId: props.runId, includeStructured: true })
                : first;
        if (!isCurrentRequest()) return;
        if (result.ok === false) {
            if (result.errorCode === 'execution_run_not_found' && !sessionMessagesLoaded) {
                await source.history.loadOlder?.().catch(() => null);
                if (!isCurrentRequest()) return;
            }
            const daemonFallback = await resolveDaemonExecutionRunFallback({
                sessionId: props.sessionId,
                serverId: explicitServerId,
                runId: props.runId,
                transcriptFallback,
            }).catch(() => null);
            if (!isCurrentRequest()) return;
            const fallbackState = resolveExecutionRunGetFailureLoadedState({
                result,
                transcriptFallback,
                daemonFallback,
            });
            if (fallbackState) {
                loadedRunAddressRef.current = runAddressKey;
                setState(fallbackState);
                if (fallbackState.source === 'daemon_fallback') {
                    setDaemonProcessLine(daemonFallback?.daemonProcessLine ?? null);
                }
                return;
            }
            loadedRunAddressRef.current = null;
            // The host no longer has the Run and the loaded transcript does not hold it either: say
            // so, instead of a generic failure (or the endless spinner of audit B16). Only a loaded
            // transcript can vouch for that; an unloaded one is still a failure to read.
            if (result.errorCode === 'execution_run_not_found' && sessionMessagesLoaded) {
                setState({ status: 'gone' });
                return;
            }
            setState({ status: 'error', error: String(result.error ?? t('runs.runDetails.failedToLoad')) });
            return;
        }
        if (!('run' in result)) {
            loadedRunAddressRef.current = null;
            setState({ status: 'error', error: t('runs.runDetails.failedToLoad') });
            return;
        }
        const run = result.run;
        if (!run || typeof run.runId !== 'string') {
            loadedRunAddressRef.current = null;
            setState({ status: 'error', error: t('runs.runDetails.failedToLoad') });
            return;
        }
        loadedRunAddressRef.current = runAddressKey;
        setState({
            status: 'loaded',
            run,
            latestToolResult: result.latestToolResult,
            structuredMeta: result.structuredMeta,
            source: 'session_rpc',
        });
        const daemonFallback = await resolveDaemonExecutionRunFallback({
            sessionId: props.sessionId,
            serverId: explicitServerId,
            runId: props.runId,
            transcriptFallback: transcriptFallback ?? {
                run,
                latestToolResult: result.latestToolResult,
            },
        }).catch(() => null);
        if (!isCurrentRequest()) return;
        if (daemonFallback?.daemonProcessLine) {
            setDaemonProcessLine(daemonFallback.daemonProcessLine);
        }
    }, [explicitServerId, hasQualifiedSession, props.runId, props.sessionId, runAddressKey, sessionMessagesLoaded, source, transcriptFallback]);

    React.useEffect(() => {
        void load();
    }, [load]);

    React.useImperativeHandle(ref, () => ({
        reload: load,
    }), [load]);

    // Live Run state comes from the canonical execution-Run activity signal the
    // rest of the app already consumes (`execution-run-updated` → socket →
    // `executionRunActivityBus`), not from a Details-local timer or a second Run
    // store. A notification naming another Run of this Session is not this
    // surface, so it does not refetch; an unknown Run (`runId: null`) does.
    const runActivityServerId = explicitServerId ?? session?.serverId ?? null;
    React.useEffect(() => {
        if (!hasQualifiedSession || !runActivityServerId) return;
        return subscribeExecutionRunActivity(
            { serverId: runActivityServerId, sessionId: props.sessionId },
            (notification) => {
                if (notification.runId !== null && notification.runId !== props.runId) return;
                void load();
            },
        );
    }, [hasQualifiedSession, load, props.runId, props.sessionId, runActivityServerId]);

    const transcriptToolId = React.useMemo(() => {
        if (state.status !== 'loaded') return null;
        return resolveExecutionRunTranscriptToolId({
            run: state.run,
            latestToolResult: state.latestToolResult,
        });
    }, [state]);
    const transcriptToolRouteId = React.useMemo(() => buildToolCallMessageRouteId({ toolId: transcriptToolId }), [transcriptToolId]);
    const pendingScopeServerId = explicitServerId ?? session?.serverId;
    const pendingScopeResolution = useServerCredentialAccountScopeResolution(pendingScopeServerId);
    const pendingOutboxScope = pendingScopeResolution.kind === 'bound'
        ? pendingScopeResolution.scope
        : null;
    const { execute: executeAction, isCurrent: actionScopeIsCurrent, approval } = useMountedActionExecution(pendingOutboxScope);
    const { snapshot: acpCatalog } = useAcpCatalog(pendingOutboxScope);
    const acpCatalogSnapshot = acpCatalog?.catalog.status === 'ready' && !acpCatalog.stale ? acpCatalog.catalog : undefined;
    const interaction = source.useInteraction();
    const resolvedTranscriptMessageId = useResolvedSessionMessageRouteId(props.sessionId, transcriptToolRouteId ?? '');
    const transcriptMessageFromStore = useMessage(props.sessionId, resolvedTranscriptMessageId ?? transcriptToolRouteId ?? '');
    const transcriptMessage = transcriptMessageFromStore ?? transcriptFallback?.message ?? null;
    const executionRunRecipient = React.useMemo(() => ({
        kind: 'execution_run' as const,
        runId: props.runId,
    }), [props.runId]);
    const targetPending = useSessionPendingMessages(props.sessionId, executionRunRecipient);
    // The direct Run composer mounts before any transcript tool marker exists, so it composes the
    // same recipient/routing controls the tool-marker branch reaches through
    // `SessionMessageDetailsView`: one canonical send-mode control, no silent default.
    const executionRunParticipantTargets = React.useMemo<readonly SessionParticipantTarget[]>(() => {
        const displayLabel = t('session.participants.executionRun', { runId: executionRunRecipient.runId });
        return [{
            key: `execution_run:${executionRunRecipient.runId}`,
            displayLabel,
            recipient: { ...executionRunRecipient, label: displayLabel },
        }];
    }, [executionRunRecipient]);
    const executionRunRecipientState = useSessionRecipientState({
        targets: executionRunParticipantTargets,
        autoRecipient: executionRunRecipient,
    });
    const executionRunRoutingControls = useSessionAgentInputRoutingControls({
        isReadOnly: !interaction.canSendMessages,
        participantTargets: executionRunParticipantTargets,
        recipientState: executionRunRecipientState,
    });
    const browserContextRuntime = useSessionBrowserContextRuntimeContext();
    const transcriptSidechainIds = React.useMemo(
        () => transcriptToolId === null ? [] : [transcriptToolId],
        [transcriptToolId],
    );

    const sidechainHydration = useEnsureSidechainsLoaded({
        enabled: transcriptToolId !== null,
        sessionId: props.sessionId,
        sidechainIds: transcriptSidechainIds,
    });
    // A Run whose profile materializes nothing in the parent transcript never
    // gets a tool marker, so `SessionMessageDetailsView` — which is keyed on that
    // marker — can never host its transcript. The committed rows still exist under
    // the Run's own sidechain, so this branch reads the same sync-owned sidechain
    // projection and renders them through the same shared list, including the
    // pending-to-committed crossover for this exact target.
    const runSidechainMessages = useSessionSidechainMessages(props.sessionId, transcriptToolId);
    const runTranscriptMessages = React.useMemo(() => [...runSidechainMessages], [runSidechainMessages]);
    // The Run can be admitted before its transcript marker is materialized. Keep
    // this brief state visible until the canonical sidechain/pending projections
    // provide content; do not infer a timer, queue, or producer-owned lifecycle.
    const showPreMarkerState = state.status === 'loaded'
        && transcriptToolId === null
        && transcriptMessage === null
        && runTranscriptMessages.length === 0
        && targetPending.messages.length === 0
        && targetPending.discarded.length === 0;
    const runTranscriptDatasetKey = React.useMemo(() => {
        const address = normalizeSessionAddress(pendingScopeServerId ?? null, props.sessionId);
        return JSON.stringify([
            address ? sessionAddressKey(address) : props.sessionId,
            transcriptToolId ?? props.runId,
        ]);
    }, [pendingScopeServerId, props.runId, props.sessionId, transcriptToolId]);
    const loadOlderRunSidechain = React.useMemo(
        () => createAppSidechainHistoryLoader(props.sessionId, transcriptToolId),
        [props.sessionId, transcriptToolId],
    );
    const isRunSidechainHydrating = runTranscriptMessages.length === 0
        && isSidechainHydrationPendingStatus(
            transcriptToolId ? sidechainHydration.bySidechainId[transcriptToolId]?.status : undefined,
        );

    React.useEffect(() => {
        if (!hasQualifiedSession) return;
        if (pendingScopeServerId && !pendingOutboxScope) return;
        fireAndForget(
            sync.fetchPendingMessages(props.sessionId, pendingOutboxScope ?? undefined, executionRunRecipient),
            { tag: 'SessionExecutionRunDetailsView.fetchTargetPending' },
        );
    }, [executionRunRecipient, hasQualifiedSession, pendingOutboxScope, pendingScopeServerId, props.sessionId]);

    /**
     * Presentation-only envelope so the Run's own result reaches the transcript's
     * structured projection owner, which reads `state` and `result` and nothing
     * else. It is not a transcript row and is never published anywhere.
     */
    const latestToolResultProjection = React.useMemo<ToolCall | null>(() => {
        if (state.status !== 'loaded' || state.latestToolResult === undefined) return null;
        return {
            name: 'execution_run_result',
            state: 'completed',
            input: null,
            createdAt: 0,
            startedAt: null,
            completedAt: null,
            description: null,
            result: state.latestToolResult,
        };
    }, [state]);

    // Result first (agents lab RP1): a Run with a structured result shows that result as the page,
    // and how it got there — its transcript — waits behind one disclosure row. A Run without one
    // (a conversation, a Run still working) keeps its transcript as the body.
    const [showSteps, setShowSteps] = React.useState(false);
    const stepCount = runTranscriptMessages.length;
    const toggleSteps = React.useCallback(() => setShowSteps((current) => !current), []);
    const stepsRow = <ExecutionRunStepsRow expanded={showSteps} stepCount={stepCount} onToggle={toggleSteps} />;
    const structuredMeta = React.useMemo(() => {
        if (state.status !== 'loaded') return null;
        const meta = state.structuredMeta;
        if (!meta || typeof meta !== 'object') return null;
        const kind = typeof (meta as { kind?: unknown }).kind === 'string' ? (meta as { kind: string }).kind : '';
        if (!kind) return null;
        return { kind, payload: (meta as { payload?: unknown }).payload };
    }, [state]);
    const structuredCard = structuredMeta && !showSteps
        ? renderExecutionRunStructuredMeta({
            meta: structuredMeta,
            sessionId: props.sessionId,
            interaction,
            presentation: 'page',
            after: stepsRow,
            serverId: runActivityServerId,
            groupId: state.status === 'loaded' ? state.run.display?.groupId ?? null : null,
        })
        : null;
    const hasStructuredResult = structuredMeta !== null;
    /** The result as text for ⋯ → Copy result: the structured summary, else the raw result. */
    const copyResultText = React.useMemo(() => {
        const summary = (structuredMeta?.payload as { summary?: unknown } | undefined)?.summary;
        if (typeof summary === 'string' && summary.trim()) return summary.trim();
        if (state.status !== 'loaded' || state.latestToolResult === undefined || state.latestToolResult === null) return null;
        if (typeof state.latestToolResult === 'string') return state.latestToolResult;
        try {
            return JSON.stringify(state.latestToolResult, null, 2);
        } catch {
            return null;
        }
    }, [state, structuredMeta]);
    const canMutateRunViaSessionRpc = state.status === 'loaded' && state.source === 'session_rpc';
    // The run's own interaction projection is the only authority here. A transcript or
    // daemon fallback has no live retained controller behind it, so it stays readable
    // and cannot paint a composer, and a bounded job never acquires one by looking
    // long-lived. Status/intent/run-class inference used to decide this locally.
    const interactionAffordances = state.status === 'loaded' && canMutateRunViaSessionRpc
        ? resolveExecutionRunInteractionAffordances(state.run)
        : NO_EXECUTION_RUN_INTERACTION;
    const cancellableInputTurn = state.status === 'loaded'
        && state.run.inputTurns?.current?.state === 'active'
        ? {
            occurrenceId: state.run.inputTurns.occurrenceId,
            turnId: state.run.inputTurns.current.turnId,
        }
        : null;
    const canShowSendComposer = props.showSendComposer !== false && interactionAffordances.canSend;
    // The conversation this Run was started from (Ask Agent), named in the header and shown as the
    // body's context chip. Only a same-Session Discussion origin has one.
    const discussionOrigin = state.status === 'loaded' ? readRunDiscussionOrigin(state.run.launchOrigin, props.sessionId) : null;
    const discussionOriginAddress = React.useMemo(
        () => normalizeSessionAddress(explicitServerId ?? session?.serverId ?? null, props.sessionId),
        [explicitServerId, props.sessionId, session?.serverId],
    );
    const discussionOriginIds = React.useMemo(
        () => discussionOrigin ? [discussionOrigin.discussionId] : NO_DISCUSSION_IDS,
        [discussionOrigin?.discussionId],
    );
    const discussionTitles = useSessionDiscussionTitles({
        address: discussionOrigin ? discussionOriginAddress : null,
        discussionIds: discussionOriginIds,
    });
    const discussionOriginTitle = discussionOrigin ? discussionTitles.get(discussionOrigin.discussionId) ?? null : null;
    // Whether the Run waits on a person: the roster's canonical attention (the enriched roster is the
    // only owner that observes pending prompts), read into the same words the roster row uses.
    const roster = useSessionAgentActivityRoster({
        sessionId: props.sessionId,
        serverId: explicitServerId ?? session?.serverId ?? undefined,
        session,
    });
    const rosterRunEntry = roster.readExecutionRunEntry(props.runId);
    const runAttention = React.useMemo(
        () => rosterRunEntry ? resolveSessionAgentActivityPresentation({ entry: rosterRunEntry }).attention : null,
        [rosterRunEntry],
    );
    const runStatus = state.status === 'loaded' ? String((state.run as { status?: unknown }).status ?? 'unknown') : null;
    const runAnnouncement = stopError ?? interactionError ?? (runStatus === null
        ? ''
        : t('executionRuns.details.labels.statusValue', { value: runStatus }));
    const runAnnouncementKey = stopError
        ? `stop-error:${stopError}`
        : interactionError
            ? `interaction-error:${interactionError}`
            : runStatus === null
                ? 'run:unavailable'
                : `run:${props.runId}:${runStatus}`;
    const fallbackReason = state.status === 'loaded' && state.source !== 'session_rpc'
        ? state.source === 'transcript_fallback'
            ? t('sessionPages.newRun.transcriptReadOnly')
            : t('sessionPages.newRun.daemonReadOnly')
        : null;
    const stopRun = React.useCallback(() => {
        if (isStopping) return;
        fireAndForget((async () => {
            setStopError(null);
            setStopUnconfirmed(false);
            setIsStopping(true);
            try {
                const result = props.serverId
                    ? await sessionExecutionRunStop(props.sessionId, { runId: props.runId }, { serverId: props.serverId })
                    : await sessionExecutionRunStop(props.sessionId, { runId: props.runId });
                if (result.ok === false) {
                    setStopError(String(result.error ?? t('runs.stop.failedToStopRun')));
                    if (isExecutionRunNotRunningMutationError(result)) {
                        await load();
                    } else {
                        // The machine did not confirm: offer the existing whole-session fallback.
                        setStopUnconfirmed(true);
                    }
                } else {
                    await load();
                }
            } catch (error) {
                setStopError(error instanceof Error ? error.message : t('runs.stop.failedToStopRun'));
                setStopUnconfirmed(true);
            } finally {
                setIsStopping(false);
            }
        })(), { tag: 'SessionExecutionRunDetailsView.stopRun' });
    }, [isStopping, load, props.runId, props.serverId, props.sessionId]);
    const onSessionStopped = React.useCallback(() => {
        setStopUnconfirmed(false);
        setStopError(null);
        void load();
    }, [load]);
    const machine = useExecutionRunMachineName(session?.metadata ?? null);
    // Show in transcript (⋯): the session transcript owns the jump; this surface only names the
    // Run's row. Offered where the transcript sits beside the Run (the Details tab); the phone
    // route has no reveal owner for it yet.
    const transcriptRouteMessageId = resolvedTranscriptMessageId ?? transcriptToolRouteId ?? null;
    const transcriptMessageSeq = typeof (transcriptMessage as { seq?: unknown } | null)?.seq === 'number'
        ? (transcriptMessage as { seq: number }).seq
        : null;
    const runTitle = state.status === 'loaded' ? resolveExecutionRunTitle(state.run) : null;
    const givenRunTitle = state.status === 'loaded' ? state.run.display?.title?.trim() || null : null;
    const onTitleResolved = props.onTitleResolved;
    React.useEffect(() => {
        if (!onTitleResolved || !runTitle) return;
        const current = props.openingTitle?.trim() ?? '';
        const next = givenRunTitle ?? (current.length === 0 || current.includes(props.runId) ? runTitle : null);
        if (next && next !== current) onTitleResolved(next);
    }, [givenRunTitle, onTitleResolved, props.openingTitle, props.runId, runTitle]);
    const showInTranscript = React.useMemo(() => {
        if (props.presentation !== 'panel' || !transcriptRouteMessageId || !runTitle) return null;
        const entry: TranscriptNavigationEntry = {
            id: `execution-run:${props.runId}`,
            sessionId: props.sessionId,
            seq: transcriptMessageSeq,
            routeMessageId: transcriptRouteMessageId,
            transcriptBlockIndex: null,
            kind: 'deep-link-target',
            role: 'tool',
            label: runTitle,
            promptPreview: null,
            responsePreview: null,
            createdAtMs: null,
            pinned: false,
            pinnedAtMs: null,
            loaded: true,
        };
        return () => {
            const handler = readTranscriptNavigationJumpHandler(props.sessionId);
            if (handler) {
                void handler(entry);
                return;
            }
            void awaitTranscriptNavigationJumpHandler(props.sessionId).then((published) => published?.(entry));
        };
    }, [props.presentation, props.runId, props.sessionId, runTitle, transcriptMessageSeq, transcriptRouteMessageId]);
    // ⋯ → Send to ⟨lead⟩: the finished result into the lead Session's composer (canonical handoff).
    const sendTemplate = useSetting('transcriptMessageSendToSessionTemplate');
    const leadServerId = explicitServerId ?? session?.serverId ?? null;
    const leadTitle = session ? getSessionName(session, leadServerId) : null;
    const presentation = props.presentation;
    const sendToSession = React.useMemo(() => (leadTitle && leadServerId ? {
        sessionTitle: leadTitle,
        onSend: (resultText: string) => {
            fireAndForget(sendExecutionRunResultToSession({
                sessionId: props.sessionId,
                serverId: leadServerId,
                resultText,
                runTitle,
                template: typeof sendTemplate === 'string' ? sendTemplate : '',
                appendDraft: async ({ sessionId, text, sourceSessionId }) => {
                    const result = await executeAction('session.draft.append', { sessionId, text, sourceSessionId });
                    if (!result.ok || !actionScopeIsCurrent()) return false;
                    const parsed = AppShellActionOutputSchemas['session.draft.append'].safeParse(result.result);
                    return parsed.success && parsed.data.status === 'appended';
                },
                // Beside the Session its composer is already on screen; the phone page returns to it.
                revealPrimaryComposer: presentation === 'panel'
                    ? () => undefined
                    : () => router.replace(buildScopedSessionRouteHref({ sessionId: props.sessionId, serverId: leadServerId })),
                focusPrimaryComposer: () => requestRegisteredSessionComposerFocus({ serverId: leadServerId, sessionId: props.sessionId }),
            }), { tag: 'SessionExecutionRunDetailsView.sendToSession' });
        },
    } : null), [actionScopeIsCurrent, executeAction, leadServerId, leadTitle, presentation, props.sessionId, router, runTitle, sendTemplate]);
    // The one composer here answers this agent, and says so (lab `convo-C1`).
    const replyAgentLabel = state.status === 'loaded' ? resolveExecutionRunBackendLabel(state.run.backendTarget, acpCatalogSnapshot) : null;
    const invokeInteraction = React.useCallback((kind: 'cancel_turn' | 'resume') => {
        if (pendingInteraction !== null) return;
        fireAndForget((async () => {
            setInteractionError(null);
            setPendingInteraction(kind);
            try {
                const result = kind === 'cancel_turn'
                    ? cancellableInputTurn
                        ? await executeAction('execution.run.cancel_turn', {
                            sessionId: props.sessionId,
                            runId: props.runId,
                            occurrenceId: cancellableInputTurn.occurrenceId,
                            turnId: cancellableInputTurn.turnId,
                        })
                        : { ok: false as const, error: t('runs.runDetails.controlFailed') }
                    : await executeAction('execution.run.ensure', { sessionId: props.sessionId, runId: props.runId, resume: true });
                if (!actionScopeIsCurrent()) return;
                if (result.ok === false) {
                    setInteractionError(String(result.error ?? t('runs.runDetails.controlFailed')));
                    if (isExecutionRunNotRunningMutationError(result)) await load();
                    return;
                }
                await load();
            } catch (error) {
                setInteractionError(error instanceof Error ? error.message : t('runs.runDetails.controlFailed'));
            } finally {
                setPendingInteraction(null);
            }
        })(), { tag: `SessionExecutionRunDetailsView.${kind}` });
    }, [actionScopeIsCurrent, cancellableInputTurn, executeAction, load, pendingInteraction, props.runId, props.sessionId]);

    const content = state.status === 'loading' ? (
        // A named wait (agents lab ST "opening"): what is opening and where it is read from. The
        // sized loading card narrates "Still waiting · N s" by itself once the wait runs long.
        <SurfaceStateCard
            testID="session-run-details-loading"
            kind="loading"
            title={t('surfaceState.opening', { name: props.openingTitle?.trim() || t('runPage.untitledRun') })}
            reason={t('runPage.opening.reading', { machine: machine.name })}
        />
    ) : state.status === 'gone' ? (
        <SurfaceStateCard
            testID="session-run-details-gone"
            kind="unavailable"
            iconName="robot"
            title={t('runPage.gone.title', { machine: machine.name })}
            reason={t('runPage.gone.reason')}
            action={props.onRequestClose
                ? { label: t('runPage.gone.closeTab'), onPress: props.onRequestClose }
                : { label: t('surfaceState.checkAgain'), onPress: () => load() }}
            secondaryAction={props.onRequestClose ? { label: t('surfaceState.checkAgain'), onPress: () => load() } : undefined}
            diagnosticCode="execution_run_not_found"
        />
    ) : state.status === 'error' ? (
        // The mobile route carries a header Refresh over this same view's `reload`
        // handle; the desktop workspace and the subagent panel have no header, so
        // the card's Try again is the in-place recovery. It calls the one existing
        // loader, which re-enters the loading state above — no reconnect
        // subscription, retry timer or second load owner. The failure text may be
        // transport vocabulary, so it is the diagnostic behind Details.
        <SurfaceStateCard
            testID="session-run-details-load-error"
            kind="error"
            title={t('runs.runDetails.failedToLoad')}
            diagnosticCode={state.error === t('runs.runDetails.failedToLoad') ? null : state.error}
            action={{ label: t('surfaceState.tryAgain'), onPress: () => load() }}
        />
    ) : (
        <View style={{ flex: 1, minHeight: 0 }}>
                {props.showInfoCard === false ? null : (
                    <SessionExecutionRunInfoCard
                        run={state.run}
                        acpCatalogSnapshot={acpCatalogSnapshot}
                        hostSessionId={props.sessionId}
                        daemonProcessLine={daemonProcessLine}
                        originTitle={discussionOriginTitle}
                        attention={runAttention}
                        stopAction={canMutateRunViaSessionRpc && state.run.status === 'running'
                            ? { stopping: isStopping, onStop: stopRun }
                            : null}
                        cancelResponseAction={canMutateRunViaSessionRpc && interactionAffordances.canCancelTurn && cancellableInputTurn
                            ? { pending: pendingInteraction !== null, onCancel: () => invokeInteraction('cancel_turn') }
                            : null}
                        copyResultText={copyResultText}
                        onShowInTranscript={showInTranscript}
                        sendToSession={sendToSession}
                    />
                )}
            <View style={{ flex: 1, minHeight: 0, paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}>
            <View style={{ gap: 8 }}>
                {discussionOrigin ? (
                    <ExecutionRunContextChip
                        testID="session-run-details-context"
                        title={discussionOriginTitle}
                        messageCount={discussionOrigin.messageCount}
                    />
                ) : null}
                {fallbackReason ? (
                    <Text testID="session-run-details-read-only-reason" style={{ color: theme.colors.text.secondary }}>
                        {fallbackReason}
                    </Text>
                ) : null}
                {showPreMarkerState ? (
                    <View
                        testID="session-run-details-pre-marker-state"
                        accessibilityRole="text"
                        style={{ paddingVertical: 4 }}
                    >
                        <Text style={{ color: theme.colors.text.secondary }}>
                            {t('status.awaitingUpdates')}
                        </Text>
                    </View>
                ) : null}
                {!transcriptMessage && transcriptToolRouteId ? (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('toolView.open')}
                        testID="session-run-details-open-tool-message"
                        onPress={() => {
                            navigateWithBlurOnWeb(() => {
                                router.push(buildScopedSessionRouteHref({
                                    sessionId: props.sessionId,
                                    serverId: props.serverId ?? session?.serverId,
                                    suffix: `/message/${encodeURIComponent(transcriptToolRouteId)}`,
                                }));
                            });
                        }}
                        style={{
                            ...interactiveTargetStyle,
                            alignSelf: 'flex-start',
                            paddingVertical: 8,
                            paddingHorizontal: 10,
                            borderRadius: 10,
                            backgroundColor: theme.colors.surface.inset,
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                        }}
                    >
                        <Text style={{ color: theme.colors.text.primary, fontWeight: '600' }}>{t('toolView.open')}</Text>
                    </Pressable>
                ) : null}
            </View>

            {approval.approvalPending && approval.approvalId && pendingOutboxScope ? (
                <ActionApprovalPendingNotice
                    message={t('approvals.title')}
                    onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(pendingOutboxScope.serverId)}`)}
                />
            ) : null}
            {stopUnconfirmed ? (
                <ExecutionRunStopFailedState
                    sessionId={props.sessionId}
                    serverId={explicitServerId ?? session?.serverId ?? null}
                    intent={state.run.intent}
                    machineId={machine.machineId}
                    machineName={machine.name}
                    diagnostic={stopError}
                    onRetry={stopRun}
                    onSessionStopped={onSessionStopped}
                />
            ) : null}

            {structuredCard ? (
                <View style={{ flex: 1, minHeight: 0 }}>
                    {structuredCard}
                </View>
            ) : hasStructuredResult ? stepsRow : null}

            {canMutateRunViaSessionRpc && (state.run.status === 'running' || interactionAffordances.canResume) ? (
                <View style={{ gap: 8 }}>
                    {stopError && !stopUnconfirmed ? <Text style={{ color: theme.colors.text.secondary }}>{stopError}</Text> : null}
                    {interactionError ? <Text style={{ color: theme.colors.text.secondary }}>{interactionError}</Text> : null}
                    {interactionAffordances.canResume ? (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('runs.runDetails.resumeRun')}
                            accessibilityState={{
                                disabled: pendingInteraction !== null,
                                busy: pendingInteraction === 'resume',
                            }}
                            testID="session-run-details-resume"
                            disabled={pendingInteraction !== null}
                            onPress={() => invokeInteraction('resume')}
                            style={{
                                ...interactiveTargetStyle,
                                paddingVertical: 10,
                                paddingHorizontal: 12,
                                borderRadius: 10,
                                backgroundColor: theme.colors.surface.inset,
                                borderWidth: 1,
                                borderColor: theme.colors.border.default,
                                opacity: pendingInteraction !== null ? 0.6 : 1,
                            }}
                        >
                            <Text style={{ color: theme.colors.text.primary, fontWeight: '600' }}>
                                {t('runs.runDetails.resumeRun')}
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}

            <PoliteAccessibilityStatus
                statusTestID="session-run-details-accessibility-status"
                transitionKey={runAnnouncementKey}
                announcement={runAnnouncement}
            />

            {/* Presence, not truthiness: a valid run result may be false, 0,
                empty string, or null; only absence (undefined) hides the card.
                The result is presented through the transcript's own structured
                projection; the exact payload a plugin returned stays reachable
                under its own disclosure rather than being the primary content. */}
            {state.latestToolResult !== undefined && !hasStructuredResult ? (
                <View
                    testID="session-run-details-latest-tool-result"
                    style={{
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: theme.colors.surface.inset,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        gap: 6,
                    }}
                >
                    <Text style={{ color: theme.colors.text.primary, fontWeight: '600' }}>{t('runs.runDetails.latestToolResultTitle')}</Text>
                    {latestToolResultProjection ? (
                        <StructuredResultView
                            tool={latestToolResultProjection}
                            metadata={null}
                            messages={NO_TRANSCRIPT_MESSAGES}
                        />
                    ) : null}
                    <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: rawToolResultExpanded }}
                        testID="session-run-details-latest-tool-result-raw-toggle"
                        onPress={() => setRawToolResultExpanded((current) => !current)}
                        style={{ ...interactiveTargetStyle, alignSelf: 'flex-start' }}
                    >
                        <Text style={{ color: theme.colors.text.secondary }}>{t('runs.runDetails.latestToolResultRaw')}</Text>
                    </Pressable>
                    {rawToolResultExpanded ? (
                        <Text
                            testID="session-run-details-latest-tool-result-raw"
                            style={{ color: theme.colors.text.secondary, fontFamily: 'Menlo' }}
                        >
                            {JSON.stringify(state.latestToolResult, null, 2)}
                        </Text>
                    ) : null}
                </View>
            ) : null}

            {/* Exactly one composer on this surface. The canonical message details host
                owns the run's sidechain, its exact-target pending rows and the standard
                Agent composer; this view decides only whether the run's own interaction
                projection permits one. The plain `TextInput` that used to sit here was a
                second composer with its own send state and its own direct runtime call. */}
            {session && !structuredCard && transcriptMessage?.kind === 'tool-call' ? (
                <SessionMessageDetailsView
                    sessionId={props.sessionId}
                    session={session}
                    message={transcriptMessage}
                    showComposer={canShowSendComposer}
                    recipientOverride={executionRunRecipient}
                    composerInitialLocalId={props.retryInputLocalId}
                    browserContextState={browserContextRuntime?.composerContext.state ?? null}
                />
            ) : null}
            {session && !structuredCard && transcriptMessage?.kind !== 'tool-call' ? (
                <View style={{ gap: 10 }}>
                    {transcriptToolId !== null ? (
                        // Same container the marker branch gives its transcript
                        // (`SessionMessageDetailsView`'s `toolCallFullViewContainer`), so the
                        // shared list is measured identically on both paths.
                        <View style={{ flex: 1, minHeight: 0 }}>
                            <ChainTranscriptList
                                key={runTranscriptDatasetKey}
                                sessionId={props.sessionId}
                                serverId={pendingScopeServerId ?? null}
                                datasetKey={runTranscriptDatasetKey}
                                messages={runTranscriptMessages}
                                metadata={session.metadata ?? null}
                                interaction={interaction}
                                isInitialLoadInFlight={isRunSidechainHydrating}
                                loadOlder={loadOlderRunSidechain}
                                pendingMessages={targetPending.messages}
                                discardedMessages={targetPending.discarded}
                                pendingRecipient={executionRunRecipient}
                                messageWrapperTestIdPrefix="session-run-details-transcript-message"
                            />
                        </View>
                    ) : (targetPending.messages.length > 0 || targetPending.discarded.length > 0) ? (
                        // Only reachable before the Run resolves (no sidechain id yet): the queued
                        // rows still belong on screen, and the list above owns them from then on.
                        <PendingMessagesTranscriptBlock
                            sessionId={props.sessionId}
                            serverId={pendingScopeServerId ?? null}
                            recipient={executionRunRecipient}
                            pendingMessages={targetPending.messages}
                            discardedMessages={targetPending.discarded}
                        />
                    ) : null}
                    {canShowSendComposer ? (
                        <SessionParticipantComposer
                            key={JSON.stringify([
                                props.serverId ?? session.serverId ?? '',
                                props.sessionId,
                                executionRunRecipient.runId,
                                props.retryInputLocalId ?? '',
                            ])}
                            sessionId={props.sessionId}
                            serverId={props.serverId ?? session.serverId}
                            canSendMessages={interaction.canSendMessages}
                            recipient={executionRunRecipient}
                            executionRunRequestedAction={executionRunRecipientState.executionRunRequestedAction}
                            extraActionChips={executionRunRoutingControls.extraActionChips}
                            initialLocalId={props.retryInputLocalId}
                            browserContextState={browserContextRuntime?.composerContext.state ?? null}
                            {...(replyAgentLabel ? { placeholder: t('agentStart.pane.replyTo', { agent: replyAgentLabel }) } : {})}
                        />
                    ) : null}
                    {canShowSendComposer && leadTitle ? (
                        <Text testID="session-run-details-replies-foot" style={{ color: theme.colors.text.secondary, fontSize: 12 }}>
                            {t('agentStart.pane.repliesGoTo', { session: leadTitle })}
                        </Text>
                    ) : null}
                </View>
            ) : null}
            </View>
        </View>
    );

    if (props.presentation === 'panel') {
        return <View style={{ flex: 1 }}>{content}</View>;
    }

    return (
        <ConstrainedScreenContent style={{ flex: 1 }}>
            {content}
        </ConstrainedScreenContent>
    );
});
