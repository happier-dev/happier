import type { FileChangeEvidence } from '@happier-dev/protocol';

import type { TurnChangeToolMetadata } from './readTurnChangeToolMetadata';

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RecordLike;
}

export function extractCanonicalDiffFiles(input: unknown, metadata: TurnChangeToolMetadata): FileChangeEvidence[] {
    const record = asRecord(input);
    const rawFiles = Array.isArray(record?.files) ? record.files : [];
    return rawFiles
        .map((file) => asRecord(file))
        .filter((file): file is RecordLike => Boolean(file))
        .flatMap((file) => {
            const filePath = typeof file.file_path === 'string' ? file.file_path.trim() : '';
            if (!filePath) return [];
            return [{
                filePath,
                changeKind: 'modified' as const,
                unifiedDiff: typeof file.unified_diff === 'string' ? file.unified_diff : undefined,
                oldText: typeof file.oldText === 'string' ? file.oldText : typeof file.old_text === 'string' ? file.old_text : undefined,
                newText: typeof file.newText === 'string' ? file.newText : typeof file.new_text === 'string' ? file.new_text : undefined,
                source: metadata.source,
                confidence: metadata.confidence,
                provider: metadata.provider,
                providerTurnId: metadata.turnId,
            }];
        });
}
