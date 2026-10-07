import { extractCanonicalDiffFiles, readTurnChangeToolMetadataFromToolCall, type TurnChangeToolMetadata } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import type { FileChangeEvidence, TurnChangeSet } from '@happier-dev/protocol/sessions/changes/types';
import { deriveCanonicalPatchFileDiffs } from '@happier-dev/protocol/tools/v2';

import type { Message } from '@happier-dev/session-core/messages';

type TurnChangeSetCandidate = Readonly<{
    kind: 'diff' | 'patch';
    messageIndex: number;
    changeSet: TurnChangeSet;
}>;

type TurnChangeSetGroup = {
    diff: TurnChangeSet | null;
    diffIndex: number;
    patch: TurnChangeSet | null;
    patchIndex: number;
};

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

function extractCanonicalPatchFiles(input: unknown, metadata: TurnChangeToolMetadata, messageId: string): FileChangeEvidence[] {
    return deriveCanonicalPatchFileDiffs(input).map((file) => ({
        filePath: file.filePath,
        previousFilePath: file.previousFilePath ?? null,
        changeKind: file.changeKind,
        unifiedDiff: file.unifiedDiff,
        oldText: file.oldText,
        newText: file.newText,
        source: metadata.source,
        confidence: metadata.confidence,
        provider: metadata.provider,
        providerMessageId: messageId,
    }));
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

function buildCandidate(message: Extract<Message, { kind: 'tool-call' }>, messageIndex: number): TurnChangeSetCandidate | null {
    const name = message.tool?.name;
    if (name !== 'Diff' && name !== 'Patch') return null;

    const metadata = readTurnChangeToolMetadataFromToolCall(message.tool);
    if (!metadata) return null;

    const files = name === 'Diff'
        ? extractCanonicalDiffFiles(message.tool.input, metadata)
        : extractCanonicalPatchFiles(message.tool.input, metadata, message.id);
    if (files.length === 0 && !metadata.repositoryCheckpoint) return null;

    return {
        kind: name === 'Diff' ? 'diff' : 'patch',
        messageIndex,
        changeSet: {
            sessionId: metadata.sessionId,
            turnId: metadata.turnId,
            seqRange: metadata.seqRange,
            status: metadata.turnStatus,
            files,
            provider: metadata.provider,
            derivedAt: message.createdAt,
            ...(metadata.repositoryCheckpoint ? { repositoryCheckpoint: metadata.repositoryCheckpoint } : {}),
        },
    };
}

function mergePatchChangeSet(current: TurnChangeSet | null, next: TurnChangeSet): TurnChangeSet {
    return current ? reconcileTurnChangeSet(current, next) : next;
}

export function deriveTurnChangeSetsFromMessages(messages: readonly Message[]): TurnChangeSet[] {
    const groups = new Map<string, TurnChangeSetGroup>();

    messages.forEach((message, messageIndex) => {
        if (message.kind !== 'tool-call') return;
        const candidate = buildCandidate(message, messageIndex);
        if (!candidate) return;

        const group = groups.get(candidate.changeSet.turnId) ?? {
            diff: null,
            diffIndex: Number.MAX_SAFE_INTEGER,
            patch: null,
            patchIndex: Number.MAX_SAFE_INTEGER,
        };

        if (candidate.kind === 'diff') {
            group.diff = group.diff ? reconcileTurnChangeSet(group.diff, candidate.changeSet) : candidate.changeSet;
            group.diffIndex = Math.min(group.diffIndex, messageIndex);
        } else {
            group.patch = mergePatchChangeSet(group.patch, candidate.changeSet);
            group.patchIndex = Math.min(group.patchIndex, messageIndex);
        }

        groups.set(candidate.changeSet.turnId, group);
    });

    return [...groups.values()]
        .flatMap((group): TurnChangeSetCandidate[] => {
            if (group.diff) {
                return [{ kind: 'diff', messageIndex: group.diffIndex, changeSet: group.diff }];
            }
            if (!group.patch) return [];
            return [{ kind: 'patch', messageIndex: group.patchIndex, changeSet: group.patch }];
        })
        .sort((left, right) => left.messageIndex - right.messageIndex)
        .map((candidate) => candidate.changeSet);
}
