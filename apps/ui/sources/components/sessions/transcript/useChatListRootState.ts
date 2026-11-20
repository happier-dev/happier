import * as React from 'react';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { resolveTranscriptToolVisibility } from './resolveTranscriptToolVisibility';
import {
    storage,
    useSessionPendingMessages,
    useSessionReferenceTarget,
    useSetting,
} from '@/sync/domains/state/storage';
import { buildSessionMetadataStabilitySignatureValue, buildStableJsonSignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { useActiveServerAccountScope, useServerScopedMachine } from '@/sync/store/hooks';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useSessionTranscriptSource } from './source/SessionTranscriptSourceContext';
import {
    EMPTY_MESSAGES_BY_ID,
} from '@/components/sessions/transcript/chatListEmptyValues';
import type {
    ChatListInternalProps,
    ChatListProps,
} from '@/components/sessions/transcript/chatListTypes';
import { useTranscriptSessionCommon } from '@/components/sessions/transcript/transcriptSessionCommon';
import { useStableValueBySignature } from '@/components/sessions/transcript/items/stableValueBySignature';
import { preloadEnrichedMarkdownRuntime } from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import { useSessionManagedWorkflowRuns } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import { useTranscriptRootDerivedItems } from '@/components/sessions/transcript/items/useTranscriptRootDerivedItems';
import { useTranscriptMarkerInputs } from '@/components/sessions/transcript/markers/useTranscriptMarkerInputs';
import { projectTranscriptTurnEnds } from '@/components/sessions/transcript/markers/transcriptMarkers';
import { useTranscriptRootNavigationState } from '@/components/sessions/transcript/navigation/useTranscriptRootNavigationState';
import { useTranscriptRootPendingRequests } from '@/components/sessions/transcript/items/useTranscriptRootPendingRequests';
import { useTranscriptRootRollbackActions } from '@/components/sessions/transcript/items/useTranscriptRootRollbackActions';
import { useTranscriptRootThinkingState } from '@/components/sessions/transcript/thinking/useTranscriptRootThinkingState';
import { useTranscriptRootMessages } from '@/components/sessions/transcript/items/useTranscriptRootMessages';
import {
    resolveTranscriptEventEmphasisByMessageId,
    resolveTranscriptHostWakeCountByMessageId,
} from '@/components/sessions/transcript/events/transcriptEventEmphasis';
import { resolveTranscriptRuntimeIssueRepeatCountByMessageId } from '@/components/sessions/transcript/events/runtimeIssueRepeatProjection';
import type { Message } from "@happier-dev/session-core/messages";
import { isRecoveredHistoryTranscriptObservation } from "@happier-dev/session-core/messages";
import { readExternalSessionOperationPresentationFromMetadata } from '@/components/sessions/transcript/items/externalSessionOperationMetadata';
import { useExternalSessionOperationTranscriptDismissal } from '@/components/sessions/transcript/items/useExternalSessionOperationTranscriptDismissal';
import { useExternalSessionOperationOwnerHydration } from '@/components/sessions/transcript/items/useExternalSessionOperationOwnerHydration';
import { readSessionOwnerMetadataView, readSessionOwnerMetadataViewPreferences } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { SESSION_MESSAGE_ACTION_PROJECTION_SECTIONS, TRANSCRIPT_ACTIVITY_PROJECTION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { useDaemonProjectionPluginSlices } from '@/agents/backendCatalog/useDaemonProjectionPluginSlices';
import { useMountedClientActionDemand } from '@/components/appShell/plugins/mountedClientActionDemand';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { usePluginTranscriptActivities } from '@/components/sessions/transcript/items/usePluginTranscriptActivities';
import { buildV2PluginProjectionById } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import {
    openPluginContributedActionSessionReference,
} from '@/components/plugins/actions/openPluginContributedAction';
import {
    createPluginMessageActionHost,
    type PluginMessageActionHost,
} from '@/components/sessions/transcript/messageActions/PluginMessageActions';
import {
    createPluginContributedActionController,
    type PluginContributedActionCurrentSnapshot,
} from '@/components/plugins/actions/pluginContributedActionController';
import {
    usePluginUiClientExecutableRegistrationRevision,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';

export function resolveLatestCommittedActivityKey(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): string | null {
    for (let index = params.messageIdsOldestFirst.length - 1; index >= 0; index -= 1) {
        const id = params.messageIdsOldestFirst[index]!;
        const message = params.messagesById[id];
        if (!message || !isRecoveredHistoryTranscriptObservation(message)) return id;
    }
    return null;
}

export function resolveExternalSessionOperationMachineSubscriptionTarget(params: Readonly<{
    isExactOwner: boolean;
    machineId: string | null;
    hasPresentation: boolean;
}>): string | null {
    return params.isExactOwner && params.hasPresentation
        ? params.machineId
        : null;
}

export function useChatListRootState(props: ChatListProps) {
    const sessionSurfaceKey = props.sessionSurfaceKey;
    const clientExecutableRegistrationRevision = usePluginUiClientExecutableRegistrationRevision();
    const currentUiContextReader = useOptionalCurrentUiContextReader();
    const destinationNavigation = usePluginSurfaceDestinationNavigationBinding();
    const {
        fork,
        forkAwareMessageDescriptors,
        forkedTranscriptEnabled,
        isLoaded,
        messageIdsOldestFirst,
        messagesById,
    } = useTranscriptRootMessages(props.session.id);
    const { messages: pendingMessages, discarded: discardedPendingMessages } = useSessionPendingMessages(props.session.id);
    const sessionServerId = usePreferredServerIdForSession({
        serverId: props.session.serverId,
        sessionId: props.session.id,
    });
    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptShowToolCalls = useSetting('transcriptShowToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const transcriptSessionCommon = useTranscriptSessionCommon();
    const toolViewTimelineChromeMode = transcriptSessionCommon.toolChrome.toolViewTimelineChromeMode;

    const activeServerAccountScope = useActiveServerAccountScope();
    const sessionTurns = props.session.sessionTurns?.turns;
    const turnEnds = React.useMemo(() => projectTranscriptTurnEnds(sessionTurns), [sessionTurns]);
    const {
        sessionMessagePins,
        togglePersistedSessionMessagePin,
        transcriptNavigationEntries,
    } = useTranscriptRootNavigationState({
        activeServerAccountScope,
        forkedTranscriptEnabled,
        forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
        messageIdsOldestFirst,
        messagesById,
        sessionId: props.session.id,
        turnEnds,
    });
    const pendingUserActionRequests = useTranscriptRootPendingRequests({
        messageIdsOldestFirst,
        messagesById,
        session: props.session,
    });
    const sharedSessionMetadataSignature = React.useMemo(
        () => buildStableJsonSignature(buildSessionMetadataStabilitySignatureValue(props.session.metadata ?? null)),
        [props.session.metadata],
    );
    const stableSharedSessionMetadata = useStableValueBySignature(
        props.session.metadata,
        sharedSessionMetadataSignature,
    );
    const externalSessionOperationPresentation = React.useMemo(
        () => readExternalSessionOperationPresentationFromMetadata(stableSharedSessionMetadata),
        [stableSharedSessionMetadata],
    );
    const ownerMetadata = readSessionOwnerMetadataView(props.session);
    const sessionMetadataSignature = React.useMemo(
        () => buildStableJsonSignature(buildSessionMetadataStabilitySignatureValue(ownerMetadata)),
        [ownerMetadata],
    );
    const stableSessionMetadata = useStableValueBySignature(ownerMetadata, sessionMetadataSignature);
    const operationMachineId = React.useMemo(
        () => resolveSessionMachineId(stableSessionMetadata),
        [stableSessionMetadata],
    );
    const isExactOwner = React.useMemo(() => createSessionActionTarget({
        session: props.session,
        currentUserId: activeServerAccountScope?.accountId ?? null,
    }).isOwnedByCurrentUser, [
        activeServerAccountScope?.accountId,
        props.session,
    ]);
    const operationMachineSubscriptionTarget =
        resolveExternalSessionOperationMachineSubscriptionTarget({
            hasPresentation: externalSessionOperationPresentation !== null,
            isExactOwner,
            machineId: operationMachineId,
        });
    const operationMachine = useServerScopedMachine(
        sessionServerId,
        operationMachineSubscriptionTarget ?? '',
    );
    const operationPresence = useMachinePresenceSummary(sessionServerId, operationMachineSubscriptionTarget);
    const operationMachineReachable = operationPresence.reachability === 'reachable';
    // Only this store-owned server-backed deletion fact means the target is
    // permanently gone. Session cache eviction and archiving intentionally do
    // not retire its contextual Resource LKG.
    const sessionReferenceTarget = useSessionReferenceTarget(props.session.id, props.session.serverId);
    // A transcript activity is local, live Resource state. Bind it through the
    // same session machine/server authority as the existing session operation;
    // shared/read-only viewers do not probe a local plugin Resource.
    const pluginActivityProjection = usePluginUiProjectionCurrentness({
        // Activities read only their Transcript Activity declarations (UI family);
        // the complete UI catalogue belongs to its own presenting consumers.
        sections: TRANSCRIPT_ACTIVITY_PROJECTION_SECTIONS,
        machineId: operationMachineId,
        serverId: sessionServerId,
        enabled: isExactOwner,
    });
    const pluginActivityLifetime = pluginActivityProjection.accountLifetime;
    const {
        activities: pluginTranscriptActivities,
        dismissedActivityIds: dismissedPluginTranscriptActivityIds,
        onDismissActivity: onDismissPluginTranscriptActivity,
    } = usePluginTranscriptActivities({
        accountLifetime: pluginActivityLifetime,
        interactionEnabled: pluginActivityProjection.interactionEnabled,
        machineId: pluginActivityProjection.machineId,
        platform: pluginActivityProjection.platform,
        pluginUiProjection: pluginActivityProjection.pluginUiProjection,
        serverId: pluginActivityProjection.serverId,
        sessionId: props.session.id,
        sessionRemoved: sessionReferenceTarget.deleted,
    });
    const externalSessionOperationOwnerTarget = React.useMemo(() => (
        operationMachineSubscriptionTarget === null
            ? null
            : {
                machineId: operationMachineSubscriptionTarget,
                machineOnline:
                    operationMachine !== null && operationMachineReachable,
                machineStatusKnown: operationMachine !== null && operationPresence.reachability !== 'unknown',
                serverId: sessionServerId,
            }
    ), [
        operationMachine,
        operationMachineReachable,
        operationPresence.reachability,
        operationMachineSubscriptionTarget,
        sessionServerId,
    ]);
    const externalSessionOperationOwnerHydration =
        useExternalSessionOperationOwnerHydration({
            isExactOwner,
            machineId: operationMachineId,
            machineOnline:
                operationMachine !== null && operationMachineReachable,
            ownerScopeKey: activeServerAccountScope
                ? serverAccountScopeKeySuffix(activeServerAccountScope)
                : null,
            presentation: externalSessionOperationPresentation,
            serverId: sessionServerId,
            sessionId: props.session.id,
        });
    // Offered ONLY while the exact owner's own status read failed: `not_owner`/`offline`
    // readers are not recovering anything by re-reading, and `loading`/`ready` have no
    // failure to recover from. Gating here keeps the row a pure presentation of the
    // hydration owner's status rather than a second decision-maker.
    const externalSessionOperationOwnerCheckAgain =
        externalSessionOperationOwnerHydration.status === 'unavailable'
            ? externalSessionOperationOwnerHydration.checkAgain
            : null;
    const {
        dismissal: externalSessionOperationDismissal,
        onDismiss: onDismissExternalSessionOperation,
    } = useExternalSessionOperationTranscriptDismissal({
        sessionId: props.session.id,
        presentation: externalSessionOperationPresentation,
    });

    const groupingMode = transcriptGroupingMode === 'turns' ? 'turns' : 'linear';
    const toolVisibility = resolveTranscriptToolVisibility({
        sessionOverride: readSessionOwnerMetadataViewPreferences(stableSessionMetadata)?.showToolCalls,
        isBot: readSessionBotV1(props.session.metadata?.bot) !== null,
        accountShowToolCalls: transcriptShowToolCalls,
        groupToolCalls: transcriptGroupToolCalls === true && toolViewTimelineChromeMode === 'activity_feed',
        collapsedPreviewCount: transcriptSessionCommon.toolChrome.transcriptToolCallsCollapsedPreviewCount,
    });
    const groupToolCalls = toolVisibility.groupToolCalls;
    const toolChromeCommon = React.useMemo(() => ({
        ...transcriptSessionCommon.toolChrome,
        showToolCalls: toolVisibility.showToolCalls,
        transcriptToolCallsCollapsedPreviewCount: toolVisibility.collapsedPreviewCount,
    }), [transcriptSessionCommon.toolChrome, toolVisibility.collapsedPreviewCount, toolVisibility.showToolCalls]);
    const toolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';

    const latestCommittedActivityKey = resolveLatestCommittedActivityKey({
        messageIdsOldestFirst,
        messagesById,
    });
    const { rollbackActionsByMessageId, rollbackRanges } = useTranscriptRootRollbackActions({
        messageIdsOldestFirst,
        messagesById,
        session: props.session,
        sessionMetadataSignature,
        stableSessionMetadata,
    });
    // The shell Session does not move with thinking (it changes several times a turn); this list reads it live.
    const liveSessionThinking = storage((state) => state.sessions[props.session.id]?.thinking);
    const sessionThinking = (liveSessionThinking ?? props.session.thinking) === true;
    const activeThinkingMessageId = useTranscriptRootThinkingState({
        latestCommittedActivityKey,
        sessionId: props.session.id,
        sessionThinking,
    });
    const eventEmphasisByMessageId = React.useMemo(() => (
        resolveTranscriptEventEmphasisByMessageId({
            messageIdsOldestFirst,
            messagesById,
            sessionActive: props.session.active === true,
        })
    ), [messageIdsOldestFirst, messagesById, props.session.active]);
    const hostWakeCounts = React.useMemo(() => (
        resolveTranscriptHostWakeCountByMessageId({ messageIdsOldestFirst, messagesById })
    ), [messageIdsOldestFirst, messagesById]);
    // Rows re-render only when a wake's count changes, not on every transcript update.
    const hostWakeCountByMessageId = useStableValueBySignature(
        hostWakeCounts,
        Object.entries(hostWakeCounts).map(([id, count]) => `${id}:${count}`).join('|'),
    );
    const runtimeIssueRepeatCounts = React.useMemo(() => (
        resolveTranscriptRuntimeIssueRepeatCountByMessageId({ messageIdsOldestFirst, messagesById })
    ), [messageIdsOldestFirst, messagesById]);
    // Only the drawn failure row of a repeated run reads this; it changes only when a run grows.
    const runtimeIssueRepeatCountByMessageId = useStableValueBySignature(
        runtimeIssueRepeatCounts,
        Object.entries(runtimeIssueRepeatCounts).map(([id, count]) => `${id}:${count}`).join('|'),
    );

    const transcriptSource = useSessionTranscriptSource();
    const interaction = transcriptSource.useInteraction();
    // Trigger Runs that fired from this Session's turn ends, read through the one Account Run owner, so a
    // Run that wrote no turn (Keep going checked done) still gets its fold (07 U9).
    const originRuns = useSessionManagedWorkflowRuns({
        sessionId: props.session.id,
        serverId: sessionServerId,
        enabled: transcriptSource.kind === 'app',
    });
    // Message Actions share the exact Home's Account + Machine catalog. Live
    // transcript Activities above retain their Machine-owned Resource demand.
    const pluginMessageActionProjection = useScopedPluginUiProjection({
        sections: SESSION_MESSAGE_ACTION_PROJECTION_SECTIONS,
        machineId: operationMachineId,
        serverId: sessionServerId,
        enabled: isExactOwner,
    });
    const pluginMessageActionSlices = useDaemonProjectionPluginSlices({
        machineId: pluginMessageActionProjection.machineId,
        serverId: pluginMessageActionProjection.serverId,
        accountLifetime: pluginMessageActionProjection.accountLifetime,
    });
    // The Session's slices are not the AppShell's complete catalogue: they feed
    // its executable owner as mounted demand, so their client Actions register.
    const pluginMessageActionClientSource = React.useMemo(() => {
        const projection = pluginMessageActionProjection.pluginUiProjection;
        const machineId = pluginMessageActionProjection.machineId;
        return projection && machineId && isExactOwner ? { projection,
            directMachineAuthority: { machineId, serverId: pluginMessageActionProjection.serverId } } : null;
    }, [isExactOwner, pluginMessageActionProjection.machineId, pluginMessageActionProjection.pluginUiProjection,
        pluginMessageActionProjection.serverId]);
    useMountedClientActionDemand(pluginMessageActionProjection.accountLifetime, pluginMessageActionClientSource);
    const pluginMessageActionSnapshotRef = React.useRef<PluginContributedActionCurrentSnapshot | null>(null);
    const pluginMessageActionScope = React.useMemo(
        () => new AbortController(),
        [
            isExactOwner,
            interaction.canSendMessages,
            pluginMessageActionProjection.accountLifetime,
            pluginMessageActionProjection.interactionEnabled,
            pluginMessageActionProjection.machineId,
            pluginMessageActionProjection.serverId,
            props.session.id,
        ],
    );
    React.useEffect(() => () => pluginMessageActionScope.abort(), [pluginMessageActionScope]);
    const pluginMessageActionSnapshot = React.useMemo<PluginContributedActionCurrentSnapshot | null>(() => {
        const projection = pluginMessageActionProjection.pluginUiProjection;
        if (
            !isExactOwner
            || interaction.canSendMessages !== true
            || pluginMessageActionProjection.interactionEnabled !== true
            || !projection
        ) {
            return null;
        }
        const resolveContributedAction = createPluginUiProjectedActionResolver(projection.actionsById);
        const snapshot: PluginContributedActionCurrentSnapshot = {
            pluginProjectionById: buildV2PluginProjectionById({ generation: projection.generation,
                installedPackagesById: projection.installedPackagesById,
                actionsById: projection.actionsById, resourcesById: projection.resourcesById }),
            pluginUiProjection: projection,
            resolveContributedAction,
            pluginSlices: pluginMessageActionSlices,
            host: {
                machineId: pluginMessageActionProjection.machineId,
                serverId: pluginMessageActionProjection.serverId,
                sessionId: props.session.id,
                signal: pluginMessageActionScope.signal,
                accountLifetime: pluginMessageActionProjection.accountLifetime,
                ...(destinationNavigation ? { openSurface: destinationNavigation.openSurface } : {}),
                ...(currentUiContextReader
                    ? { readCurrentUiContext: currentUiContextReader.readCurrentUiContext }
                    : {}),
                isCurrent: () => !pluginMessageActionScope.signal.aborted
                    && pluginMessageActionSnapshotRef.current?.host.signal === pluginMessageActionScope.signal,
                isActionCurrent: (identity) => {
                    const action = resolveContributedAction(identity);
                    return action !== null
                        && pluginMessageActionSnapshotRef.current?.resolveContributedAction?.(identity) === action;
                },
            },
        };
        return snapshot;
    }, [
        interaction.canSendMessages,
        isExactOwner,
        currentUiContextReader,
        destinationNavigation,
        pluginMessageActionProjection.accountLifetime,
        pluginMessageActionProjection.interactionEnabled,
        pluginMessageActionProjection.machineId,
        pluginMessageActionProjection.serverId,
        pluginMessageActionProjection.pluginUiProjection,
        pluginMessageActionScope,
        pluginMessageActionSlices,
        props.session.id,
    ]);
    pluginMessageActionSnapshotRef.current = pluginMessageActionSnapshot;
    // Transcript Activity rows retain only opaque Action capability references.
    // Re-resolve each one through the same current Session controller that owns
    // catalog Actions; the row neither caches a descriptor nor creates a local
    // input/dispatch path.
    const pluginTranscriptActivityActionController = React.useMemo(() => (
        pluginMessageActionSnapshot
            ? createPluginContributedActionController({
                resolveCurrent: () => pluginMessageActionSnapshotRef.current,
            })
            : null
    ), [
        clientExecutableRegistrationRevision,
        pluginMessageActionScope,
        pluginMessageActionSnapshot !== null,
        pluginMessageActionProjection.pluginUiProjection?.actionsById,
        pluginMessageActionProjection.pluginUiProjection?.installedPackagesById,
        pluginMessageActionProjection.pluginUiProjection?.translationsByPluginId,
    ]);
    const isPluginTranscriptActivityActionAvailable = React.useCallback((action: Readonly<{
        pluginId: string;
        localId: string;
    }>): boolean => (
        pluginTranscriptActivityActionController?.isSessionReferenceAvailable(action) === true
    ), [pluginTranscriptActivityActionController]);
    // Action admission is resolved before the synthetic transcript item is
    // built. That final item is the shared input to both the card and its
    // measurement signature, so an offline Action cannot leave a hidden row's
    // reservation behind in the virtualizer.
    const { groupedItems, transcriptMaxTurnEntriesPerListItem } = useTranscriptRootDerivedItems({
        discardedPendingMessages,
        fork,
        forkAwareMessageDescriptors,
        forkedTranscriptEnabled,
        groupToolCalls,
        groupingMode,
        messageIdsOldestFirst,
        messagesById,
        pendingMessages,
        pendingUserActionRequests,
        externalSessionOperationDismissal,
        externalSessionOperationPresentation,
        externalSessionOperationProgress:
            externalSessionOperationOwnerHydration.progress,
        pluginTranscriptActivities,
        dismissedPluginTranscriptActivityIds,
        isPluginTranscriptActivityActionAvailable,
        sessionId: props.session.id,
        sessionTurns: props.session.sessionTurns?.turns ?? null,
        triggerRuns: originRuns.runs,
        toolCallsGroupStrategy,
    });
    const onOpenPluginTranscriptActivityAction = React.useCallback((action: Readonly<{
        pluginId: string;
        localId: string;
    }>): void => {
        if (!pluginTranscriptActivityActionController) return;
        fireAndForget(openPluginContributedActionSessionReference({
            controller: pluginTranscriptActivityActionController,
            action,
            signal: pluginMessageActionScope.signal,
        }), { tag: 'PluginTranscriptActivity.openAction' });
    }, [pluginMessageActionScope, pluginTranscriptActivityActionController]);
    const pluginMessageActionHost = React.useMemo<PluginMessageActionHost | null>(() => (
        pluginMessageActionSnapshot
            ? createPluginMessageActionHost({
                resolveCurrent: () => pluginMessageActionSnapshotRef.current,
                sessionId: props.session.id,
                signal: pluginMessageActionScope.signal,
            })
            : null
    ), [
        pluginMessageActionScope,
        pluginMessageActionSnapshot !== null,
        pluginMessageActionProjection.pluginUiProjection?.actionsById,
        pluginMessageActionProjection.pluginUiProjection?.installedPackagesById,
        pluginMessageActionProjection.pluginUiProjection?.translationsByPluginId,
        props.session.id,
    ]);
    const internalMessagesById = forkedTranscriptEnabled ? messagesById : EMPTY_MESSAGES_BY_ID;
    const transcriptMarkers = useTranscriptMarkerInputs(
        props.session,
        messageIdsOldestFirst.length > 0,
        transcriptSessionCommon.messageDisplay.accountActorViewerScope ?? null,
        turnEnds,
    );

    return {
        boundary: {
            eligibleMessageIdsInOrder: messageIdsOldestFirst,
            key: sessionSurfaceKey,
            sessionId: props.session.id,
            selectionEnabled: transcriptSessionCommon.messageDisplay.transcriptMessageSelectionEnabled === true,
        },
        pluginMessageActionHost,
        runtimeIssueRepeatCountByMessageId,
        internalProps: {
            metadata: stableSessionMetadata,
            sessionId: props.session.id,
            sessionServerId,
            sessionSurfaceKey,
            sessionActive: props.session.active === true,
            sessionThinking,
            groupingMode,
            forkedTranscriptEnabled,
            items: groupedItems,
            transcriptMarkers,
            maxTurnEntriesPerListItem: transcriptMaxTurnEntriesPerListItem,
            transcriptNavigationEntries,
            messagePins: sessionMessagePins,
            onToggleMessagePin: togglePersistedSessionMessagePin,
            messagesById: internalMessagesById,
            eventEmphasisByMessageId,
            hostWakeCountByMessageId,
            forkMessageMetadataById: forkAwareMessageDescriptors?.metadataByMessageId ?? null,
            committedMessagesCount: messageIdsOldestFirst.length,
            latestCommittedActivityKey,
            activeThinkingMessageId,
            rollbackRanges,
            rollbackActionsByMessageId,
            isLoaded,
            approvalRequests: props.approvalRequests,
            interaction,
            jumpToSeq: props.jumpToSeq ?? null,
            jumpToMessageId: props.jumpToMessageId ?? null,
            followBottomIntentKey: props.followBottomIntentKey ?? null,
            onJumpLanded: props.onJumpLanded,
            onViewportChange: props.onViewportChange,
            onEditPendingMessage: props.onEditPendingMessage,
            onDismissExternalSessionOperation,
            onDismissPluginTranscriptActivity,
            onOpenPluginTranscriptActivityAction,
            onExternalSessionOperationActionResult:
                externalSessionOperationOwnerHydration.onActionResult,
            onCheckAgainExternalSessionOperation:
                externalSessionOperationOwnerCheckAgain,
            externalSessionOperationOwnerTarget,
            isWarmKeepAliveInstance: props.isWarmKeepAliveInstance === true,
            routeHydrationPending: props.routeHydrationPending === true,
            forkCommon: transcriptSessionCommon.fork,
            messageDisplayCommon: transcriptSessionCommon.messageDisplay,
            toolChromeCommon,
            toolRouteCommon: transcriptSessionCommon.toolRoute,
        } satisfies ChatListInternalProps,
    };
}

export function requestSessionOpenInitialFill(): void {
    fireAndForget(preloadEnrichedMarkdownRuntime(), { tag: 'ChatList.preloadEnrichedMarkdownRuntime' });
}
