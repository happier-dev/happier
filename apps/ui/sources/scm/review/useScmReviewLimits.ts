import { useSetting } from '@/sync/domains/state/storage';

function positiveWhole(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** Past these, Review keeps every file listed and opens their diffs on demand (Settings → Review). */
export function useScmReviewLimits(): Readonly<{ maxFiles: number; maxChangedLines: number }> {
    const maxFiles = positiveWhole(useSetting('scmReviewMaxFiles'), 25);
    const maxChangedLines = positiveWhole(useSetting('scmReviewMaxChangedLines'), 2000);
    return { maxFiles, maxChangedLines };
}
