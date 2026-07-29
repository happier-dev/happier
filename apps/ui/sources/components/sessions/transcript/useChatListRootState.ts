import * as React from 'react';
import {
    useSessionActionDrafts,
    useSessionPendingMessages,
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
            presentation: externalSessionOperationPresentation,
            serverId: sessionServerId,
            sessionId: props.session.id,
        });
    const {
        dismissal: externalSessionOperationDismissal,
        onDismiss: onDismissExternalSessionOperation,
    } = useExternalSessionOperationTranscriptDismissal({
        sessionId: props.session.id,
        progress: externalSessionOperationOwnerHydration.progress,
    });

    const groupingMode = transcriptGroupingMode === 'turns' ? 'turns' : 'linear';
    const groupToolCalls =
        transcriptGroupToolCalls === true &&
        toolViewTimelineChromeMode === 'activity_feed';
    const toolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';

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
        sessionId: props.session.id,
        toolCallsGroupStrategy,
    });

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
    const internalMessagesById = forkedTranscriptEnabled ? messagesById : EMPTY_MESSAGES_BY_ID;

    return {
        boundary: {
            eligibleMessageIdsInOrder: messageIdsOldestFirst,
            key: props.session.id,
            sessionId: props.session.id,
            selectionEnabled: transcriptSessionCommon.messageDisplay.transcriptMessageSelectionEnabled === true,
        },
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
