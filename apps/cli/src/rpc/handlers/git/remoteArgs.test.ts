import { describe, expect, it, vi } from 'vitest';
import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import {
    buildGitPullArgs,
    buildGitPushArgs,
    mapGitErrorCode,
    normalizeGitRemoteRequest,
} from './remote';
import { writeGitStdin } from './runtime';

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

describe('normalizeGitRemoteRequest', () => {
    it('accepts undefined remote and branch', () => {
        expect(normalizeGitRemoteRequest({} as any)).toEqual({
            ok: true,
            request: {
                remote: undefined,
                branch: undefined,
            },
        });
    });

    it('trims remote and branch values', () => {
        expect(normalizeGitRemoteRequest({ remote: ' origin ', branch: ' feature/x ' } as any)).toEqual({
            ok: true,
            request: {
                remote: 'origin',
                branch: 'feature/x',
            },
        });
    });

    it('rejects remote values starting with "-"', () => {
        expect(normalizeGitRemoteRequest({ remote: '--upload-pack=hack' } as any)).toEqual({
            ok: false,
            error: 'Remote name cannot start with "-"',
        });
    });

    it('rejects branch values starting with "-"', () => {
        expect(normalizeGitRemoteRequest({ branch: '--force' } as any)).toEqual({
            ok: false,
            error: 'Branch name cannot start with "-"',
        });
    });
});

describe('writeGitStdin', () => {
    it('writes input and ends stdin for writable streams', () => {
        const write = vi.fn();
        const end = vi.fn();
        const once = vi.fn();
        writeGitStdin({ write, end, once, writable: true, destroyed: false }, 'payload');
        expect(once).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith('payload');
        expect(end).toHaveBeenCalledTimes(1);
    });

    it('does not throw when stdin write fails', () => {
        const write = vi.fn(() => {
            throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
        });
        const end = vi.fn();
        expect(() =>
            writeGitStdin({ write, end, once: vi.fn(), writable: true, destroyed: false }, 'payload'),
        ).not.toThrow();
        expect(end).not.toHaveBeenCalled();
    });

    it('skips writing for destroyed streams', () => {
        const write = vi.fn();
        const end = vi.fn();
        writeGitStdin({ write, end, once: vi.fn(), writable: true, destroyed: true }, 'payload');
        expect(write).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
    });
});

describe('mapGitErrorCode', () => {
    it('maps non-fast-forward push errors', () => {
        expect(mapGitErrorCode('! [rejected] main -> main (non-fast-forward)')).toBe(
            GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD
        );
    });

    it('maps ff-only pull divergence errors', () => {
        expect(mapGitErrorCode('fatal: Not possible to fast-forward, aborting.')).toBe(
            GIT_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED
        );
    });

    it('maps push divergence hints to non-fast-forward', () => {
        expect(
            mapGitErrorCode(
                'hint: Updates were rejected because the tip of your current branch is behind its remote counterpart.'
            )
        ).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD);
    });

    it('maps remote rejection errors', () => {
        expect(mapGitErrorCode('remote rejected (pre-receive hook declined)')).toBe(
            GIT_OPERATION_ERROR_CODES.REMOTE_REJECTED
        );
    });

    it('maps GitHub policy remote errors to remote rejected', () => {
        expect(mapGitErrorCode('remote: error: GH006: Protected branch update failed')).toBe(
            GIT_OPERATION_ERROR_CODES.REMOTE_REJECTED
        );
    });

    it('maps repository rules remote errors to remote rejected', () => {
        expect(mapGitErrorCode('remote: error: GH013: Repository rule violations found')).toBe(
            GIT_OPERATION_ERROR_CODES.REMOTE_REJECTED
        );
    });

    it('maps legacy password auth removal guidance to auth required', () => {
        expect(
            mapGitErrorCode(
                "Support for password authentication was removed on August 13, 2021. Please use a personal access token instead."
            )
        ).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED);
    });

    it('maps unknown remote errors', () => {
        expect(mapGitErrorCode('fatal: No such remote: upstream')).toBe(
            GIT_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND
        );
    });

    it('maps missing tracking information errors to upstream required', () => {
        expect(
            mapGitErrorCode(
                'There is no tracking information for the current branch. Please specify which branch you want to merge with.'
            )
        ).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
    });

    it('maps non-repository errors to NOT_GIT_REPO', () => {
        expect(mapGitErrorCode('fatal: not a git repository (or any of the parent directories): .git')).toBe(
            GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO
        );
    });
});
