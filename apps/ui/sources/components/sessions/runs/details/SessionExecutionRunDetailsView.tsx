import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ExecutionRunGetResponseSchema, isExecutionRunActive } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useUnistyles } from 'react-native-unistyles';

import {
    isExecutionRunNotRunningMutationError,
    isExecutionRunMutationCancelled,
    sessionExecutionRunGet,
} from '@/sync/ops/sessionExecutionRuns';
import {
    useMessage,
    useResolvedSessionMessageRouteId,
    useSessionMessages,
    useSessionPendingMessages,
    useSessionSidechainMessages,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { readExecutionRunAgentActivityStatus, resolveAgentActivityStatusPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { SessionRunWorkNotifications } from '@/components/sessions/work/RunWorkNotifications';
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
import { SessionParticipantComposer, type ParticipantComposerPreparedSubmission } from '@/components/sessions/participants/composer/SessionParticipantComposer';
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
import { useDiscussionTitles } from '@/components/discussions/useDiscussionTitles';
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
import { SessionTranscriptSourceProvider, useOptionalSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { requestRegisteredSessionComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useSetting } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { sendExecutionRunResultToSession } from './sendExecutionRunResultToSession';
import { resolveExecutionRunVisibleMessages } from '@/sync/domains/session/subagents/visibleMessages/resolveSessionSubagentVisibleMessages';
import { readExecutionRunModelId } from '@/components/sessions/runs/resolveExecutionRunSelectionLabel';
import { useRunAnsweringEngine } from '@/components/sessions/runs/useRunAnsweringEngine';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { createScmDiffSummaryResultOperations } from '@/sync/ops/scmDiffSummary/results';
import { hasBrowserContextComposerAttachments } from '@/sync/domains/session/input/browserContext';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useSessionRealtimeTranscriptConsumer } from '@/hooks/session/useSessionRealtimeTranscriptConsumer';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { presentExecutionRunFailure, presentExecutionRunResultFailure } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { confirmSessionDelete } from '@/components/sessions/actions/confirmSessionDelete';
import { Modal } from '@/modal';

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
    sessionId: string | null;
    /** Existing Runs need their Machine address; daemon inventory does not carry a working directory. */
    workspace?: Readonly<{ machineId: string; cwd?: string }>;
    runId: string;
    serverId?: string | null;
    presentation?: 'screen' | 'panel';
    showInfoCard?: boolean;
    showSendComposer?: boolean;
    retryInputLocalId?: string;
    initialText?: string;
    /** The name the opener already knows (the tab's title), so the wait says what is opening. */
    openingTitle?: string | null;
    reviewersNotStarted?: readonly string[];
    narrationError?: string | null;
    /** Closes the hosting dialog or Details tab when leaving this Run for recovery. */
    onRequestClose?: () => void;
    /** The opener found the Run's Session removed: a missing Run went with it, rather than being pruned. */
    sessionRemoved?: boolean;
    /**
     * Hands the host a better name for this Run once it is known: the title the Run was given, or
     * its intent where the opener only had its id (a tab restored from before titles existed).
     */
    onTitleResolved?: (title: string) => void;
}>;

export const SessionExecutionRunDetailsView = React.memo(React.forwardRef<SessionExecutionRunDetailsViewHandle, SessionExecutionRunDetailsViewProps>((props, ref) => {
    // Explicit absence also masks a surrounding Session pane's transcript authority.
    return props.sessionId === null ? <SessionTranscriptSourceProvider source={null}>
        <SessionExecutionRunDetailsContent {...props} ref={ref} />
    </SessionTranscriptSourceProvider> : <AppSessionTranscriptSourceProvider sessionId={props.sessionId} serverId={props.serverId}>
        <SessionExecutionRunDetailsContent {...props} ref={ref} />
    </AppSessionTranscriptSourceProvider>;
}));

const SessionExecutionRunDetailsContent = React.forwardRef<SessionExecutionRunDetailsViewHandle, SessionExecutionRunDetailsViewProps>((props, ref) => {
    const source = useOptionalSessionTranscriptSource();
    const { theme } = useUnistyles();
    const router = useRouter();
    const explicitServerId = props.serverId?.trim() || null;
    const storedSession = useSessionViewShellSession(props.sessionId ?? '', explicitServerId);
    const session = props.sessionId === null ? null : storedSession;
    const hasQualifiedSession = props.sessionId === null ? props.workspace !== undefined : explicitServerId === null || session !== null;
    const pendingScopeServerId = explicitServerId ?? session?.serverId;
    const presented = useLayoutPresentationActive();
    useSessionRealtimeTranscriptConsumer(presented && hasQualifiedSession ? props.sessionId : null, pendingScopeServerId);
    const pendingScopeResolution = useServerCredentialAccountScopeResolution(pendingScopeServerId);
    const pendingOutboxScope = pendingScopeResolution.kind === 'bound' ? pendingScopeResolution.scope : null;
    const { execute: executeAction, isCurrent: actionScopeIsCurrent, approval } = useMountedActionExecution(pendingOutboxScope);
    const runOperation = React.useMemo(() => props.sessionId === null && props.workspace ? {
        executionRunTargetMachineId: props.workspace.machineId,
        externalActionTarget: { kind: 'machine' as const, machineId: props.workspace.machineId },
    } : {}, [props.sessionId, props.workspace?.machineId]);
    const [state, setState] = React.useState<LoadState>({ status: 'loading' });
    const [daemonProcessLine, setDaemonProcessLine] = React.useState<string | null>(null);
    const [stopError, setStopError] = React.useState<string | null>(null);
    /** The Run's machine did not confirm a stop: the whole-session fallback is on offer. */
    const [stopUnconfirmed, setStopUnconfirmed] = React.useState(false);
    const [isStopping, setIsStopping] = React.useState(false);
    const [isDeleting, setIsDeleting] = React.useState(false);
    const [interactionError, setInteractionError] = React.useState<string | null>(null);
    const [pendingInteraction, setPendingInteraction] = React.useState<'cancel_turn' | 'resume' | null>(null);
    const [rawToolResultExpanded, setRawToolResultExpanded] = React.useState(false);
    const { messages: sessionMessages, isLoaded: sessionMessagesLoaded } = useSessionMessages(
        props.sessionId ?? '',
        { enabled: props.sessionId !== null && hasQualifiedSession },
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
    // Only a workspace-owned Run reads through the Account-scoped Action executor; a Session Run's
    // address does not change when that Account scope finishes resolving.
    const workspaceRunExecuteAction = props.sessionId === null ? executeAction : null;
    const runAddressKey = JSON.stringify([explicitServerId, props.sessionId === null ? pendingOutboxScope?.accountId : null, props.sessionId,
        props.workspace?.machineId, props.workspace?.cwd, props.runId]);
    const loadedRunAddressRef = React.useRef<string | null>(null);
    // Request currentness: concurrent loads (route effect, bus notification,
    // interaction, header Refresh) settle in arbitrary order, so only the newest
    // request may write state. Without this an older response overwrites a newer
    // one and the surface silently shows a superseded Run.
    const loadGenerationRef = React.useRef(0);
    const loadControllerRef = React.useRef<AbortController | null>(null);

    const load = React.useCallback(async () => {
        loadControllerRef.current?.abort();
        const controller = new AbortController();
        loadControllerRef.current = controller;
        const generation = loadGenerationRef.current + 1;
        loadGenerationRef.current = generation;
        const isCurrentRequest = () => !controller.signal.aborted && loadGenerationRef.current === generation;
        if ((props.sessionId === null ? !props.workspace : !props.sessionId) || !props.runId) {
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
        const rpcOptions = { ...(explicitServerId ? { serverId: explicitServerId } : {}), signal: controller.signal };
        const getRun = async (request: Readonly<{ runId: string; includeStructured: true; waitForInputId?: string }>) => {
            if (props.sessionId !== null) return sessionExecutionRunGet(props.sessionId, request, rpcOptions);
            try {
                if (!workspaceRunExecuteAction) throw new Error(t('runs.runDetails.failedToLoad'));
                const result = await workspaceRunExecuteAction('execution.run.get', { sessionId: null, ...request }, { ...runOperation, signal: controller.signal });
                if (!result.ok) return result;
                const parsed = ExecutionRunGetResponseSchema.safeParse(result.result);
                return parsed.success ? { ok: true as const, ...parsed.data }
                    : { ok: false as const, error: t('runs.runDetails.failedToLoad'), errorCode: 'execution_run_invalid_response' };
            } catch (error) {
                return { ok: false as const, error: error instanceof Error ? error.message : t('runs.runDetails.failedToLoad'),
                    errorCode: 'execution_run_target_unavailable' };
            }
        };
        if (loadedRunAddressRef.current !== runAddressKey) {
            setState({ status: 'loading' });
            setDaemonProcessLine(null);
        }
        // Work and Details read the same retained transcript index. A terminal Run
        // remains readable after its parent stops, without contacting that runner.
        if (props.sessionId !== null && session?.active === false && transcriptFallback
            && transcriptFallback.run.status !== 'running') {
            loadedRunAddressRef.current = runAddressKey;
            setState({ status: 'loaded', ...transcriptFallback, source: 'transcript_fallback' });
            return;
        }
        const first = await getRun({ runId: props.runId, includeStructured: true });
        if (!isCurrentRequest()) return;
        const result =
            first.ok === false && isSessionEncryptionNotFoundError(first)
                ? await getRun({ runId: props.runId, includeStructured: true })
                : first;
        if (!isCurrentRequest()) return;
        if (result.ok === false) {
            if (props.sessionId === null) {
                loadedRunAddressRef.current = null;
                setState(result.errorCode === 'execution_run_not_found' ? { status: 'gone' }
                    : { status: 'error', error: String(result.error ?? t('runs.runDetails.failedToLoad')) });
                return;
            }
            if (result.errorCode === 'execution_run_not_found' && !sessionMessagesLoaded) {
                await source?.history.loadOlder?.().catch(() => null);
                if (!isCurrentRequest()) return;
            }
            const daemonFallback = await resolveDaemonExecutionRunFallback({
                sessionId: props.sessionId,
                serverId: explicitServerId,
                runId: props.runId,
                transcriptFallback,
                signal: controller.signal,
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
        if (props.sessionId === null) {
            const currentInput = run.inputTurns?.current;
            const inputId = currentInput?.state === 'active' ? currentInput.inputIds[0] : undefined;
            if (inputId) {
                const completed = await getRun({ runId: props.runId, includeStructured: true, waitForInputId: inputId });
                if (isCurrentRequest() && completed.ok && 'run' in completed) setState({ status: 'loaded', run: completed.run,
                    latestToolResult: completed.latestToolResult, structuredMeta: completed.structuredMeta, source: 'session_rpc' });
                else if (isCurrentRequest() && !completed.ok) setInteractionError(
                    typeof completed.error === 'string' && completed.error.trim() ? completed.error : t('runs.runDetails.failedToLoad'));
            }
            return;
        }
        const daemonFallback = await resolveDaemonExecutionRunFallback({
            sessionId: props.sessionId,
            serverId: explicitServerId,
            runId: props.runId,
            signal: controller.signal,
            transcriptFallback: transcriptFallback ?? {
                run,
                latestToolResult: result.latestToolResult,
            },
        }).catch(() => null);
        if (!isCurrentRequest()) return;
        if (daemonFallback?.daemonProcessLine) {
            setDaemonProcessLine(daemonFallback.daemonProcessLine);
        }
    }, [workspaceRunExecuteAction, runOperation, explicitServerId, hasQualifiedSession, props.runId, props.sessionId, props.workspace?.machineId, props.workspace?.cwd, runAddressKey, session?.active, sessionMessagesLoaded, source, transcriptFallback]);

    React.useEffect(() => {
        void load();
        return () => loadControllerRef.current?.abort();
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
        if (!hasQualifiedSession || !runActivityServerId || props.sessionId === null) return;
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
    const { snapshot: acpCatalog } = useAcpCatalog(pendingOutboxScope);
    const acpCatalogSnapshot = acpCatalog?.catalog.status === 'ready' && !acpCatalog.stale ? acpCatalog.catalog : undefined;
    const interaction = source ? source.useInteraction() : deriveTranscriptInteraction({ kind: 'public' });
    const resolvedTranscriptMessageId = useResolvedSessionMessageRouteId(props.sessionId ?? '', transcriptToolRouteId ?? '');
    const transcriptMessageFromStore = useMessage(props.sessionId ?? '', resolvedTranscriptMessageId ?? transcriptToolRouteId ?? '');
    const transcriptMessage = transcriptMessageFromStore ?? transcriptFallback?.message ?? null;
    const executionRunRecipient = React.useMemo(() => ({
        kind: 'execution_run' as const,
        runId: props.runId,
    }), [props.runId]);
    const targetPending = useSessionPendingMessages(props.sessionId ?? '', executionRunRecipient);
    // The direct Run composer mounts before any transcript tool marker exists, so it composes the
    // same recipient/routing controls the tool-marker branch reaches through
    // `SessionMessageDetailsView`: one canonical send-mode control, no silent default.
    // "To:" names the Run by what it is for (the canonical Run title owner), never by its id.
    const recipientTitle = state.status === 'loaded' ? resolveExecutionRunTitle(state.run, 'recipient') : null;
    const recipientRunIntent = state.status === 'loaded' ? state.run.intent : undefined;
    const executionRunParticipantTargets = React.useMemo<readonly SessionParticipantTarget[]>(() => {
        const displayLabel = recipientTitle ?? t('session.participants.executionRun', { runId: executionRunRecipient.runId });
        return [{
            key: `execution_run:${executionRunRecipient.runId}`,
            displayLabel,
            recipient: { ...executionRunRecipient, label: displayLabel },
            ...(recipientRunIntent ? { runIntent: recipientRunIntent } : {}),
        }];
    }, [executionRunRecipient, recipientRunIntent, recipientTitle]);
    const executionRunRecipientState = useSessionRecipientState({
        targets: executionRunParticipantTargets,
        autoRecipient: executionRunParticipantTargets[0]!.recipient,
    });
    const walkthroughConversation = state.status === 'loaded' && state.run.intent === 'scm_diff_summary';
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
        enabled: props.sessionId !== null && transcriptToolId !== null,
        sessionId: props.sessionId ?? '',
        sidechainIds: transcriptSidechainIds,
    });
    // A Run whose profile materializes nothing in the parent transcript never
    // gets a tool marker, so `SessionMessageDetailsView` — which is keyed on that
    // marker — can never host its transcript. The committed rows still exist under
    // the Run's own sidechain, so this branch reads the same sync-owned sidechain
    // projection and renders them through the same shared list, including the
    // pending-to-committed crossover for this exact target.
    const runSidechainMessages = useSessionSidechainMessages(props.sessionId ?? '', props.sessionId === null ? null : transcriptToolId);
    const runTranscriptMessages = React.useMemo(() => [...resolveExecutionRunVisibleMessages({
        runId: props.runId, messages: sessionMessages, focusedMessages: runSidechainMessages,
    })], [props.runId, sessionMessages, runSidechainMessages]);
    // The Run can be admitted before its transcript marker is materialized. Keep
    // this brief state visible until the canonical sidechain/pending projections
    // provide content; do not infer a timer, queue, or producer-owned lifecycle.
    const showPreMarkerState = props.sessionId !== null && state.status === 'loaded'
        && state.run.status === 'running'
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
        () => createAppSidechainHistoryLoader(props.sessionId ?? '', props.sessionId === null ? null : transcriptToolId),
        [props.sessionId, transcriptToolId],
    );
    const isRunSidechainHydrating = runTranscriptMessages.length === 0
        && isSidechainHydrationPendingStatus(
            transcriptToolId ? sidechainHydration.bySidechainId[transcriptToolId]?.status : undefined,
        );

    React.useEffect(() => {
        if (!hasQualifiedSession || props.sessionId === null) return;
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
        if (state.status !== 'loaded') return null;
        const meta = state.structuredMeta;
        const result = state.latestToolResult === undefined && props.sessionId === null
            && meta !== null && typeof meta === 'object' && 'payload' in meta ? meta.payload : state.latestToolResult;
        const failure = state.run.status === 'failed' ? state.run.error : undefined;
        if (result === undefined && !failure) return null;
        return {
            name: 'SubAgentRun',
            state: 'completed',
            input: { runId: state.run.runId },
            createdAt: 0,
            startedAt: null,
            completedAt: null,
            description: null,
            result: failure ? { status: 'failed', runId: state.run.runId, error: failure } : result,
        };
    }, [state, props.sessionId]);

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
    // Only a kind with a result page leads with it; any other structured meta (a walkthrough's saved
    // publication) leaves the conversation as the page, with no steps disclosure that hides nothing.
    const resultPage = props.sessionId !== null && structuredMeta
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
    const structuredCard = showSteps ? null : resultPage;
    const hasStructuredResult = resultPage !== null;
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
    // body's context chip. Its source is qualified by the captured Home.
    const discussionOrigin = state.status === 'loaded' ? readRunDiscussionOrigin(state.run.launchOrigin, explicitServerId ?? session?.serverId) : null;
    const discussionOriginAddress = React.useMemo(
        () => discussionOrigin ? { serverId: discussionOrigin.serverId } : null,
        [discussionOrigin?.serverId],
    );
    const discussionOriginIds = React.useMemo(
        () => discussionOrigin ? [discussionOrigin.discussionId] : NO_DISCUSSION_IDS,
        [discussionOrigin?.discussionId],
    );
    const discussionTitles = useDiscussionTitles({
        address: discussionOrigin ? discussionOriginAddress : null,
        discussionIds: discussionOriginIds,
    });
    const discussionOriginTitle = discussionOrigin ? discussionTitles.get(discussionOrigin.discussionId) ?? null : null;
    // Whether the Run waits on a person: the roster's canonical attention (the enriched roster is the
    // only owner that observes pending prompts), read into the same words the roster row uses.
    const roster = useSessionAgentActivityRoster({
        sessionId: props.sessionId ?? '',
        serverId: explicitServerId ?? session?.serverId ?? undefined,
        session,
    });
    const rosterRunEntry = roster.readExecutionRunEntry(props.runId);
    const runAttention = React.useMemo(
        () => rosterRunEntry ? resolveSessionAgentActivityPresentation({ entry: rosterRunEntry }).attention : null,
        [rosterRunEntry],
    );
    const machine = useExecutionRunMachineName(session, pendingScopeServerId, props.workspace?.machineId);
    const presence = useMachinePresenceSummary(pendingScopeServerId, machine.machineId);
    const machineReachable = presence.reachability === 'unknown' ? undefined : presence.reachability === 'reachable';
    const runStatus = state.status === 'loaded' ? resolveAgentActivityStatusPresentation(
        readExecutionRunAgentActivityStatus(state.run.status), isExecutionRunActive(state.run), machineReachable).label : null;
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
            setInteractionError(null);
            setStopUnconfirmed(false);
            setIsStopping(true);
            let transportIssued = false;
            try {
                const result = await executeAction('execution.run.stop', { sessionId: props.sessionId, runId: props.runId }, {
                    ...runOperation,
                    onTransportIssued: () => { transportIssued = true; },
                });
                if (!actionScopeIsCurrent() || isExecutionRunMutationCancelled(result)) return;
                if (result.ok === false) {
                    setStopError(String(result.error ?? t('runs.stop.failedToStopRun')));
                    if (!transportIssued) setInteractionError(String(result.error ?? t('runs.stop.failedToStopRun')));
                    if (isExecutionRunNotRunningMutationError(result)) {
                        await load();
                    } else {
                        // The machine did not confirm: offer the existing whole-session fallback.
                        setStopUnconfirmed(props.sessionId !== null && transportIssued);
                    }
                } else {
                    await load();
                }
            } catch (error) {
                if (!actionScopeIsCurrent() || isExecutionRunMutationCancelled(error)) return;
                setStopError(error instanceof Error ? error.message : t('runs.stop.failedToStopRun'));
                if (!transportIssued) setInteractionError(error instanceof Error ? error.message : t('runs.stop.failedToStopRun'));
                setStopUnconfirmed(props.sessionId !== null && transportIssued);
            } finally {
                setIsStopping(false);
            }
        })(), { tag: 'SessionExecutionRunDetailsView.stopRun' });
    }, [actionScopeIsCurrent, executeAction, runOperation, isStopping, load, props.runId, props.sessionId]);
    const deleteRun = React.useCallback(() => {
        const machineId = props.workspace?.machineId;
        if (isDeleting || !machineId) return;
        fireAndForget((async () => {
            setIsDeleting(true);
            try {
                if (!await confirmSessionDelete({ detachedHistory: true }) || !actionScopeIsCurrent()) return;
                const result = await executeAction('session.delete', { machineId, runId: props.runId }, { ...runOperation, confirmed: true });
                if (!actionScopeIsCurrent() || isExecutionRunMutationCancelled(result)) return;
                if (!result.ok) {
                    Modal.alert(t('common.error'), result.error || t('sessionInfo.failedToDeleteSession'));
                    return;
                }
                await load();
            } catch (error) {
                if (!actionScopeIsCurrent() || isExecutionRunMutationCancelled(error)) return;
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('sessionInfo.failedToDeleteSession'));
            } finally {
                setIsDeleting(false);
            }
        })(), { tag: 'SessionExecutionRunDetailsView.deleteRun' });
    }, [actionScopeIsCurrent, executeAction, isDeleting, load, props.runId, props.workspace?.machineId, runOperation]);
    const onSessionStopped = React.useCallback(() => {
        setStopUnconfirmed(false);
        setStopError(null);
        void load();
    }, [load]);
    const modelRun = state.status === 'loaded' && loadedRunAddressRef.current === runAddressKey ? state.run : null;
    const { engine: answeringEngine, sessionModels, catalogProfiles: nativeModelCatalog } = useRunAnsweringEngine({
        backendTarget: modelRun?.backendTarget, modelId: modelRun ? readExecutionRunModelId(modelRun) : null,
        selection: modelRun?.resolvedSelection, sessionId: props.sessionId, serverId: pendingScopeServerId,
        machineId: props.workspace?.machineId, cwd: props.workspace?.cwd, presented: props.showInfoCard !== false,
    });
    // Show in transcript (⋯): the session transcript owns the jump; this surface only names the
    // Run's row. Offered where the transcript sits beside the Run (the Details tab); the phone
    // route has no reveal owner for it yet.
    const transcriptRouteMessageId = resolvedTranscriptMessageId ?? transcriptToolRouteId ?? null;
    const transcriptMessageSeq = typeof (transcriptMessage as { seq?: unknown } | null)?.seq === 'number'
        ? (transcriptMessage as { seq: number }).seq
        : null;
    const runTitle = state.status === 'loaded' && loadedRunAddressRef.current === runAddressKey
        ? resolveExecutionRunTitle(state.run, 'conversation') : null;
    useDestinationPageTitle(props.presentation === 'screen' ? runTitle : undefined);
    const givenRunTitle = state.status === 'loaded'
        ? state.run.intent === 'scm_diff_summary' ? runTitle : state.run.display?.title?.trim() || null : null;
    const onTitleResolved = props.onTitleResolved;
    React.useEffect(() => {
        if (!onTitleResolved || !runTitle) return;
        const current = props.openingTitle?.trim() ?? '';
        const next = givenRunTitle ?? (current.length === 0 || current.includes(props.runId) ? runTitle : null);
        if (next && next !== current) onTitleResolved(next);
    }, [givenRunTitle, onTitleResolved, props.openingTitle, props.runId, runTitle]);
    const showInTranscript = React.useMemo(() => {
        const sessionId = props.sessionId;
        if (sessionId === null || props.presentation !== 'panel' || !transcriptRouteMessageId || !runTitle) return null;
        const entry: TranscriptNavigationEntry = {
            id: `execution-run:${props.runId}`,
            sessionId,
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
            const handler = readTranscriptNavigationJumpHandler(sessionId);
            if (handler) {
                void handler(entry);
                return;
            }
            void awaitTranscriptNavigationJumpHandler(sessionId).then((published) => published?.(entry));
        };
    }, [props.presentation, props.runId, props.sessionId, runTitle, transcriptMessageSeq, transcriptRouteMessageId]);
    // ⋯ → Send to ⟨lead⟩: the finished result into the lead Session's composer (canonical handoff).
    const sendTemplate = useSetting('transcriptMessageSendToSessionTemplate');
    const leadServerId = explicitServerId ?? session?.serverId ?? null;
    const leadTitle = session ? getSessionName(session, leadServerId) : null;
    const presentation = props.presentation;
    const leadSessionId = props.sessionId;
    const sendToSession = React.useMemo(() => (leadSessionId !== null && leadTitle && leadServerId ? {
        sessionTitle: leadTitle,
        onSend: (resultText: string) => {
            fireAndForget(sendExecutionRunResultToSession({
                sessionId: leadSessionId,
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
                    : () => router.replace(buildScopedSessionRouteHref({ sessionId: leadSessionId, serverId: leadServerId })),
                focusPrimaryComposer: () => requestRegisteredSessionComposerFocus({ serverId: leadServerId, sessionId: leadSessionId }),
            }), { tag: 'SessionExecutionRunDetailsView.sendToSession' });
        },
    } : null), [actionScopeIsCurrent, executeAction, leadServerId, leadTitle, presentation, leadSessionId, router, runTitle, sendTemplate]);
    // The one composer here answers this agent, and says so (lab `convo-C1`).
    // The composer invites a reply to who it talks to: a walkthrough conversation's recipient ("Walkthrough"),
    // else the Run's agent. Both entrances (pre-marker and tool-marker) use the same words.
    const replyAgentLabel = state.status === 'loaded'
        ? state.run.intent === 'scm_diff_summary' ? recipientTitle : resolveExecutionRunBackendLabel(state.run.backendTarget, acpCatalogSnapshot)
        : null;
    const replyPlaceholder = replyAgentLabel ? t('agentStart.pane.replyTo', { agent: replyAgentLabel }) : undefined;
    // A walkthrough conversation answers with the model that wrote it, named as the header names it (lab WT3-D3).
    const walkthroughEngine = walkthroughConversation ? answeringEngine : undefined;
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
                        }, runOperation)
                        : { ok: false as const, error: t('runs.runDetails.controlFailed') }
                    : await executeAction('execution.run.ensure', { sessionId: props.sessionId, runId: props.runId, resume: true }, runOperation);
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
    }, [actionScopeIsCurrent, cancellableInputTurn, executeAction, runOperation, load, pendingInteraction, props.runId, props.sessionId]);
    const submitDetachedMessage = React.useCallback(async (submission: ParticipantComposerPreparedSubmission) => {
        if (props.sessionId !== null || !props.workspace) throw new Error(t('common.unavailable'));
        const result = await executeAction('execution.run.send', { sessionId: null, runId: props.runId,
            message: submission.text, localInputId: submission.localId }, runOperation);
        if (!result.ok) throw new Error(result.error ?? t('errors.failedToSendMessage'));
        if (!actionScopeIsCurrent()) throw new Error(t('common.unavailable'));
        submission.onOutboundHandoff();
        void load();
    }, [actionScopeIsCurrent, executeAction, runOperation, load, props.runId, props.sessionId, props.workspace?.machineId]);
    const submitScmConversationMessage = React.useCallback(async (submission: ParticipantComposerPreparedSubmission) => {
        if (state.status !== 'loaded' || state.run.intent !== 'scm_diff_summary' || !pendingOutboxScope) throw new Error(t('common.unavailable'));
        const output = ScmDiffSummaryGenerateOutputSchema.safeParse(structuredMeta?.payload ?? state.latestToolResult);
        if (!output.success || !output.data.resultId || !output.data.comparison) throw new Error(t('common.unavailable'));
        if (submission.draft.attachments.length > 0 || submission.draft.mentions.length > 0
            || hasBrowserContextComposerAttachments(browserContextRuntime?.composerContext.state)) {
            throw new Error(t('session.participants.unsupportedAttachmentsOrReviewComments'));
        }
        const operations = createScmDiffSummaryResultOperations({
            ...(props.sessionId !== null ? { sessionId: props.sessionId } : { machineId: props.workspace!.machineId }),
            serverId: pendingOutboxScope.serverId, accountId: pendingOutboxScope.accountId,
            shouldContinue: actionScopeIsCurrent, actionExecutor: createFrontDoorActionExecute({ execute: executeAction }),
        });
        const address = { cwd: output.data.comparison.repository.rootPath, resultId: output.data.resultId };
        // The transcript receipt may predate manual edits. Read the saved owner at send time;
        // its revision check still refuses any later edit that races this admission.
        const current = await operations.read(address);
        if (!current.success) throw new Error(current.error);
        if (current.result.output.runId !== props.runId) throw new Error(t('common.unavailable'));
        const admitted = await operations.discuss({ ...address, expectedRevision: current.result.revision,
            message: submission.displayText ?? submission.text });
        if (!admitted.success) throw new Error(admitted.error);
        if (!actionScopeIsCurrent()) throw new Error(t('common.unavailable'));
        submission.onOutboundHandoff();
        void load();
    }, [actionScopeIsCurrent, browserContextRuntime?.composerContext.state, executeAction, load, pendingOutboxScope, props.runId, props.sessionId, props.workspace?.machineId, state, structuredMeta]);
    const submitRunMessage = state.status === 'loaded' && state.run.intent === 'scm_diff_summary'
        ? submitScmConversationMessage : props.sessionId === null ? submitDetachedMessage : undefined;
    const failedTurn = state.status === 'loaded' && state.run.status === 'running' && !state.run.inputTurns?.current && state.run.inputTurns?.last?.state === 'failed'
        ? state.run.inputTurns.last : null;
    // A failed Run says its typed cause the same way a failed turn does: one line and its account action.
    const runError = failedTurn?.error ?? (state.status === 'loaded' && state.run.status === 'failed' ? state.run.error : undefined);
    const turnIssue = runError?.runtimeIssueV1;
    // A failed Run whose transcript page already says its failure (the SubAgentRun marker) says it once there.
    const transcriptStatesFailure = failedTurn === null && transcriptMessage?.kind === 'tool-call'
        && presentExecutionRunResultFailure(transcriptMessage.tool?.result) !== null;
    const turnFailure = presentExecutionRunFailure(runError);
    // The failure text a Run also returned as its latest result is that failure, already said above.
    const latestResultIsFailure = turnIssue !== undefined && state.status === 'loaded' && typeof state.latestToolResult === 'string'
        && (state.latestToolResult === turnIssue.sanitizedPreview || state.latestToolResult === state.run.error?.message);

    const content = state.status === 'loading' || state.status === 'loaded' && loadedRunAddressRef.current !== runAddressKey ? (
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
            title={props.sessionRemoved ? t('runPage.gone.sessionRemoved.title') : t('runPage.gone.title', { machine: machine.name })}
            reason={props.sessionRemoved ? t('runPage.gone.sessionRemoved.reason', { machine: machine.name }) : t('runPage.gone.reason')}
            action={props.onRequestClose
                ? { label: props.presentation === 'panel' ? t('common.close') : t('runPage.gone.closeTab'), onPress: props.onRequestClose }
                : { label: t('surfaceState.checkAgain'), onPress: () => load() }}
            // A removed Session took the details with it for good: nothing to check again.
            secondaryAction={props.onRequestClose && !props.sessionRemoved ? { label: t('surfaceState.checkAgain'), onPress: () => load() } : undefined}
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
                        serverId={explicitServerId}
                        acpCatalogSnapshot={acpCatalogSnapshot}
                        nativeModelCatalog={nativeModelCatalog}
                        sessionModels={sessionModels}
                        hostSessionId={props.sessionId}
                        daemonProcessLine={daemonProcessLine}
                        originTitle={discussionOriginTitle}
                        machineName={machine.name}
                        machineReachable={machineReachable}
                        attention={runAttention}
                        stopAction={canMutateRunViaSessionRpc && state.run.status === 'running'
                            ? { stopping: isStopping, onStop: stopRun }
                            : null}
                        deleteAction={canMutateRunViaSessionRpc && props.sessionId === null && props.workspace && !isExecutionRunActive(state.run)
                            ? { pending: isDeleting, onDelete: deleteRun }
                            : null}
                        cancelResponseAction={canMutateRunViaSessionRpc && interactionAffordances.canCancelTurn && cancellableInputTurn
                            ? { pending: pendingInteraction !== null, onCancel: () => invokeInteraction('cancel_turn') }
                            : null}
                        copyResultText={copyResultText}
                        onShowInTranscript={showInTranscript}
                        sendToSession={sendToSession}
                    />
                )}
            <View style={{ flex: 1, minHeight: 0, paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12, gap: theme.space.s12 }}>
            <View style={{ gap: theme.space.s8 }}>
                {/* A walkthrough or commit-proposal Run offers its own notification beside the output it writes. */}
                {props.sessionId !== null && canMutateRunViaSessionRpc && state.run.status === 'running' && structuredMeta?.kind !== EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary ? (
                    <SessionRunWorkNotifications sessionId={props.sessionId} runId={props.runId} serverId={explicitServerId} sheet />
                ) : null}
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
                {turnFailure && !transcriptStatesFailure ? <Text testID="session-run-details-turn-failure" accessibilityRole="alert" style={{ color: theme.colors.text.secondary }}>
                    {[turnFailure.message, turnFailure.reset].filter(Boolean).join(' · ')}
                </Text> : null}
                {turnFailure?.recovery ? <RoundButton testID="session-run-details-turn-failure-action" size="small" display="default"
                    title={turnFailure.recovery} onPress={() => {
                        props.onRequestClose?.();
                        router.push('/(app)/settings/connected-services');
                    }} /> : null}
                {showPreMarkerState ? (
                    <View
                        testID="session-run-details-pre-marker-state"
                        accessibilityRole="text"
                        style={{ paddingVertical: theme.space.s4 }}
                    >
                        <Text style={{ color: theme.colors.text.secondary }}>
                            {t('status.awaitingUpdates')}
                        </Text>
                    </View>
                ) : null}
                {leadSessionId !== null && !transcriptMessage && transcriptToolRouteId ? (
                    <HappierPressable
                        accessibilityRole="button"
                        accessibilityLabel={t('toolView.open')}
                        testID="session-run-details-open-tool-message"
                        onPress={() => {
                            navigateWithBlurOnWeb(() => {
                                router.push(buildScopedSessionRouteHref({
                                    sessionId: leadSessionId,
                                    serverId: props.serverId ?? session?.serverId,
                                    suffix: `/message/${encodeURIComponent(transcriptToolRouteId)}`,
                                }));
                            });
                        }}
                        style={{
                            alignSelf: 'flex-start',
                            paddingVertical: theme.space.s8,
                            paddingHorizontal: theme.space.s10,
                            borderRadius: 10,
                            backgroundColor: theme.colors.surface.inset,
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                        }}
                    >
                        <Text style={{ color: theme.colors.text.primary, fontWeight: '600' }}>{t('toolView.open')}</Text>
                    </HappierPressable>
                ) : null}
            </View>

            {approval.approvalPending && approval.approvalId && pendingOutboxScope ? (
                <ActionApprovalPendingNotice
                    message={t('approvals.title')}
                    onOpenApproval={() => {
                        props.onRequestClose?.();
                        router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(pendingOutboxScope.serverId)}`);
                    }}
                />
            ) : null}
            {props.sessionId !== null && stopUnconfirmed ? (
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
                <View style={{ gap: theme.space.s8 }}>
                    {stopError && !stopUnconfirmed ? <Text style={{ color: theme.colors.text.secondary }}>{stopError}</Text> : null}
                    {interactionError ? <Text style={{ color: theme.colors.text.secondary }}>{interactionError}</Text> : null}
                    {interactionAffordances.canResume ? (
                        <HappierPressable
                            accessibilityRole="button"
                            accessibilityLabel={t('runs.runDetails.resumeRun')}
                            busy={pendingInteraction === 'resume'}
                            testID="session-run-details-resume"
                            disabled={pendingInteraction !== null}
                            onPress={() => invokeInteraction('resume')}
                            style={{
                                paddingVertical: theme.space.s10,
                                paddingHorizontal: theme.space.s12,
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
                        </HappierPressable>
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
            {latestToolResultProjection !== null && !hasStructuredResult && transcriptMessage?.kind !== 'tool-call' && !latestResultIsFailure ? (
                <View
                    testID="session-run-details-latest-tool-result"
                    style={{
                        padding: theme.space.s12,
                        borderRadius: 12,
                        backgroundColor: theme.colors.surface.inset,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        gap: theme.space.s6,
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
                    <HappierPressable
                        accessibilityRole="button"
                        expanded={rawToolResultExpanded}
                        testID="session-run-details-latest-tool-result-raw-toggle"
                        onPress={() => setRawToolResultExpanded((current) => !current)}
                        style={{ alignSelf: 'flex-start', paddingVertical: theme.space.s4 }}
                    >
                        <Text style={{ color: theme.colors.text.secondary }}>{t('runs.runDetails.latestToolResultRaw')}</Text>
                    </HappierPressable>
                    {rawToolResultExpanded ? (
                        <Text
                            testID="session-run-details-latest-tool-result-raw"
                            style={{ color: theme.colors.text.secondary, fontFamily: 'Menlo' }}
                        >
                            {JSON.stringify(state.latestToolResult !== undefined ? state.latestToolResult : state.run.error, null, 2)}
                        </Text>
                    ) : null}
                </View>
            ) : null}

            {/* Exactly one composer on this surface. The canonical message details host
                owns the run's sidechain, its exact-target pending rows and the standard
                Agent composer; this view decides only whether the run's own interaction
                projection permits one. The plain `TextInput` that used to sit here was a
                second composer with its own send state and its own direct runtime call. */}
            {props.sessionId !== null && session && !structuredCard && transcriptMessage?.kind === 'tool-call' ? (
                <SessionMessageDetailsView
                    sessionId={props.sessionId}
                    session={session}
                    message={transcriptMessage}
                    showComposer={canShowSendComposer}
                    recipientOverride={executionRunParticipantTargets[0]!.recipient}
                    composerInitialLocalId={props.retryInputLocalId}
                    browserContextState={browserContextRuntime?.composerContext.state ?? null}
                    composerPlaceholder={replyPlaceholder}
                    {...(walkthroughConversation ? { walkthroughEngine: walkthroughEngine ?? null } : {})}
                    submitPreparedMessage={submitRunMessage}
                />
            ) : null}
            {(session || props.sessionId === null) && !structuredCard && transcriptMessage?.kind !== 'tool-call' ? (
                <View style={{ gap: theme.space.s10 }}>
                    {props.sessionId !== null && session && transcriptToolId !== null ? (
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
                    ) : props.sessionId !== null && (targetPending.messages.length > 0 || targetPending.discarded.length > 0) ? (
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
                                props.serverId ?? session?.serverId ?? '',
                                pendingOutboxScope?.accountId,
                                props.sessionId,
                                executionRunRecipient.runId,
                                props.retryInputLocalId ?? '',
                            ])}
                            sessionId={props.sessionId}
                            workspace={props.workspace}
                            serverId={props.serverId ?? session?.serverId}
                            canSendMessages={props.sessionId === null ? actionScopeIsCurrent() : interaction.canSendMessages}
                            recipient={props.sessionId === null ? null : executionRunRecipientState.recipient}
                            submitPreparedMessage={props.sessionId === null || executionRunRecipientState.recipient?.kind === 'execution_run'
                                && executionRunRecipientState.recipient.runId === props.runId ? submitRunMessage : undefined}
                            initialText={props.initialText}
                            executionRunRequestedAction={executionRunRecipientState.executionRunRequestedAction}
                            extraActionChips={props.sessionId === null ? [] : executionRunRoutingControls.extraActionChips}
                            initialLocalId={props.retryInputLocalId}
                            browserContextState={browserContextRuntime?.composerContext.state ?? null}
                            {...(replyPlaceholder ? { placeholder: replyPlaceholder } : {})}
                            fixedEngine={walkthroughEngine}
                        />
                    ) : null}
                    {canShowSendComposer && leadTitle ? (
                        <Text testID="session-run-details-replies-foot" numberOfLines={2} style={{ color: theme.colors.text.secondary, fontSize: 12 }}>
                            {t('agentStart.pane.repliesGoTo', { session: leadTitle })}
                        </Text>
                    ) : null}
                </View>
            ) : null}
            </View>
        </View>
    );

    const reviewNotice = props.reviewersNotStarted?.length || props.narrationError ? (
        // A reviewer that didn't start failed (rose, lab flRun `partial`); the started ones keep running below.
        <SurfaceStateCard testID="session-run-details-review-partial" size="line" kind="error"
            title={props.reviewersNotStarted?.length
                ? t('runPage.review.reviewersNotStarted', { count: props.reviewersNotStarted.length })
                : t('reviewWalkthrough.started.narrationFailed')}
            reason={[
                ...(props.reviewersNotStarted ?? []).map(reviewer => t('runPage.review.reviewerNotStarted', { reviewer })),
                ...(props.narrationError ? [t('reviewWalkthrough.started.narrationFailed')] : []),
            ].join('\n')} />
    ) : null;
    if (props.presentation === 'panel') {
        // A settled gone state is a short message: the panel (a dialog) takes its height, not the full card.
        return <View style={state.status === 'gone' ? undefined : { flex: 1 }}>{reviewNotice}{content}</View>;
    }

    return (
        <ConstrainedScreenContent style={{ flex: 1 }}>
            {reviewNotice}
            {content}
        </ConstrainedScreenContent>
    );
});
