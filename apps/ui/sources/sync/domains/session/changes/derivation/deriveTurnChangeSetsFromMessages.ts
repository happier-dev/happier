import type { TurnChangeSet } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { extractCanonicalDiffFiles } from '../parsing/extractCanonicalDiffFiles';
import { readTurnChangeToolMetadataFromToolCall } from '../parsing/readTurnChangeToolMetadata';

function mergeSeqRange(left: TurnChangeSet['seqRange'], right: TurnChangeSet['seqRange']): TurnChangeSet['seqRange'] {
    const leftIsSynthetic = left.startSeqInclusive === 0 && left.endSeqInclusive === 0;
    const rightIsSynthetic = right.startSeqInclusive === 0 && right.endSeqInclusive === 0;
    if (leftIsSynthetic && !rightIsSynthetic) return right;
    if (rightIsSynthetic && !leftIsSynthetic) return left;
    return {
        startSeqInclusive: Math.min(left.startSeqInclusive, right.startSeqInclusive),
        endSeqInclusive: Math.max(left.endSeqInclusive, right.endSeqInclusive),
    };
}

function reconcileTurnChangeSet(existing: TurnChangeSet, next: TurnChangeSet): TurnChangeSet {
    return {
        ...existing,
        seqRange: mergeSeqRange(existing.seqRange, next.seqRange),
        status: next.status === 'unknown' ? existing.status : next.status,
        files: [...existing.files, ...next.files],
        derivedAt: Math.max(existing.derivedAt, next.derivedAt),
        ...(next.repositoryCheckpoint ? { repositoryCheckpoint: next.repositoryCheckpoint } : {}),
    };
}

export function deriveTurnChangeSetsFromMessages(messages: readonly Message[]): TurnChangeSet[] {
    const turns = messages
        .filter((message): message is Extract<Message, { kind: 'tool-call' }> => message.kind === 'tool-call')
        .filter((message) => message.tool?.name === 'Diff')
        .flatMap((message) => {
            const metadata = readTurnChangeToolMetadataFromToolCall(message.tool);
            if (!metadata) return [];
            return [{
                sessionId: metadata.sessionId,
                turnId: metadata.turnId,
                seqRange: metadata.seqRange,
                status: metadata.turnStatus,
                files: extractCanonicalDiffFiles(message.tool.input, metadata),
                provider: metadata.provider,
                derivedAt: message.createdAt,
                ...(metadata.repositoryCheckpoint ? { repositoryCheckpoint: metadata.repositoryCheckpoint } : {}),
            } satisfies TurnChangeSet];
        });

    const reconciledTurns: TurnChangeSet[] = [];
    const indexByTurnId = new Map<string, number>();
    for (const turn of turns) {
        const existingIndex = indexByTurnId.get(turn.turnId);
        if (existingIndex === undefined) {
            indexByTurnId.set(turn.turnId, reconciledTurns.length);
            reconciledTurns.push(turn);
            continue;
        }
        const existing = reconciledTurns[existingIndex];
        if (!existing) continue;
        reconciledTurns[existingIndex] = reconcileTurnChangeSet(existing, turn);
    }
    return reconciledTurns;
}
