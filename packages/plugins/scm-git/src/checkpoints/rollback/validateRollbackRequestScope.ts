import { resolve as resolvePath } from 'node:path';

import { parseRepositoryCheckpointRef } from '../shared.js';
import type { CheckpointCodeRollbackRequest } from './shared.js';
import type { ScmBackendContext } from '../../types.js';

function sameResolvedPath(left: string, right: string): boolean {
    return resolvePath(left) === resolvePath(right);
}

export function buildGitCheckpointRollbackScopeId(input: Readonly<{
    repoRoot: string;
    sessionId: string;
}>): string {
    return `${input.sessionId}:${resolvePath(input.repoRoot)}`;
}

export function validateGitCheckpointRollbackRequestScope(input: Readonly<{
    context: ScmBackendContext;
    request: CheckpointCodeRollbackRequest;
    repoRoot: string;
}>): readonly string[] {
    if (!sameResolvedPath(input.context.cwd, input.request.cwd)) {
        return ['checkpoint_rollback_worktree_mismatch'];
    }
    if (!input.context.detection.rootPath || !sameResolvedPath(input.repoRoot, input.context.detection.rootPath)) {
        return ['checkpoint_rollback_repository_mismatch'];
    }

    const scopeId = buildGitCheckpointRollbackScopeId({
        repoRoot: input.repoRoot,
        sessionId: input.request.sessionId,
    });
    const start = parseRepositoryCheckpointRef({ scopeId, ref: input.request.expectedStartRef });
    const final = parseRepositoryCheckpointRef({ scopeId, ref: input.request.expectedFinalRef });
    if (!start || !final) {
        return ['checkpoint_ref_scope_mismatch'];
    }
    if (start.phase !== 'turn-start' || final.phase !== 'turn-final') {
        return ['checkpoint_ref_phase_mismatch'];
    }
    if (start.checkpointId !== input.request.turnId || final.checkpointId !== input.request.turnId) {
        return ['checkpoint_ref_turn_mismatch'];
    }

    return [];
}
