import * as React from 'react';
import {
    useSessionActionDrafts,
    useSessionPendingMessages,
    useSessionReferenceTarget,
    useSetting,
} from '@/sync/domains/state/storage';
import { buildSessionMetadataStabilitySignatureValue, buildStableJsonSignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { useActiveServerAccountScope, useMachine } from '@/sync/store/hooks';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
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
import { useTranscriptRootDerivedItems } from '@/components/sessions/transcript/items/useTranscriptRootDerivedItems';
import { useTranscriptRootNavigationState } from '@/components/sessions/transcript/navigation/useTranscriptRootNavigationState';
import { useTranscriptRootPendingRequests } from '@/components/sessions/transcript/items/useTranscriptRootPendingRequests';
import { useTranscriptRootRollbackActions } from '@/components/sessions/transcript/items/useTranscriptRootRollbackActions';
import { useTranscriptRootThinkingState } from '@/components/sessions/transcript/thinking/useTranscriptRootThinkingState';
import { useTranscriptRootMessages } from '@/components/sessions/transcript/items/useTranscriptRootMessages';
import { resolveTranscriptEventEmphasisByMessageId } from '@/components/sessions/transcript/events/transcriptEventEmphasis';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { isRecoveredHistoryTranscriptObservation } from '@/sync/domains/messages/transcriptObservationProvenance';
import { readExternalSessionOperationPresentationFromMetadata } from '@/components/sessions/transcript/items/externalSessionOperationMetadata';
import { useExternalSessionOperationTranscriptDismissal } from '@/components/sessions/transcript/items/useExternalSessionOperationTranscriptDismissal';
import { useExternalSessionOperationOwnerHydration } from '@/components/sessions/transcript/items/useExternalSessionOperationOwnerHydration';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { usePluginTranscriptActivities } from '@/components/sessions/transcript/items/usePluginTranscriptActivities';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
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
    const clientExecutableRegistrationRevision = usePluginUiClientExecutableRegistrationRevision();
    const currentUiContextReader = useOptionalCurrentUiContextReader();
    const {
        fork,
        forkAwareMessageDescriptors,
        forkedTranscriptEnabled,
        isLoaded,
        messageIdsOldestFirst,
        messagesById,
    } = useTranscriptRootMessages(props.session.id);
    const { messages: pendingMessages, discarded: discardedPendingMessages } = useSessionPendingMessages(props.session.id);
    const actionDrafts = useSessionActionDrafts(props.session.id);
    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const transcriptSessionCommon = useTranscriptSessionCommon(props.session.id);
    const toolViewTimelineChromeMode = transcriptSessionCommon.toolChrome.toolViewTimelineChromeMode;

    const activeServerAccountScope = useActiveServerAccountScope();
    const {
        sessionMessagePins,
        togglePersistedSessionMessagePin,
        transcriptNavigationEntries,
    } = useTranscriptRootNavigationState({
        activeServerAccountScope,
        forkedTranscriptEnabled,
        messageIdsOldestFirst,
        messagesById,
        sessionId: props.session.id,
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
    const operationMachine = useMachine(
        operationMachineSubscriptionTarget ?? '',
        operationMachineSubscriptionTarget !== null,
    );
    const sessionServerId = usePreferredServerIdForSession(props.session.id);
    // Only this store-owned server-backed deletion fact means the target is
    // permanently gone. Session cache eviction and archiving intentionally do
    // not retire its contextual Resource LKG.
    const sessionReferenceTarget = useSessionReferenceTarget(props.session.id);
    // A transcript activity is local, live Resource state. Bind it through the
    // same session machine/server authority as the existing session operation;
    // shared/read-only viewers do not probe a local plugin Resource.
    const pluginActivityProjection = usePluginUiProjectionCurrentness({
        machineId: operationMachineId,
        serverId: sessionServerId,
        enabled: isExactOwner,
    });
    const pluginActivityLifetime = captureActiveServerAccountScopeLifetime();
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
                    operationMachine !== null && isMachineOnline(operationMachine),
                machineStatusKnown: operationMachine !== null,
                serverId: sessionServerId,
            }
    ), [
        operationMachine,
        operationMachineSubscriptionTarget,
        sessionServerId,
    ]);
    const externalSessionOperationOwnerHydration =
        useExternalSessionOperationOwnerHydration({
            isExactOwner,
            machineId: operationMachineId,
            machineOnline:
                operationMachine !== null && isMachineOnline(operationMachine),
            ownerScopeKey: activeServerAccountScope
                ? serverAccountScopeKeySuffix(activeServerAccountScope)
                : null,
            presentation: externalSessionOperationPresentation,
            serverId: sessionServerId,
            sessionId: props.session.id,
        });
    const {
        dismissal: externalSessionOperationDismissal,
        onDismiss: onDismissExternalSessionOperation,
    } = useExternalSessionOperationTranscriptDismissal({
        sessionId: props.session.id,
        presentation: externalSessionOperationPresentation,
    });

    const groupingMode = transcriptGroupingMode === 'turns' ? 'turns' : 'linear';
    const groupToolCalls =
        transcriptGroupToolCalls === true &&
        toolViewTimelineChromeMode === 'activity_feed';
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
    const activeThinkingMessageId = useTranscriptRootThinkingState({
        latestCommittedActivityKey,
        sessionId: props.session.id,
        sessionThinking: props.session.thinking === true,
    });
    const eventEmphasisByMessageId = React.useMemo(() => (
        resolveTranscriptEventEmphasisByMessageId({
            messageIdsOldestFirst,
            messagesById,
            sessionActive: props.session.active === true,
        })
    ), [messageIdsOldestFirst, messagesById, props.session.active]);

    const interaction = React.useMemo(() => {
        return deriveTranscriptInteractionFromSession({
            accessLevel: props.session.accessLevel,
            canApprovePermissions: props.session.canApprovePermissions,
            active: props.session.active,
            presence: props.session.presence,
        });
    }, [props.session.accessLevel, props.session.canApprovePermissions, props.session.active, props.session.presence]);
    // Whole-message Actions consume the generic normalized daemon projection,
    // but only while this transcript's existing local-owner projection remains
    // current. The generation agreement prevents an Action catalog refresh from
    // borrowing a now-stale transcript lifecycle snapshot.
    const pluginMessageActionProjection = useDaemonMergedProjectionInputs({
        machineId: pluginActivityProjection.machineId,
        serverId: pluginActivityProjection.serverId,
        enabled: isExactOwner && pluginActivityProjection.interactionEnabled,
        staleMs: 60_000,
    });
    const pluginMessageActionSnapshotRef = React.useRef<PluginContributedActionCurrentSnapshot | null>(null);
    const pluginMessageActionScope = React.useMemo(
        () => new AbortController(),
        [
            isExactOwner,
            interaction.canSendMessages,
            pluginActivityLifetime,
            pluginActivityProjection.interactionEnabled,
            pluginActivityProjection.machineId,
            pluginActivityProjection.serverId,
            pluginActivityProjection.pluginUiProjection?.generation,
            pluginMessageActionProjection.inputs?.pluginProjectionById,
            pluginMessageActionProjection.inputs?.pluginProjectionV2?.generation,
            pluginMessageActionProjection.phase,
            props.session.id,
        ],
    );
    React.useEffect(() => () => pluginMessageActionScope.abort(), [pluginMessageActionScope]);
    const pluginMessageActionSnapshot = React.useMemo<PluginContributedActionCurrentSnapshot | null>(() => {
        const inputs = pluginMessageActionProjection.inputs;
        const lifecycleGeneration = pluginActivityProjection.pluginUiProjection?.generation;
        const actionGeneration = inputs?.pluginProjectionV2?.generation;
        if (
            !isExactOwner
            || interaction.canSendMessages !== true
            || pluginActivityProjection.interactionEnabled !== true
            || pluginMessageActionProjection.phase !== 'ready'
            || !inputs
            || lifecycleGeneration == null
            || actionGeneration == null
            || String(lifecycleGeneration) !== String(actionGeneration)
        ) {
            return null;
        }
        let snapshot!: PluginContributedActionCurrentSnapshot;
        snapshot = {
            pluginProjectionById: inputs.pluginProjectionById,
            pluginUiProjection: pluginActivityProjection.pluginUiProjection,
            resolveContributedAction: createPluginUiProjectedActionResolver(
                inputs.pluginProjectionV2?.actionsById,
            ),
            host: {
                machineId: pluginActivityProjection.machineId,
                serverId: pluginActivityProjection.serverId,
                expectedGeneration: actionGeneration,
                sessionId: props.session.id,
                signal: pluginMessageActionScope.signal,
                accountLifetime: pluginActivityLifetime,
                ...(currentUiContextReader
                    ? { readCurrentUiContext: currentUiContextReader.readCurrentUiContext }
                    : {}),
                isCurrent: () => pluginMessageActionSnapshotRef.current === snapshot,
            },
        };
        return snapshot;
    }, [
        interaction.canSendMessages,
        isExactOwner,
        currentUiContextReader,
        pluginActivityLifetime,
        pluginActivityProjection.interactionEnabled,
        pluginActivityProjection.machineId,
        pluginActivityProjection.pluginUiProjection?.generation,
        pluginActivityProjection.serverId,
        pluginMessageActionProjection.inputs,
        pluginMessageActionProjection.phase,
        pluginMessageActionScope,
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
    ), [clientExecutableRegistrationRevision, pluginMessageActionSnapshot]);
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
        actionDrafts,
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
    ), [pluginMessageActionScope, pluginMessageActionSnapshot, props.session.id]);
    const internalMessagesById = forkedTranscriptEnabled ? messagesById : EMPTY_MESSAGES_BY_ID;

    return {
        boundary: {
            eligibleMessageIdsInOrder: messageIdsOldestFirst,
            key: props.session.id,
            sessionId: props.session.id,
            selectionEnabled: transcriptSessionCommon.messageDisplay.transcriptMessageSelectionEnabled === true,
        },
        pluginMessageActionHost,
        internalProps: {
            metadata: stableSessionMetadata,
            sessionId: props.session.id,
            sessionActive: props.session.active === true,
            sessionThinking: props.session.thinking === true,
            groupingMode,
            forkedTranscriptEnabled,
            items: groupedItems,
            maxTurnEntriesPerListItem: transcriptMaxTurnEntriesPerListItem,
            transcriptNavigationEntries,
            messagePins: sessionMessagePins,
            onToggleMessagePin: togglePersistedSessionMessagePin,
            messagesById: internalMessagesById,
            eventEmphasisByMessageId,
            forkMessageMetadataById: forkAwareMessageDescriptors?.metadataByMessageId ?? null,
            committedMessagesCount: messageIdsOldestFirst.length,
            latestCommittedActivityKey,
            activeThinkingMessageId,
            rollbackRanges,
            rollbackActionsByMessageId,
            isLoaded,
            bottomNotice: props.bottomNotice,
            controlledByUserOverride: props.controlledByUserOverride,
            controlSwitchTo: props.controlSwitchTo ?? null,
            onRequestSwitchToRemote: props.onRequestSwitchToRemote,
            externalControlFooter: props.externalControlFooter,
            approvalRequests: props.approvalRequests,
            interaction,
            jumpToSeq: props.jumpToSeq ?? null,
            followBottomIntentKey: props.followBottomIntentKey ?? null,
            onJumpLanded: props.onJumpLanded,
            onViewportChange: props.onViewportChange,
            onEditPendingMessage: props.onEditPendingMessage,
            onDismissExternalSessionOperation,
            onDismissPluginTranscriptActivity,
            onOpenPluginTranscriptActivityAction,
            onExternalSessionOperationActionResult:
                externalSessionOperationOwnerHydration.onActionResult,
            externalSessionOperationOwnerTarget,
            isWarmKeepAliveInstance: props.isWarmKeepAliveInstance === true,
            routeHydrationPending: props.routeHydrationPending === true,
            forkCommon: transcriptSessionCommon.fork,
            messageDisplayCommon: transcriptSessionCommon.messageDisplay,
            toolChromeCommon: transcriptSessionCommon.toolChrome,
            toolRouteCommon: transcriptSessionCommon.toolRoute,
        } satisfies ChatListInternalProps,
    };
}

export function requestSessionOpenInitialFill(): void {
    fireAndForget(preloadEnrichedMarkdownRuntime(), { tag: 'ChatList.preloadEnrichedMarkdownRuntime' });
}
