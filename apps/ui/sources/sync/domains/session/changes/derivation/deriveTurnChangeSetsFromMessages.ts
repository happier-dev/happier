import { deriveCanonicalPatchFileDiffs } from '@happier-dev/protocol/tools/v2';
import type { FileChangeEvidence, TurnChangeSet } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { extractCanonicalDiffFiles } from '../parsing/extractCanonicalDiffFiles';
import { readTurnChangeToolMetadataFromToolCall, type TurnChangeToolMetadata } from '../parsing/readTurnChangeToolMetadata';

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

function inferTextChangeKind(file: Readonly<{ oldText?: string; newText?: string }>): FileChangeEvidence['changeKind'] {
    const oldText = typeof file.oldText === 'string' ? file.oldText : '';
    const newText = typeof file.newText === 'string' ? file.newText : '';
    if (oldText.trim().length === 0 && newText.trim().length > 0) return 'added';
    if (oldText.trim().length > 0 && newText.trim().length === 0) return 'deleted';
    return 'modified';
}

function inferUnifiedDiffChangeKind(unifiedDiff: string | undefined): FileChangeEvidence['changeKind'] {
    if (!unifiedDiff) return 'modified';
    if (unifiedDiff.startsWith('new file mode ') || unifiedDiff.includes('\nnew file mode ') || unifiedDiff.includes('\n--- /dev/null')) return 'added';
    if (unifiedDiff.startsWith('deleted file mode ') || unifiedDiff.includes('\ndeleted file mode ') || unifiedDiff.includes('\n+++ /dev/null')) return 'deleted';
    if (unifiedDiff.startsWith('rename from ') || unifiedDiff.includes('\nrename from ') || unifiedDiff.includes('\nrename to ')) return 'renamed';
    return 'modified';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function firstString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function extractRawPatchDiffsByPath(input: unknown): ReadonlyMap<string, string> {
    const record = asRecord(input);
    const changes = record?.changes;
    const diffs = new Map<string, string>();

    if (Array.isArray(changes)) {
        for (const rawChange of changes) {
            const change = asRecord(rawChange);
            if (!change) continue;
            const kind = asRecord(change.kind);
            const filePath = firstString(kind?.move_path) ?? firstString(change.path) ?? firstString(change.filePath);
            const diff = firstString(change.diff) ?? firstString(change.unified_diff) ?? firstString(change.unifiedDiff);
            if (filePath && diff) diffs.set(filePath, diff);
        }
        return diffs;
    }

    const changesRecord = asRecord(changes);
    if (!changesRecord) return diffs;

    for (const [filePath, rawChange] of Object.entries(changesRecord)) {
        const change = asRecord(rawChange);
        if (!change) continue;
        const diff = firstString(change.diff) ?? firstString(change.unified_diff) ?? firstString(change.unifiedDiff);
        if (filePath.trim() && diff) diffs.set(filePath, diff);
    }

    return diffs;
}

function extractCanonicalPatchFiles(input: unknown, metadata: TurnChangeToolMetadata, messageId: string): FileChangeEvidence[] {
    const rawDiffsByPath = extractRawPatchDiffsByPath(input);
    return deriveCanonicalPatchFileDiffs(input).map((file) => ({
        filePath: file.filePath,
        changeKind: typeof file.unifiedDiff === 'string' || rawDiffsByPath.has(file.filePath)
            ? inferUnifiedDiffChangeKind(file.unifiedDiff ?? rawDiffsByPath.get(file.filePath))
            : inferTextChangeKind(file),
        unifiedDiff: file.unifiedDiff ?? rawDiffsByPath.get(file.filePath),
        oldText: file.oldText,
        newText: file.newText,
        source: metadata.source,
        confidence: metadata.confidence,
        provider: metadata.provider,
        providerTurnId: metadata.turnId,
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
    if (files.length === 0) return null;

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
