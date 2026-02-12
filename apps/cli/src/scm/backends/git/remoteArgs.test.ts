import { describe, expect, it } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import {
    buildGitPullArgs,
    buildGitPushArgs,
    mapGitErrorCode,
    normalizeScmRemoteRequest,
} from './remote';

describe('git remote arg builders', () => {
    it('uses explicit remote + branch for push when both are provided', () => {
        expect(buildGitPushArgs({ remote: 'upstream', branch: 'feature/x' } as any)).toEqual([
            'push',
            'upstream',
            'feature/x',
        ]);
    });

    it('defaults to origin when push has branch without remote', () => {
        expect(buildGitPushArgs({ branch: 'feature/x' } as any)).toEqual(['push', 'origin', 'feature/x']);
    });

    it('uses explicit remote + branch for pull when both are provided', () => {
        expect(buildGitPullArgs({ remote: 'upstream', branch: 'feature/x' } as any)).toEqual([
            'pull',
            '--ff-only',
            'upstream',
            'feature/x',
        ]);
    });

    it('defaults to origin when pull has branch without remote', () => {
        expect(buildGitPullArgs({ branch: 'feature/x' } as any)).toEqual(['pull', '--ff-only', 'origin', 'feature/x']);
    });
});

describe('normalizeScmRemoteRequest', () => {
    it('accepts undefined remote and branch', () => {
        expect(normalizeScmRemoteRequest({} as any)).toEqual({
            ok: true,
            request: {
                remote: undefined,
                branch: undefined,
            },
        });
    });

    it('trims remote and branch values', () => {
        expect(normalizeScmRemoteRequest({ remote: ' origin ', branch: ' feature/x ' } as any)).toEqual({
            ok: true,
            request: {
                remote: 'origin',
                branch: 'feature/x',
            },
        });
    });

    it('rejects remote values starting with "-"', () => {
        expect(normalizeScmRemoteRequest({ remote: '--upload-pack=hack' } as any)).toEqual({
            ok: false,
            error: 'Remote name cannot start with "-"',
        });
    });

    it('rejects branch values starting with "-"', () => {
        expect(normalizeScmRemoteRequest({ branch: '--force' } as any)).toEqual({
            ok: false,
            error: 'Branch name cannot start with "-"',
        });
    });

    it('rejects branch refspec-like values', () => {
        expect(normalizeScmRemoteRequest({ branch: '+main:prod' } as any)).toEqual({
            ok: false,
            error: 'Branch name contains unsupported syntax',
        });
    });

    it('rejects branch values with revision syntax', () => {
        expect(normalizeScmRemoteRequest({ branch: 'main..origin/main' } as any)).toEqual({
            ok: false,
            error: 'Branch name contains unsupported syntax',
        });
    });
});

describe('mapGitErrorCode', () => {
    it('maps non-fast-forward push errors', () => {
        expect(mapGitErrorCode('! [rejected] main -> main (non-fast-forward)')).toBe(
            SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD
        );
    });

    it('maps ff-only pull divergence errors', () => {
        expect(mapGitErrorCode('fatal: Not possible to fast-forward, aborting.')).toBe(
            SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED
        );
    });

    it('maps repository rules remote errors to remote rejected', () => {
        expect(mapGitErrorCode('remote: error: GH013: Repository rule violations found')).toBe(
            SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED
        );
    });

    it('maps unknown remote errors', () => {
        expect(mapGitErrorCode('fatal: No such remote: upstream')).toBe(
            SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND
        );
    });

    it('maps non-repository errors to NOT_REPOSITORY', () => {
        expect(mapGitErrorCode('fatal: not a git repository (or any of the parent directories): .git')).toBe(
            SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY
        );
    });
});
