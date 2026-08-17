import * as React from 'react';
import { buildChatListItems, buildChatListItemsCached } from '@/components/sessions/chatListItems';
import { insertForkDividersIntoTranscriptItems, type ForkDividerTranscriptItem } from '@/components/sessions/transcript/forkContext/insertForkDividersIntoTranscriptItems';
import { sync } from '@/sync/sync';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { buildTranscriptTurnsCached } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { ForkAwareMessageDescriptors } from '@/components/sessions/transcript/forkContext/buildForkAwareMessageDescriptors';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import type {
    ExternalSessionOperationProgressV1,
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';
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
    actionDrafts: NonNullable<BuildChatListItemsOptions['actionDrafts']>;
    discardedPendingMessages: NonNullable<BuildChatListItemsOptions['discardedMessages']>;
    fork: ForkedTranscriptSnapshot | null;
    forkAwareMessageDescriptors: ForkAwareMessageDescriptors | null;
    forkedTranscriptEnabled: boolean;
    groupToolCalls: boolean;
    groupingMode: 'linear' | 'turns';
    messageIdsOldestFirst: string[];
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
    toolCallsGroupStrategy: 'all_tools_in_turn' | 'consecutive_tools';
}>) {
    const {
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
        externalSessionOperationPresentation,
        externalSessionOperationProgress,
        externalSessionOperationDismissal,
        pluginTranscriptActivities,
        dismissedPluginTranscriptActivityIds,
        isPluginTranscriptActivityActionAvailable,
        sessionId,
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
    const turnsCache = React.useMemo(() => {
        if (groupingMode !== 'turns') return null;
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
        groupingMode,
        messageIdsOldestFirst,
        messagesById,
        pendingMessages,
        toolCallsGroupStrategy,
    ]);

    React.useEffect(() => {
        if (groupingMode !== 'turns' || !turnsCache) return;
        writeTranscriptDerivedItemsCacheEntry(sessionId, derivedItemsCacheMaxSessions, {
            turnsCache,
        });
    }, [derivedItemsCacheMaxSessions, groupingMode, sessionId, turnsCache]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.linearItems', () => ({
            actionDraftCount: actionDrafts.length,
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
                actionDrafts,
                groupConsecutiveToolCalls: groupToolCalls,
                forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
                forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
                forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
            });
        });
    }, [
        actionDrafts,
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

    const groupedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        return measureTranscriptDerivation('ui.sessions.transcript.derived.groupedItems', () => ({
            actionDraftCount: actionDrafts.length,
            forked: forkedTranscriptEnabled && fork ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            modeTurns: groupingMode === 'turns' ? 1 : 0,
            pendingCount: pendingMessages.length + (discardedPendingMessages?.length ?? 0),
            pendingUserActionCount: pendingUserActionRequests.length,
        }), () => {
            if (groupingMode !== 'turns') {
                const base = linearCache?.items ?? buildChatListItems({
                    messageIdsOldestFirst,
                    messagesById,
                    pendingMessages,
                    discardedMessages: discardedPendingMessages,
                    pendingUserActionRequests,
                    actionDrafts,
                });
                const withForkDividers = !forkedTranscriptEnabled || !fork
                    ? base
                    : insertForkDividersIntoTranscriptItems({ items: base, fork });
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

            const trailing = buildChatListItems({
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                pendingUserActionRequests,
                actionDrafts,
                includeCommittedMessages: false,
            });

            const turns = turnsCache?.turns ?? [];
            const turnItems: ForkDividerTranscriptItem[] = turns.map((t) => ({ kind: 'turn', id: t.id, turn: t }));
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
            const base: ForkDividerTranscriptItem[] = [...turnItems, ...trailing, ...operationItems];
            const withForkDividers = !forkedTranscriptEnabled || !fork
                ? base
                : insertForkDividersIntoTranscriptItems({ items: base, fork }) as ChatTranscriptListItem[];
            return appendPluginTranscriptActivityTranscriptItems(withForkDividers, {
                sessionId,
                activities: pluginTranscriptActivities,
                dismissedActivityIds: dismissedPluginTranscriptActivityIds,
                isActionAvailable: isPluginTranscriptActivityActionAvailable,
                cache: pluginTranscriptActivityItemsCacheRef.current,
            });
        });
    }, [
        actionDrafts,
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
    ]);

    return {
        groupedItems,
        transcriptMaxTurnEntriesPerListItem,
    };
}
