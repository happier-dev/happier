import {
    buildRepositoryCheckpointScopePrefix,
    pruneRepositoryCheckpointRefs,
    resolveRepositoryCheckpointAvailability,
} from '../../../checkpoints';
import type { RepositoryCheckpointCleanupResult, RepositoryCheckpointListedRef } from '../../../checkpoints';
import type { ScmBackendContext } from '../../../types';
import { runGitCheckpointCommand } from './commands';

function parseForEachRefOutput(stdout: string): RepositoryCheckpointListedRef[] {
    return stdout
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .map((line) => {
            const [ref = '', committedAtUnix = ''] = line.split('\0');
            const parsedDate = Number(committedAtUnix);
            return {
                ref,
                committedAtMs: Number.isFinite(parsedDate) ? parsedDate * 1000 : null,
            };
        })
        .filter((entry) => entry.ref.length > 0);
}

export async function pruneGitRepositoryCheckpointRefs(input: {
    context: ScmBackendContext;
    scopeId: string;
    nowMs?: number;
    maxAgeMs?: number;
    maxFinalizedTurns?: number;
}): Promise<RepositoryCheckpointCleanupResult> {
    const availability = resolveRepositoryCheckpointAvailability({ context: input.context });
    if (!availability.available) {
        return {
            success: false,
            prunedCount: 0,
            prunedRefs: [],
            error: availability.message,
            receipts: [],
        };
    }

    const scopePrefix = buildRepositoryCheckpointScopePrefix(input.scopeId);
    const refs = await runGitCheckpointCommand({
        cwd: availability.repoRoot,
        args: ['for-each-ref', '--format=%(refname)%00%(committerdate:unix)', scopePrefix],
        timeoutMs: 5000,
    });
    if (!refs.success) {
        return {
            success: false,
            prunedCount: 0,
            prunedRefs: [],
            error: refs.stderr || 'Failed to list repository checkpoint refs',
            receipts: [],
        };
    }

    return await pruneRepositoryCheckpointRefs({
        scopeId: input.scopeId,
        refs: parseForEachRefOutput(refs.stdout),
        nowMs: input.nowMs,
        maxAgeMs: input.maxAgeMs,
        maxFinalizedTurns: input.maxFinalizedTurns,
        deleteRef: async (ref) => {
            const result = await runGitCheckpointCommand({
                cwd: availability.repoRoot,
                args: ['update-ref', '-d', ref],
                timeoutMs: 5000,
            });
            if (!result.success) {
                throw new Error(result.stderr || `Failed to delete repository checkpoint ref ${ref}`);
            }
        },
    });
}
