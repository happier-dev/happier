import type { ChangeConfidence, ChangeEvidenceSource, FileChangeEvidence, FileChangeKind } from '@happier-dev/protocol';

import type { TurnChangeToolMetadata } from './readTurnChangeToolMetadata';

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RecordLike;
}

const FILE_CHANGE_KINDS = new Set<FileChangeKind>(['added', 'modified', 'deleted', 'renamed', 'copied', 'unknown']);
const CHANGE_SOURCES = new Set<ChangeEvidenceSource>([
    'provider_native',
    'provider_tool',
    'canonical_diff_tool',
    'canonical_patch_tool',
    'scm_checkpoint',
    'scm_reconciled',
    'inferred',
]);
const CHANGE_CONFIDENCES = new Set<ChangeConfidence>(['exact', 'strong', 'best_effort']);

function readStringField(record: RecordLike, keys: readonly string[]): string | null {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return null;
}

export function extractCanonicalDiffFiles(input: unknown, metadata: TurnChangeToolMetadata): FileChangeEvidence[] {
    const record = asRecord(input);
    const rawFiles = Array.isArray(record?.files) ? record.files : [];
    return rawFiles
        .map((file) => asRecord(file))
        .filter((file): file is RecordLike => Boolean(file))
        .flatMap((file) => {
            const filePath = readStringField(file, ['file_path', 'filePath', 'path']) ?? '';
            if (!filePath) return [];
            const changeKind = readStringField(file, ['change_kind', 'changeKind']);
            const source = readStringField(file, ['source']);
            const confidence = readStringField(file, ['confidence']);
            const provider = readStringField(file, ['provider']);
            const previousFilePath = readStringField(file, ['previous_file_path', 'previousFilePath']);
            return [{
                filePath,
                ...(previousFilePath ? { previousFilePath } : {}),
                changeKind: changeKind && FILE_CHANGE_KINDS.has(changeKind as FileChangeKind)
                    ? changeKind as FileChangeKind
                    : 'modified',
                unifiedDiff: typeof file.unified_diff === 'string' ? file.unified_diff : undefined,
                oldText: typeof file.oldText === 'string' ? file.oldText : typeof file.old_text === 'string' ? file.old_text : undefined,
                newText: typeof file.newText === 'string' ? file.newText : typeof file.new_text === 'string' ? file.new_text : undefined,
                ...(typeof file.binary === 'boolean' ? { binary: file.binary } : {}),
                source: source && CHANGE_SOURCES.has(source as ChangeEvidenceSource)
                    ? source as ChangeEvidenceSource
                    : metadata.source,
                confidence: confidence && CHANGE_CONFIDENCES.has(confidence as ChangeConfidence)
                    ? confidence as ChangeConfidence
                    : metadata.confidence,
                provider: provider ?? metadata.provider,
                providerTurnId: metadata.turnId,
            }];
        });
}
