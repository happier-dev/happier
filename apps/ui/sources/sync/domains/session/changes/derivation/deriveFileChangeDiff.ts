import { createTwoFilesPatch } from 'diff';
import type { FileChangeEvidence } from '@happier-dev/protocol/sessions/changes/types';

/** Formats Protocol-selected content; null is unavailable and an empty string is an exact empty comparison. */
export function deriveFileChangeDiff(file: FileChangeEvidence): string | null {
    if (file.unifiedDiff?.trim()) return file.unifiedDiff;
    if (file.binary || file.truncated || typeof file.oldText !== 'string' || typeof file.newText !== 'string') return null;
    if (file.oldText === file.newText) return '';
    return createTwoFilesPatch(
        file.previousFilePath ?? file.filePath,
        file.filePath,
        file.oldText,
        file.newText,
    );
}
