import type { TurnChangeSet } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { extractCanonicalDiffFiles } from '../parsing/extractCanonicalDiffFiles';
import { readTurnChangeToolMetadata } from '../parsing/readTurnChangeToolMetadata';

export function deriveTurnChangeSetsFromMessages(messages: readonly Message[]): TurnChangeSet[] {
    return messages
        .filter((message): message is Extract<Message, { kind: 'tool-call' }> => message.kind === 'tool-call')
        .filter((message) => message.tool?.name === 'Diff')
        .flatMap((message) => {
            const metadata = readTurnChangeToolMetadata(message.tool.input);
            if (!metadata) return [];
            return [{
                sessionId: metadata.sessionId,
                turnId: metadata.turnId,
                seqRange: metadata.seqRange,
                status: metadata.turnStatus,
                files: extractCanonicalDiffFiles(message.tool.input, metadata),
                provider: metadata.provider,
                derivedAt: message.createdAt,
            } satisfies TurnChangeSet];
        });
}
