import { resolveRepositoryCheckpointAvailability } from './availability';
import { runGitCheckpointCommand } from './gitCheckpointCommands';
import { buildRepositoryCheckpointRef } from './refs';
import { REPOSITORY_CHECKPOINT_RECEIPT_IDS } from './receipts';
import { readGitComparisonFiles } from '../comparisons/readGitComparisonFiles';
import type { RepositoryCheckpointDiffRequest, RepositoryCheckpointDiffResult, RepositoryCheckpointRef } from './types';

function validateDiffRef(checkpointRef: RepositoryCheckpointRef): string | null {
    try {
        const expected = buildRepositoryCheckpointRef(checkpointRef);
        return checkpointRef.encodedScope !== expected.encodedScope || checkpointRef.ref !== expected.ref
            ? 'Checkpoint diff ref is outside the Happier checkpoint namespace.' : null;
    } catch {
        return 'Checkpoint diff ref is malformed or outside the Happier checkpoint namespace.';
    }
}

export async function diffGitRepositoryCheckpoints(input: RepositoryCheckpointDiffRequest): Promise<RepositoryCheckpointDiffResult> {
    const unavailable = (reason: Extract<RepositoryCheckpointDiffResult, { success: false }>['reason'], error: string,
        kind: 'failed' | 'unavailable' = 'unavailable'): RepositoryCheckpointDiffResult => ({
        success: false, kind, reason, error, baseRefSource: input.baseRefSource, contentConfidence: 'unavailable',
        attributionScope: input.attributionScope, receipts: [],
    });
    const refError = validateDiffRef(input.baseRef) ?? validateDiffRef(input.finalRef);
    if (refError || input.baseRef.scopeId !== input.finalRef.scopeId) {
        return unavailable('invalid_ref', refError ?? 'Checkpoint diff refs must share the same scope.', 'failed');
    }
    const availability = resolveRepositoryCheckpointAvailability({ context: input.context });
    if (!availability.available) return unavailable(availability.reason, availability.message);
    const endpoints: string[] = [];
    for (const [ref, reason] of [[input.baseRef, 'missing_base'], [input.finalRef, 'missing_final']] as const) {
        const resolved = await runGitCheckpointCommand({ cwd: availability.repoRoot, args: ['rev-parse', '--verify', `${ref.ref}^{commit}`] });
        if (!resolved.success || !resolved.stdout.trim()) return unavailable(reason, `Checkpoint diff ${reason === 'missing_base' ? 'base' : 'final'} ref is unavailable.`);
        endpoints.push(resolved.stdout.trim());
    }
    const read = await readGitComparisonFiles({ cwd: availability.repoRoot, before: endpoints[0]!, after: endpoints[1]! });
    if (!read.enumerationComplete) return unavailable('diff_failed', read.reasons.join('\n'));
    return {
        success: true, baseRef: input.baseRef, finalRef: input.finalRef, baseRefSource: input.baseRefSource,
        contentConfidence: read.reasons.length ? 'unavailable' : 'exact', attributionScope: input.attributionScope,
        files: read.files.map((file) => ({ filePath: file.path, previousFilePath: file.previousPath ?? null,
            changeKind: file.changeKind, ...(file.unifiedDiff !== undefined ? { unifiedDiff: file.unifiedDiff } : {}),
            ...(file.binary ? { binary: true } : {}), source: 'scm_checkpoint',
            confidence: file.unavailableReason ? 'best_effort' : 'exact', provider: 'scm:git',
            ...(file.unavailableReason ? { description: file.unavailableReason } : {}) })),
        receipts: [{ id: REPOSITORY_CHECKPOINT_RECEIPT_IDS.diffComputed, ref: input.finalRef.ref }],
    };
}
