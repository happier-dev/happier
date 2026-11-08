import * as React from 'react';
import { buildChatListItems, buildChatListItemsCached } from '@/components/sessions/chatListItems';
import { projectPendingTranscriptItems } from './projectPendingTranscriptItems';
import { insertForkDividersIntoTranscriptItems, type ForkDividerTranscriptItem } from '@/components/sessions/transcript/forkContext/insertForkDividersIntoTranscriptItems';
import { sync } from '@/sync/sync';
import type { Message } from "@happier-dev/session-core/messages";
import { buildTranscriptTurnsCached } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import {
    foldWorkflowOriginRuns,
    groupWorkflowTranscriptTurns,
    readWorkflowOriginRunMembership,
    readWorkflowTurnProvenance,
} from '@/components/sessions/transcript/turnGrouping/workflowTranscriptTurns';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { ForkAwareMessageDescriptors } from '@/components/sessions/transcript/forkContext/buildForkAwareMessageDescriptors';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import type {
    ExternalSessionOperationProgressV1,
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol/sessions/external/operationV1';
import {
    measureTranscriptDerivation,
} from '@/components/sessions/transcript/items/measureDerivation';
import {
    readTranscriptDerivedItemsCacheEntry,
    resolveTranscriptDerivedItemsCacheMaxSessions,
    writeTranscriptDerivedItemsCacheEntry,
} from '@/components/sessions/transcript/items/derivedItemsCache';
import {
    appendExternalSessionOperationTranscriptItem,
    type ExternalSessionOperationTranscriptDismissal,
} from '@/components/sessions/transcript/items/externalSessionOperationTranscriptItem';
import {
    appendPluginTranscriptActivityTranscriptItems,
    createPluginTranscriptActivityTranscriptItemsCache,
    type PluginTranscriptActivityLiveRow,
} from '@/components/sessions/transcript/items/pluginTranscriptActivityTranscriptItem';

type BuildChatListItemsOptions = Parameters<typeof buildChatListItems>[0];

export function useTranscriptRootDerivedItems(params: Readonly<{
    discardedPendingMessages: NonNullable<BuildChatListItemsOptions['discardedMessages']>;
    fork: ForkedTranscriptSnapshot | null;
    forkAwareMessageDescriptors: ForkAwareMessageDescriptors | null;
    forkedTranscriptEnabled: boolean;
    groupToolCalls: boolean;
    groupingMode: 'linear' | 'turns';
    messageIdsOldestFirst: readonly string[];
    messagesById: Record<string, Message>;
    pendingMessages: BuildChatListItemsOptions['pendingMessages'];
    pendingUserActionRequests: NonNullable<BuildChatListItemsOptions['pendingUserActionRequests']>;
    externalSessionOperationPresentation:
        ExternalSessionOperationSharedPresentationV1 | null;
    externalSessionOperationProgress: ExternalSessionOperationProgressV1 | null;
    externalSessionOperationDismissal: ExternalSessionOperationTranscriptDismissal | null;
    pluginTranscriptActivities: readonly PluginTranscriptActivityLiveRow[];
    dismissedPluginTranscriptActivityIds: ReadonlySet<string>;
    isPluginTranscriptActivityActionAvailable: (
        action: Readonly<{ pluginId: string; localId: string }>,
    ) => boolean;
    sessionId: string;
    /** The Session's turn facts; origin-input workflow turns fold into one row per run. */
    sessionTurns: readonly SessionTurnV1[] | null;
    /** The Session's origin Runs; a turn-end firing that wrote no turn folds where it fired. */
    triggerRuns: readonly WorkflowRunSummaryV1[];
    toolCallsGroupStrategy: 'all_tools_in_turn' | 'consecutive_tools';
}>) {
    const {
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
        externalSessionOperationPresentation,
        externalSessionOperationProgress,
        externalSessionOperationDismissal,
        pluginTranscriptActivities,
        dismissedPluginTranscriptActivityIds,
        isPluginTranscriptActivityActionAvailable,
        sessionId,
        sessionTurns,
        triggerRuns,
        toolCallsGroupStrategy,
    } = params;
    const syncTuning = sync.getSyncTuning();
    const derivedItemsCacheMaxSessions = resolveTranscriptDerivedItemsCacheMaxSessions(
        syncTuning.transcriptDerivedItemsCacheMaxSessions,
    );
    const transcriptMaxTurnEntriesPerListItem = syncTuning.transcriptMaxTurnEntriesPerListItem;
    // Activity cards are an ephemeral tail. Keep their identity only for this
    // mounted derivation, never in the cross-session derived-items cache.
    const pluginTranscriptActivityItemsCacheRef = React.useRef(
        createPluginTranscriptActivityTranscriptItemsCache(),
    );
    const derivedItemsCacheEntry = readTranscriptDerivedItemsCacheEntry(
        sessionId,
        derivedItemsCacheMaxSessions,
    );
    const needsTurns = React.useMemo(() => groupingMode === 'turns'
        || messageIdsOldestFirst.some((id) => readWorkflowTurnProvenance(messagesById[id]) !== null),
    [groupingMode, messageIdsOldestFirst, messagesById]);
    const turnsCache = React.useMemo(() => {
        if (!needsTurns) return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.turns', () => ({
            cacheProvided: derivedItemsCacheEntry.turnsCache ? 1 : 0,
            forked: forkAwareMessageDescriptors ? 1 : 0,
            groupToolCalls: groupToolCalls ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
        }), () => {
            return buildTranscriptTurnsCached({
                cache: derivedItemsCacheEntry.turnsCache,
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                groupToolCalls,
                toolCallsGroupStrategy,
                forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
                forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
                forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
            });
        });
    }, [
        derivedItemsCacheEntry.turnsCache,
        discardedPendingMessages,
        forkAwareMessageDescriptors,
        groupToolCalls,
        needsTurns,
        messageIdsOldestFirst,
        messagesById,
        pendingMessages,
        toolCallsGroupStrategy,
    ]);

    React.useEffect(() => {
        if (!turnsCache) return;
        writeTranscriptDerivedItemsCacheEntry(sessionId, derivedItemsCacheMaxSessions, {
            turnsCache,
        });
    }, [derivedItemsCacheMaxSessions, sessionId, turnsCache]);

    const forkMetadataByMessageId = forkAwareMessageDescriptors?.metadataByMessageId;
    const workflowOriginRunMembership = React.useMemo(() => readWorkflowOriginRunMembership({
        sessionId,
        sessionTurns,
        triggerRuns,
        messageIdsOldestFirst,
        getMessageById: (id) => messagesById[id] ?? null,
        isOwnMessage: forkMetadataByMessageId
            ? (id) => (forkMetadataByMessageId[id]?.originSessionId ?? sessionId) === sessionId
            : undefined,
    }), [forkMetadataByMessageId, messageIdsOldestFirst, messagesById, sessionId, sessionTurns, triggerRuns]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.linearItems', () => ({
            cacheProvided: derivedItemsCacheEntry.linearItemsCache ? 1 : 0,
            discardedPendingCount: discardedPendingMessages?.length ?? 0,
            forked: forkAwareMessageDescriptors ? 1 : 0,
            groupToolCalls: groupToolCalls ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            pendingCount: pendingMessages.length,
            pendingUserActionCount: pendingUserActionRequests.length,
        }), () => {
            return buildChatListItemsCached({
                cache: derivedItemsCacheEntry.linearItemsCache,
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                pendingUserActionRequests,
                groupConsecutiveToolCalls: groupToolCalls,
                forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
                forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
                forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
            });
        });
    }, [
        derivedItemsCacheEntry.linearItemsCache,
        discardedPendingMessages,
        forkAwareMessageDescriptors,
        groupToolCalls,
        groupingMode,
        messageIdsOldestFirst,
        messagesById,
        pendingMessages,
        pendingUserActionRequests,
    ]);

    React.useEffect(() => {
        if (groupingMode === 'turns' || !linearCache) return;
        writeTranscriptDerivedItemsCacheEntry(sessionId, derivedItemsCacheMaxSessions, {
            linearItemsCache: linearCache.cache,
        });
    }, [derivedItemsCacheMaxSessions, groupingMode, linearCache, sessionId]);

    const turnItems = React.useMemo(() => groupingMode !== 'turns' ? [] : foldWorkflowOriginRuns(
        projectPendingTranscriptItems({
            items: (turnsCache?.turns ?? []).map((turn) => ({ kind: 'turn' as const, id: turn.id, turn })),
            messageIdsOldestFirst,
            messagesById,
            pendingMessages,
            discardedMessages: discardedPendingMessages,
            pendingUserActionRequests,
        }),
        workflowOriginRunMembership,
    ) as ForkDividerTranscriptItem[], [discardedPendingMessages, groupingMode, messageIdsOldestFirst, messagesById, pendingMessages, pendingUserActionRequests, turnsCache?.turns, workflowOriginRunMembership]);

    const groupedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        return measureTranscriptDerivation('ui.sessions.transcript.derived.groupedItems', () => ({
            forked: forkedTranscriptEnabled && fork ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            modeTurns: groupingMode === 'turns' ? 1 : 0,
            pendingCount: pendingMessages.length + (discardedPendingMessages?.length ?? 0),
            pendingUserActionCount: pendingUserActionRequests.length,
        }), () => {
            if (groupingMode !== 'turns') {
                const linearItems = linearCache?.items ?? buildChatListItems({
                    messageIdsOldestFirst,
                    messagesById,
                    pendingMessages,
                    discardedMessages: discardedPendingMessages,
                    pendingUserActionRequests,
                });
                const base = foldWorkflowOriginRuns(
                    turnsCache ? groupWorkflowTranscriptTurns(linearItems, turnsCache.turns, (id) => messagesById[id] ?? null) : linearItems,
                    workflowOriginRunMembership,
                );
                const withForkDividers = !forkedTranscriptEnabled || !fork
                    ? base
                    : insertForkDividersIntoTranscriptItems({ items: base, fork, sourceWindowComplete: true });
                const withExternalOperation = appendExternalSessionOperationTranscriptItem(
                    withForkDividers,
                    {
                        presentation: externalSessionOperationPresentation,
                        progress: externalSessionOperationProgress,
                    },
                    {
                        sessionId,
                        dismissed: externalSessionOperationDismissal,
                    },
                );
                return appendPluginTranscriptActivityTranscriptItems(withExternalOperation, {
                    sessionId,
                    activities: pluginTranscriptActivities,
                    dismissedActivityIds: dismissedPluginTranscriptActivityIds,
                    isActionAvailable: isPluginTranscriptActivityActionAvailable,
                    cache: pluginTranscriptActivityItemsCacheRef.current,
                });
            }

            const operationItems = appendExternalSessionOperationTranscriptItem(
                [],
                {
                    presentation: externalSessionOperationPresentation,
                    progress: externalSessionOperationProgress,
                },
                {
                    sessionId,
                    dismissed: externalSessionOperationDismissal,
                },
            ) as ForkDividerTranscriptItem[];
            const base: ForkDividerTranscriptItem[] = operationItems.length === 0
                ? turnItems : [...turnItems, ...operationItems];
            const withForkDividers = !forkedTranscriptEnabled || !fork
                ? base
                : insertForkDividersIntoTranscriptItems({ items: base, fork, sourceWindowComplete: true }) as ChatTranscriptListItem[];
            return appendPluginTranscriptActivityTranscriptItems(withForkDividers, {
                sessionId,
                activities: pluginTranscriptActivities,
                dismissedActivityIds: dismissedPluginTranscriptActivityIds,
                isActionAvailable: isPluginTranscriptActivityActionAvailable,
                cache: pluginTranscriptActivityItemsCacheRef.current,
            });
        });
    }, [
        discardedPendingMessages,
        externalSessionOperationDismissal,
        externalSessionOperationPresentation,
        externalSessionOperationProgress,
        fork,
        forkedTranscriptEnabled,
        groupingMode,
        linearCache,
        messageIdsOldestFirst,
        messagesById,
        pendingMessages,
        pendingUserActionRequests,
        pluginTranscriptActivities,
        dismissedPluginTranscriptActivityIds,
        isPluginTranscriptActivityActionAvailable,
        sessionId,
        turnsCache,
        turnItems,
        workflowOriginRunMembership,
    ]);

    return {
        groupedItems,
        transcriptMaxTurnEntriesPerListItem,
    };
}
