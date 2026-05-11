import { Buffer } from 'node:buffer';
import { resolve as resolvePath } from 'node:path';

import type { CheckpointCodeRollbackRequest } from './types';
import { parseRepositoryCheckpointRef } from '../refs';
import type { ScmBackendContext } from '../../types';

const INVALID_REF_SEGMENT = /[\u0000-\u0020\u007f~^:?*[\\]/;

function sameResolvedPath(left: string, right: string): boolean {
    return resolvePath(left) === resolvePath(right);
}

function assertSafeSegment(value: string, label: string): void {
    if (
        value.trim().length === 0
        || value.includes('/')
        || value.includes('..')
        || value.includes('@{')
        || value.endsWith('.lock')
        || value.startsWith('.')
        || value.endsWith('.')
        || INVALID_REF_SEGMENT.test(value)
    ) {
        throw new Error(`${label} is not safe for a rollback checkpoint ref`);
    }
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
    if (!start || !final) return ['checkpoint_ref_scope_mismatch'];
    if (start.phase !== 'turn-start' || final.phase !== 'turn-final') return ['checkpoint_ref_phase_mismatch'];
    if (start.checkpointId !== input.request.turnId || final.checkpointId !== input.request.turnId) {
        return ['checkpoint_ref_turn_mismatch'];
    }

    return [];
}

export function buildGitRollbackBackupRef(input: Readonly<{
    rollbackId: string;
    scopeId: string;
}>): string {
    assertSafeSegment(input.rollbackId, 'rollbackId');
    const encodedScope = Buffer.from(input.scopeId, 'utf8').toString('base64url');
    return `refs/happier/checkpoints/${encodedScope}/rollback-backup/${input.rollbackId}`;
}
