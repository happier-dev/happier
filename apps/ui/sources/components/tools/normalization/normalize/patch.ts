import { normalizePatchInputRecord } from '@happier-dev/protocol/tools/v2';

import { hasNonEmptyRecord } from './_shared';

export function normalizeDiffAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    if (typeof input.unified_diff === 'string' && input.unified_diff.trim().length > 0) return null;

    const diff = typeof input.diff === 'string' ? input.diff : typeof input.patch === 'string' ? input.patch : null;
    if (!diff || diff.trim().length === 0) return null;
    return { ...input, unified_diff: diff };
}

export function normalizePatchChangeArray(input: Record<string, unknown>): Record<string, unknown> | null {
    if (!Array.isArray(input.changes) || input.changes.length === 0) return null;
    const normalized = normalizePatchInputRecord(input);
    return hasNonEmptyRecord(normalized.changes) ? normalized : null;
}

export function normalizePatchFromUnifiedDiff(input: Record<string, unknown>): Record<string, unknown> | null {
    if (hasNonEmptyRecord(input.changes)) return null;

    const diff =
        typeof input.unified_diff === 'string'
            ? input.unified_diff
            : typeof input.diff === 'string'
                ? input.diff
                : typeof input.patch === 'string'
                    ? input.patch
                    : typeof input.patchText === 'string'
                        ? input.patchText
                        : typeof input.patch_text === 'string'
                            ? input.patch_text
                            : null;
    if (!diff || diff.trim().length === 0) return null;

    const normalized = normalizePatchInputRecord(input);
    return hasNonEmptyRecord(normalized.changes) ? normalized : null;
}
