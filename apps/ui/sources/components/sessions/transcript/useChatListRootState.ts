import * as React from 'react';
import { isRecoveredHistoryTranscriptObservationProvenance } from '@happier-dev/protocol';
import {
    useSessionActionDrafts,
    useSessionPendingMessages,
    useSetting,
} from '@/sync/domains/state/storage';
import { buildSessionMetadataStabilitySignatureValue, buildStableJsonSignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
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
import { useStableValueBySignature } from '@/hooks/ui/useStableValueBySignature';
import { preloadEnrichedMarkdownRuntime } from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import { useTranscriptRootDerivedItems } from '@/components/sessions/transcript/items/useTranscriptRootDerivedItems';
import { useTranscriptRootNavigationState } from '@/components/sessions/transcript/navigation/useTranscriptRootNavigationState';
import { useTranscriptRootPendingRequests } from '@/components/sessions/transcript/items/useTranscriptRootPendingRequests';
import { useTranscriptRootRollbackActions } from '@/components/sessions/transcript/items/useTranscriptRootRollbackActions';
import { useTranscriptRootThinkingState } from '@/components/sessions/transcript/thinking/useTranscriptRootThinkingState';
import { useTranscriptRootMessages } from '@/components/sessions/transcript/items/useTranscriptRootMessages';
import { resolveTranscriptEventEmphasisByMessageId } from '@/components/sessions/transcript/events/transcriptEventEmphasis';
import type { Message } from '@/sync/domains/messages/messageTypes';

export function resolveLatestCommittedActivityKey(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): string | null {
    for (let index = params.messageIdsOldestFirst.length - 1; index >= 0; index -= 1) {
        const id = params.messageIdsOldestFirst[index]!;
        const message = params.messagesById[id];
        // A temporarily unavailable message retains the legacy live behavior. Only authenticated,
        // explicit recovered-history provenance is allowed to suppress tail activity.
        if (
            !message
            || !isRecoveredHistoryTranscriptObservationProvenance(message.transcriptObservationProvenance)
        ) return id;
    }
    return null;
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
    const sessionMetadataSignature = React.useMemo(
        () => buildStableJsonSignature(buildSessionMetadataStabilitySignatureValue(props.session.metadata ?? null)),
        [props.session.metadata],
    );
    const stableSessionMetadata = useStableValueBySignature(props.session.metadata, sessionMetadataSignature);

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
            directControlFooter: props.directControlFooter,
            approvalRequests: props.approvalRequests,
            interaction,
            jumpToSeq: props.jumpToSeq ?? null,
            followBottomIntentKey: props.followBottomIntentKey ?? null,
            onJumpLanded: props.onJumpLanded,
            onViewportChange: props.onViewportChange,
            onEditPendingMessage: props.onEditPendingMessage,
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
