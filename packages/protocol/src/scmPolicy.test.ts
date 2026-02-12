import { describe, expect, it } from 'vitest';

import {
    classifyScmOperationErrorCode,
    evaluateScmRemoteMutationPolicy,
    inferScmRemoteTarget,
    mapGitScmErrorCode,
    mapSaplingScmErrorCode,
    normalizeScmRemoteRequest,
    parseScmUpstreamRef,
    SCM_OPERATION_ERROR_CODES,
} from './scm.js';

function makeSnapshot(input?: {
    head?: string | null;
    upstream?: string | null;
    behind?: number;
    detached?: boolean;
    hasConflicts?: boolean;
    includedFiles?: number;
    pendingFiles?: number;
    untrackedFiles?: number;
}) {
    const head = input?.head === undefined ? 'main' : input.head;
    const upstream = input?.upstream === undefined ? 'origin/main' : input.upstream;
    return {
        hasConflicts: input?.hasConflicts ?? false,
        branch: {
            head,
            upstream,
            behind: input?.behind ?? 0,
            detached: input?.detached ?? false,
        },
        totals: {
            includedFiles: input?.includedFiles ?? 0,
            pendingFiles: input?.pendingFiles ?? 0,
            untrackedFiles: input?.untrackedFiles ?? 0,
        },
    };
}

describe('parseScmUpstreamRef', () => {
    it('parses upstream refs into remote + branch', () => {
        expect(parseScmUpstreamRef('origin/main')).toEqual({ remote: 'origin', branch: 'main' });
        expect(parseScmUpstreamRef('upstream/feature/x')).toEqual({ remote: 'upstream', branch: 'feature/x' });
    });

    it('returns null for malformed upstream refs', () => {
        expect(parseScmUpstreamRef(null)).toBeNull();
        expect(parseScmUpstreamRef('origin')).toBeNull();
        expect(parseScmUpstreamRef('/main')).toBeNull();
        expect(parseScmUpstreamRef('origin/')).toBeNull();
    });
});

describe('inferScmRemoteTarget', () => {
    it('prefers parsed upstream when available', () => {
        expect(inferScmRemoteTarget({
            upstream: 'upstream/feature/x',
            head: 'main',
            allowHeadFallback: true,
        })).toEqual({
            remote: 'upstream',
            branch: 'feature/x',
        });
    });

    it('supports optional head fallback', () => {
        expect(inferScmRemoteTarget({
            upstream: null,
            head: 'release/1.2',
            allowHeadFallback: true,
        })).toEqual({
            remote: 'origin',
            branch: 'release/1.2',
        });
        expect(inferScmRemoteTarget({
            upstream: null,
            head: 'release/1.2',
            allowHeadFallback: false,
        })).toEqual({
            remote: 'origin',
            branch: null,
        });
    });
});

describe('evaluateScmRemoteMutationPolicy', () => {
    it('enforces git-style push and pull guards', () => {
        const pushDetached = evaluateScmRemoteMutationPolicy({
            kind: 'push',
            snapshot: makeSnapshot({ detached: true }),
            hasExplicitTarget: true,
            policy: {
                requireUpstreamWhenNoExplicitTarget: true,
                requireActiveHead: false,
                blockPushOnConflicts: true,
                blockPushWhenBehind: true,
                requireCleanPull: true,
            },
        });
        expect(pushDetached).toEqual({ ok: false, reason: 'detached_head' });

        const pushBehind = evaluateScmRemoteMutationPolicy({
            kind: 'push',
            snapshot: makeSnapshot({ behind: 2 }),
            hasExplicitTarget: true,
            policy: {
                requireUpstreamWhenNoExplicitTarget: true,
                requireActiveHead: false,
                blockPushOnConflicts: true,
                blockPushWhenBehind: true,
                requireCleanPull: true,
            },
        });
        expect(pushBehind).toEqual({ ok: false, reason: 'branch_behind_remote' });

        const pullDirty = evaluateScmRemoteMutationPolicy({
            kind: 'pull',
            snapshot: makeSnapshot({ pendingFiles: 1 }),
            hasExplicitTarget: true,
            policy: {
                requireUpstreamWhenNoExplicitTarget: true,
                requireActiveHead: false,
                blockPushOnConflicts: true,
                blockPushWhenBehind: true,
                requireCleanPull: true,
            },
        });
        expect(pullDirty).toEqual({ ok: false, reason: 'clean_worktree_required' });
    });

    it('enforces sapling-style active-head and upstream target guards', () => {
        const activeHeadRequired = evaluateScmRemoteMutationPolicy({
            kind: 'push',
            snapshot: makeSnapshot({ head: null, detached: false }),
            hasExplicitTarget: true,
            policy: {
                requireUpstreamWhenNoExplicitTarget: true,
                requireActiveHead: true,
                blockPushOnConflicts: true,
                blockPushWhenBehind: false,
                requireCleanPull: true,
            },
        });
        expect(activeHeadRequired).toEqual({ ok: false, reason: 'detached_head' });

        const upstreamRequired = evaluateScmRemoteMutationPolicy({
            kind: 'pull',
            snapshot: makeSnapshot({ upstream: null }),
            hasExplicitTarget: false,
            policy: {
                requireUpstreamWhenNoExplicitTarget: true,
                requireActiveHead: true,
                blockPushOnConflicts: true,
                blockPushWhenBehind: false,
                requireCleanPull: true,
            },
        });
        expect(upstreamRequired).toEqual({ ok: false, reason: 'upstream_required' });
    });
});

describe('classifyScmOperationErrorCode', () => {
    it('classifies remote errors under the remote category', () => {
        expect(classifyScmOperationErrorCode(SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED)).toBe('remote');
        expect(classifyScmOperationErrorCode(SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED)).toBe('remote');
    });

    it('classifies non-remote errors into specific categories', () => {
        expect(classifyScmOperationErrorCode(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY)).toBe('repository');
        expect(classifyScmOperationErrorCode(SCM_OPERATION_ERROR_CODES.INVALID_PATH)).toBe('path');
        expect(classifyScmOperationErrorCode(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE)).toBe('worktree');
        expect(classifyScmOperationErrorCode(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED)).toBe('capability');
        expect(classifyScmOperationErrorCode(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE)).toBe('backend');
        expect(classifyScmOperationErrorCode(undefined)).toBe('unknown');
    });
});

describe('mapSaplingScmErrorCode', () => {
    it('maps common sapling remote errors deterministically', () => {
        expect(mapSaplingScmErrorCode("abort: use '--to' to specify destination bookmark")).toBe(
            SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED
        );
        expect(mapSaplingScmErrorCode('abort: remote rejected')).toBe(
            SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED
        );
        expect(mapSaplingScmErrorCode('abort: no repository found in current directory')).toBe(
            SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY
        );
    });
});

describe('mapGitScmErrorCode', () => {
    it('maps common git remote errors deterministically', () => {
        expect(mapGitScmErrorCode('fatal: not a git repository')).toBe(
            SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY
        );
        expect(mapGitScmErrorCode('error: failed to push some refs (non-fast-forward)')).toBe(
            SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD
        );
        expect(mapGitScmErrorCode('fatal: Authentication failed')).toBe(
            SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED
        );
    });
});

describe('normalizeScmRemoteRequest', () => {
    it('normalizes trimmed remote + branch values', () => {
        expect(normalizeScmRemoteRequest({ remote: ' origin ', branch: ' main ' })).toEqual({
            ok: true,
            request: {
                remote: 'origin',
                branch: 'main',
            },
        });
    });

    it('rejects unsupported remote and branch syntax', () => {
        expect(normalizeScmRemoteRequest({ remote: '--upload-pack=hack' })).toEqual({
            ok: false,
            error: 'Remote name cannot start with "-"',
        });
        expect(normalizeScmRemoteRequest({ branch: 'main..origin/main' })).toEqual({
            ok: false,
            error: 'Branch name contains unsupported syntax',
        });
    });
});
