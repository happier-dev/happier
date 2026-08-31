import * as React from 'react';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    useForkedTranscriptSnapshot,
    useSessionMessages,
    useSessionMessagesById,
    useSessionTranscriptIds,
} from '@/sync/domains/state/storage';
import { buildForkAwareMessageDescriptors } from '@/components/sessions/transcript/forkContext/buildForkAwareMessageDescriptors';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function useTranscriptRootMessages(sessionId: string) {
    const fork = useForkedTranscriptSnapshot(sessionId);
    const { ids: childMessageIdsOldestFirst, isLoaded } = useSessionTranscriptIds(sessionId);
    const childMessagesById = useSessionMessagesById(sessionId);
    const forkedTranscriptEnabled = fork != null;
    const swrFallbackCandidateEnabled = !forkedTranscriptEnabled && childMessageIdsOldestFirst.length === 0;
    const { messages: swrCommittedMessages } = useSessionMessages(sessionId, { enabled: swrFallbackCandidateEnabled });

    const swrFallbackEnabled = !forkedTranscriptEnabled
        && childMessageIdsOldestFirst.length === 0
        && swrCommittedMessages.length > 0;
    const swrFallbackMessageIdsOldestFirst = React.useMemo(() => {
        if (!swrFallbackEnabled) return childMessageIdsOldestFirst;
        return swrCommittedMessages.map((message) => message.id);
    }, [childMessageIdsOldestFirst, swrCommittedMessages, swrFallbackEnabled]);
    const swrFallbackMessagesById = React.useMemo(() => {
        if (!swrFallbackEnabled) return childMessagesById;
        const out: Record<string, Message> = {};
        for (const message of swrCommittedMessages) {
            out[message.id] = message;
        }
        return out;
    }, [childMessagesById, swrCommittedMessages, swrFallbackEnabled]);

    const forkMissingAncestorTopologyKey = React.useMemo(() => {
        if (!fork) return null;
        const ancestors = fork.segments.flatMap((seg) => {
            if (
                seg.isReadOnlyContext !== true ||
                typeof seg.cutoffSeqInclusive !== 'number' ||
                !Number.isFinite(seg.cutoffSeqInclusive) ||
                seg.cutoffSeqInclusive < 0
            ) {
                return [];
            }
            return [{
                sessionId: seg.sessionId,
                cutoffSeqInclusive: seg.cutoffSeqInclusive,
                isMissing: (seg.messageIdsOldestFirst?.length ?? 0) === 0,
            }];
        });
        if (!ancestors.some((ancestor) => ancestor.isMissing)) return null;
        return JSON.stringify(ancestors.map((ancestor) => [ancestor.sessionId, ancestor.cutoffSeqInclusive]));
    }, [fork]);

    React.useEffect(() => {
        if (forkMissingAncestorTopologyKey === null) return;
        // Wait for the child's own transcript load to settle first: the sync-side prefetch
        // gate requires every closer segment's pagination state to be RESOLVED (no more
        // older pages), and a prefetch fired before the child's initial page lands is
        // silently skipped with nothing retrying (live native S-F 2026-07-11: a fork with
        // an empty child never displayed the pre-fork parent transcript). `isLoaded`
        // flipping true re-fires this effect against the settled state.
        if (!isLoaded) return;
        fireAndForget(sync.prefetchForkedTranscriptContext(sessionId), { tag: 'ChatList.prefetchForkedTranscriptContext' });
    }, [forkMissingAncestorTopologyKey, isLoaded, sessionId]);

    const forkAwareMessageDescriptors = React.useMemo(() => {
        if (!forkedTranscriptEnabled || !fork) return null;
        return buildForkAwareMessageDescriptors(fork);
    }, [fork, forkedTranscriptEnabled]);
    const messageIdsOldestFirst = React.useMemo(() => {
        if (forkAwareMessageDescriptors) {
            return forkAwareMessageDescriptors.messageIdsOldestFirst as string[];
        }
        return swrFallbackMessageIdsOldestFirst;
    }, [forkAwareMessageDescriptors, swrFallbackMessageIdsOldestFirst]);
    const messagesById = React.useMemo(() => {
        if (forkAwareMessageDescriptors) {
            return forkAwareMessageDescriptors.messagesById as Record<string, Message>;
        }
        return swrFallbackMessagesById;
    }, [forkAwareMessageDescriptors, swrFallbackMessagesById]);

    return {
        fork,
        forkAwareMessageDescriptors,
        forkedTranscriptEnabled,
        isLoaded,
        messageIdsOldestFirst,
        messagesById,
    };
}
