import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    buildGitCheckpointRollbackScopeId,
    validateGitCheckpointRollbackRequestScope,
} from './gitCheckpointRollbackScope';
import type { CheckpointCodeRollbackRequest } from './types';
import { buildRepositoryCheckpointRefs } from '../refs';
import type { ScmBackendContext } from '../../types';

const repoRoot = resolvePath('/repo');
const sessionId = 'session-1';
const turnId = 'turn-1';
const scopeId = buildGitCheckpointRollbackScopeId({ repoRoot, sessionId });
const validRefs = buildRepositoryCheckpointRefs({ scopeId, turnId });

const baseContext: ScmBackendContext = {
    cwd: repoRoot,
    projectKey: `project:${repoRoot}`,
    detection: { isRepo: true, rootPath: repoRoot, mode: '.git' },
};

const baseRequest: CheckpointCodeRollbackRequest = {
    v: 1,
    sessionId,
    turnId,
    cwd: repoRoot,
    codeMode: 'code_only_without_stash',
    backupMode: 'happier_checkpoint_only',
    expectedStartRef: validRefs.turnStart!.ref,
    expectedFinalRef: validRefs.turnFinal!.ref,
};

function validateScope(input?: Readonly<{
    context?: ScmBackendContext;
    request?: CheckpointCodeRollbackRequest;
    repoRoot?: string;
}>): readonly string[] {
    return validateGitCheckpointRollbackRequestScope({
        context: input?.context ?? baseContext,
        request: input?.request ?? baseRequest,
        repoRoot: input?.repoRoot ?? repoRoot,
    });
}

describe('validateGitCheckpointRollbackRequestScope', () => {
    it('diagnoses worktree mismatches before rollback mutation', () => {
        expect(validateScope({
            request: { ...baseRequest, cwd: resolvePath('/other-worktree') },
        })).toEqual(['checkpoint_rollback_worktree_mismatch']);
    });

    it('diagnoses repository mismatches before rollback mutation', () => {
        expect(validateScope({
            context: {
                ...baseContext,
                detection: { ...baseContext.detection, rootPath: resolvePath('/other-repo') },
            },
        })).toEqual(['checkpoint_rollback_repository_mismatch']);
    });

    it('diagnoses checkpoint ref scope mismatches before rollback mutation', () => {
        const otherScopeRefs = buildRepositoryCheckpointRefs({
            scopeId: buildGitCheckpointRollbackScopeId({ repoRoot, sessionId: 'session-2' }),
            turnId,
        });

        expect(validateScope({
            request: {
                ...baseRequest,
                expectedStartRef: otherScopeRefs.turnStart!.ref,
            },
        })).toEqual(['checkpoint_ref_scope_mismatch']);
    });

    it('diagnoses checkpoint ref phase mismatches before rollback mutation', () => {
        expect(validateScope({
            request: {
                ...baseRequest,
                expectedStartRef: validRefs.turnFinal!.ref,
            },
        })).toEqual(['checkpoint_ref_phase_mismatch']);
    });

    it('diagnoses checkpoint ref turn mismatches before rollback mutation', () => {
        const otherTurnRefs = buildRepositoryCheckpointRefs({ scopeId, turnId: 'turn-2' });

        expect(validateScope({
            request: {
                ...baseRequest,
                expectedFinalRef: otherTurnRefs.turnFinal!.ref,
            },
        })).toEqual(['checkpoint_ref_turn_mismatch']);
    });
});
