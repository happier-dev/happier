import { looksLikeUnifiedDiff } from '@/scm/diff/looksLikeUnifiedDiff';

export function resolveFileDetailsRenderableDiff(input: Readonly<{
    diffContent: string | null;
}>): boolean {
    return typeof input.diffContent === 'string' && looksLikeUnifiedDiff(input.diffContent);
}
