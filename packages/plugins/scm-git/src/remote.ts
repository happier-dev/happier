import type {
  ScmOperationErrorCode,
  ScmRemoteRequest,
} from '@happier-dev/plugin-sdk/scm';
import {
  mapGitScmErrorCode } from '@happier-dev/plugin-sdk/scm/backend';
import {
  normalizeScmRemoteRequest,
} from '@happier-dev/plugin-sdk/scm';

export function buildGitPublishArgs(request: Readonly<{ remote: string; branch: string }>): string[] {
    return ['push', '--no-verify', '--set-upstream', request.remote, request.branch];
}

export function buildGitPushArgs(request: Readonly<Pick<ScmRemoteRequest, 'remote' | 'branch' | 'pushMode' | 'expectedRemoteOid'>>): string[] {
    if (request.pushMode === 'force_with_lease') {
        const ref = request.branch?.startsWith('refs/heads/') ? request.branch : `refs/heads/${request.branch}`;
        // Normalization requires the exact lease target and object identity.
        return ['-c', `remote.${request.remote}.mirror=false`, 'push', '--no-verify', '--no-mirror', '--no-follow-tags', `--force-with-lease=${ref}:${request.expectedRemoteOid}`, request.remote!, `HEAD:${ref}`];
    }
    const args = ['push', '--no-verify'];
    if (request.remote) {
        args.push(request.remote);
        if (request.branch) args.push(request.branch);
        return args;
    }
    if (request.branch) {
        args.push('origin', request.branch);
    }
    return args;
}

export function buildGitPullArgs(request: Readonly<Pick<ScmRemoteRequest, 'remote' | 'branch' | 'reconcile'>>): string[] {
    const args = request.reconcile === 'rebase'
        ? ['pull', '--rebase', '--ff', '--no-autostash']
        : request.reconcile === 'merge'
            ? ['pull', '--no-rebase', '--ff', '--no-edit', '--no-autostash']
            : ['pull', '--ff-only', '--no-rebase', '--no-autostash'];
    if (request.remote) {
        args.push(request.remote);
        if (request.branch) args.push(request.branch);
        return args;
    }
    if (request.branch) {
        args.push('origin', request.branch);
    }
    return args;
}
export { normalizeScmRemoteRequest };

export function mapGitErrorCode(stderr: string): ScmOperationErrorCode {
    return mapGitScmErrorCode(stderr);
}
