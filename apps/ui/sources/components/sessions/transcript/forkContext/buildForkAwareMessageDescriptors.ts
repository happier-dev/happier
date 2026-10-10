import type { Message } from "@happier-dev/session-core/messages";
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import { SessionForkVisualOriginV1Schema, type SessionForkVisualContextV1 } from '@happier-dev/protocol/sessions/board/forkVisualCopies';

export type ForkAwareMessageMetadata = Readonly<{
    messageId: string;
    originSessionId: string;
    isReadOnlyContext: boolean;
    segmentIndex: number;
    hasForkBoundaryBefore: boolean;
    visualContext?: SessionForkVisualContextV1;
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
    const visualContext = fork.visualSessionId ? { sessionId: fork.visualSessionId, copies: fork.visualCopies ?? [] } : undefined;

    for (let segmentIndex = 0; segmentIndex < fork.segments.length; segmentIndex += 1) {
        const segment = fork.segments[segmentIndex]!;
        const firstMessageId = segment.messageIdsOldestFirst[0] ?? null;
        if (segmentIndex > 0 && firstMessageId) {
            forkBoundaryBeforeMessageIds.add(firstMessageId);
        }

        for (const messageId of segment.messageIdsOldestFirst) {
            const origin = fork.messageOriginById[messageId];
            const visualOrigin = SessionForkVisualOriginV1Schema.safeParse(fork.combinedMessagesById[messageId]?.meta?.forkVisualOriginV1);
            const messageVisualContext = visualContext && visualOrigin.success ? { ...visualContext,
                originAddress: { serverId: visualOrigin.data.serverId, sessionId: visualOrigin.data.sessionId } } : visualContext;
            metadataByMessageId[messageId] = {
                messageId,
                originSessionId: origin?.sessionId ?? segment.sessionId,
                isReadOnlyContext: origin?.isReadOnlyContext ?? segment.isReadOnlyContext,
                segmentIndex,
                hasForkBoundaryBefore: firstMessageId === messageId && segmentIndex > 0,
                ...((origin?.isReadOnlyContext ?? segment.isReadOnlyContext) && messageVisualContext ? { visualContext: messageVisualContext } : {}),
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
