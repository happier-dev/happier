import type { Message } from '@/sync/domains/messages/messageTypes';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';

export type ForkAwareMessageMetadata = Readonly<{
    messageId: string;
    originSessionId: string;
    isReadOnlyContext: boolean;
    segmentIndex: number;
    hasForkBoundaryBefore: boolean;
}>;

export type ForkAwareMessageDescriptors = Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    metadataByMessageId: Readonly<Record<string, ForkAwareMessageMetadata>>;
    forkBoundaryBeforeMessageIds: ReadonlySet<string>;
    forkBoundarySignature: string;
}>;

export function buildForkAwareMessageDescriptors(fork: ForkedTranscriptSnapshot): ForkAwareMessageDescriptors {
    const forkBoundaryBeforeMessageIds = new Set<string>();
    const metadataByMessageId: Record<string, ForkAwareMessageMetadata> = {};

    for (let segmentIndex = 0; segmentIndex < fork.segments.length; segmentIndex += 1) {
        const segment = fork.segments[segmentIndex]!;
        const firstMessageId = segment.messageIdsOldestFirst[0] ?? null;
        if (segmentIndex > 0 && firstMessageId) {
            forkBoundaryBeforeMessageIds.add(firstMessageId);
        }

        for (const messageId of segment.messageIdsOldestFirst) {
            const origin = fork.messageOriginById[messageId];
            metadataByMessageId[messageId] = {
                messageId,
                originSessionId: origin?.sessionId ?? segment.sessionId,
                isReadOnlyContext: origin?.isReadOnlyContext ?? segment.isReadOnlyContext,
                segmentIndex,
                hasForkBoundaryBefore: firstMessageId === messageId && segmentIndex > 0,
            };
        }
    }

    return {
        messageIdsOldestFirst: fork.combinedMessageIdsOldestFirst,
        messagesById: fork.combinedMessagesById,
        metadataByMessageId,
        forkBoundaryBeforeMessageIds,
        forkBoundarySignature: [...forkBoundaryBeforeMessageIds].join('|'),
    };
}
