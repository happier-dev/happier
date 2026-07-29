import {
    ChangeConfidenceSchema,
    ChangeEvidenceSourceSchema,
    FileChangeKindSchema,
    RepositoryCheckpointTurnMetadataSchema,
} from '@happier-dev/protocol';
import type { TurnChangeSet } from '@happier-dev/protocol';

import type { PendingNormalizedToolChange } from './normalizedToolChangeTypes';

function readStringField(input: Record<string, unknown>, keys: string | readonly string[]): string | null {
    const candidates = Array.isArray(keys) ? keys : [keys];
    for (const key of candidates) {
        const value = input[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return null;
}

function readEditArray(input: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
    const value = input.edits;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
}

function normalizeChangeToolName(toolName: string): string {
    const trimmed = toolName.trim();
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase();
    if (lower === 'diff') return 'Diff';
    if (lower === 'edit') return 'Edit';
    if (lower === 'write') return 'Write';
    if (lower === 'multiedit') return 'MultiEdit';
    if (lower === 'notebookedit') return 'NotebookEdit';
    return trimmed;
}

function readCanonicalDiffFiles(input: Record<string, unknown>): ReadonlyArray<Readonly<{
    filePath: string;
    previousFilePath?: string | null;
    changeKind?: TurnChangeSet['files'][number]['changeKind'];
    unifiedDiff?: string;
    oldText?: string;
    newText?: string;
    binary?: boolean;
    source?: TurnChangeSet['files'][number]['source'];
    confidence?: TurnChangeSet['files'][number]['confidence'];
    provider?: string;
    agentTurnId?: string | null;
    providerMessageId?: string | null;
    description?: string;
}>> {
    const rawFiles = input.files;
    if (!Array.isArray(rawFiles)) return [];
    return rawFiles
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .flatMap((entry) => {
            const filePath = readStringField(entry, ['file_path', 'filePath', 'path']);
            if (!filePath) return [];
            const changeKind = FileChangeKindSchema.safeParse(entry.change_kind ?? entry.changeKind).success
                ? FileChangeKindSchema.parse(entry.change_kind ?? entry.changeKind)
                : undefined;
            const source = ChangeEvidenceSourceSchema.safeParse(entry.source).success
                ? ChangeEvidenceSourceSchema.parse(entry.source)
                : undefined;
            const confidence = ChangeConfidenceSchema.safeParse(entry.confidence).success
                ? ChangeConfidenceSchema.parse(entry.confidence)
                : undefined;
            return [{
                filePath,
                previousFilePath: typeof entry.previous_file_path === 'string'
                    ? entry.previous_file_path
                    : typeof entry.previousFilePath === 'string'
                        ? entry.previousFilePath
                        : undefined,
                changeKind,
                unifiedDiff: typeof entry.unified_diff === 'string' ? entry.unified_diff : undefined,
                oldText: typeof entry.oldText === 'string' ? entry.oldText : typeof entry.old_text === 'string' ? entry.old_text : undefined,
                newText: typeof entry.newText === 'string' ? entry.newText : typeof entry.new_text === 'string' ? entry.new_text : undefined,
                binary: typeof entry.binary === 'boolean' ? entry.binary : undefined,
                source,
                confidence,
                provider: typeof entry.provider === 'string' && entry.provider.trim().length > 0 ? entry.provider : undefined,
                agentTurnId: typeof entry.provider_turn_id === 'string'
                    ? entry.provider_turn_id
                    : typeof entry.agentTurnId === 'string'
                        ? entry.agentTurnId
                        : undefined,
                providerMessageId: typeof entry.provider_message_id === 'string'
                    ? entry.provider_message_id
                    : typeof entry.providerMessageId === 'string'
                        ? entry.providerMessageId
                        : undefined,
                description: typeof entry.description === 'string' ? entry.description : undefined,
            }];
        });
}

function readHappierMetadata(input: Record<string, unknown>): Extract<PendingNormalizedToolChange, { kind: 'canonical-diff' }>['turnMetadata'] | undefined {
    const meta = input._happier && typeof input._happier === 'object'
        ? input._happier as Record<string, unknown>
        : null;
    if (!meta) return undefined;
    const repositoryCheckpointParse = RepositoryCheckpointTurnMetadataSchema.safeParse(meta.repositoryCheckpoint);
    const seqRange = meta.seqRange && typeof meta.seqRange === 'object'
        ? meta.seqRange as Record<string, unknown>
        : null;
    const startSeqInclusive = typeof seqRange?.startSeqInclusive === 'number' ? seqRange.startSeqInclusive : null;
    const endSeqInclusive = typeof seqRange?.endSeqInclusive === 'number' ? seqRange.endSeqInclusive : null;
    const status = meta.turnStatus === 'completed'
        || meta.turnStatus === 'aborted'
        || meta.turnStatus === 'interrupted'
        || meta.turnStatus === 'unknown'
        ? meta.turnStatus
        : undefined;
    const turnMetadata: Extract<PendingNormalizedToolChange, { kind: 'canonical-diff' }>['turnMetadata'] = {
        ...(typeof meta.sessionId === 'string' && meta.sessionId.trim().length > 0 ? { sessionId: meta.sessionId } : {}),
        ...(typeof meta.turnId === 'string' && meta.turnId.trim().length > 0 ? { turnId: meta.turnId } : {}),
        ...(typeof meta.provider === 'string' && meta.provider.trim().length > 0 ? { provider: meta.provider } : {}),
        ...(startSeqInclusive != null && endSeqInclusive != null ? { seqRange: { startSeqInclusive, endSeqInclusive } } : {}),
        ...(status ? { status } : {}),
        ...(repositoryCheckpointParse.success ? { repositoryCheckpoint: repositoryCheckpointParse.data } : {}),
    };
    return Object.keys(turnMetadata).length > 0 ? turnMetadata : undefined;
}

export function buildPlaceholderUnifiedDiff(filePath: string, description: string): string {
    return [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        `@@ -0,0 +0,0 @@`,
        `# ${description}`,
    ].join('\n');
}

export function derivePendingNormalizedToolChange(
    toolName: string,
    input: Record<string, unknown>,
): PendingNormalizedToolChange | null {
    const normalizedToolName = normalizeChangeToolName(toolName);

    if (normalizedToolName === 'Diff') {
        const files = readCanonicalDiffFiles(input);
        const turnMetadata = readHappierMetadata(input);
        if (files.length === 0 && !turnMetadata?.repositoryCheckpoint) return null;
        return {
            kind: 'canonical-diff',
            files,
            ...(turnMetadata ? { turnMetadata } : {}),
        };
    }

    if (normalizedToolName === 'Edit') {
        const filePath = readStringField(input, ['file_path', 'filePath', 'path']);
        const oldText = typeof input.old_string === 'string' ? input.old_string : null;
        const newText = typeof input.new_string === 'string' ? input.new_string : null;
        if (!filePath || oldText == null || newText == null) return null;
        return {
            kind: 'text-diff',
            filePath,
            oldText,
            newText,
        };
    }

    if (normalizedToolName === 'Write') {
        const filePath = readStringField(input, ['file_path', 'filePath', 'path']);
        if (!filePath) return null;
        return {
            kind: 'placeholder-diff',
            filePath,
            description: 'Write',
        };
    }

    if (normalizedToolName === 'MultiEdit') {
        const filePath = readStringField(input, ['file_path', 'filePath', 'path']);
        if (!filePath) return null;
        const edits = readEditArray(input);
        if (edits.length === 1) {
            const first = edits[0];
            const oldText = typeof first.old_string === 'string'
                ? first.old_string
                : typeof first.oldText === 'string'
                    ? first.oldText
                    : null;
            const newText = typeof first.new_string === 'string'
                ? first.new_string
                : typeof first.newText === 'string'
                    ? first.newText
                    : null;
            if (oldText != null && newText != null) {
                return {
                    kind: 'text-diff',
                    filePath,
                    oldText,
                    newText,
                    description: 'MultiEdit',
                };
            }
        }
        return {
            kind: 'placeholder-diff',
            filePath,
            description: `MultiEdit (${edits.length || 'unknown'} edits)`,
        };
    }

    if (normalizedToolName === 'NotebookEdit') {
        const filePath = readStringField(input, ['notebook_path', 'notebookPath']) ?? readStringField(input, ['file_path', 'filePath', 'path']);
        if (!filePath) return null;
        return {
            kind: 'placeholder-diff',
            filePath,
            description: 'NotebookEdit',
        };
    }

    return null;
}
