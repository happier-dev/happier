import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

/**
 * Canonical normalization for backchannel / interruption transcript matching.
 *
 * Lowercases, collapses any non-alphanumeric run to a single space, and trims —
 * so `"Yeah, exactly!"` and `"yeah exactly"` compare equal. Shared by the
 * backchannel filter and the runtime turn-policy controller so the two paths
 * cannot drift.
 */
export function normalizeInterruptionTranscript(value: string | null | undefined): string {
    const normalized = normalizeNonEmptyString(value) ?? '';
    if (!normalized) {
        return '';
    }

    return normalized
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/** Word count of the normalized transcript (0 for empty). */
export function countInterruptionWords(value: string | null | undefined): number {
    const normalized = normalizeInterruptionTranscript(value);
    if (!normalized) {
        return 0;
    }
    return normalized.split(' ').length;
}
