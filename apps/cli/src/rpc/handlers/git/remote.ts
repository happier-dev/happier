import type { GitRemoteRequest } from '@happier-dev/protocol';
import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

export function buildGitPushArgs(request: Readonly<Pick<GitRemoteRequest, 'remote' | 'branch'>>): string[] {
    const args = ['push'];
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

export function buildGitPullArgs(request: Readonly<Pick<GitRemoteRequest, 'remote' | 'branch'>>): string[] {
    const args = ['pull', '--ff-only'];
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

type GitRemoteRequestNormalizationResult =
    | { ok: true; request: { remote: string | undefined; branch: string | undefined } }
    | { ok: false; error: string };

function normalizeGitRemoteValue(
    value: string | undefined,
    label: 'Remote name' | 'Branch name'
): { ok: true; value: string | undefined } | { ok: false; error: string } {
    if (value === undefined) {
        return { ok: true, value: undefined };
    }
    const normalized = value.trim();
    if (!normalized) {
        return { ok: true, value: undefined };
    }
    if (normalized.startsWith('-')) {
        return { ok: false, error: `${label} cannot start with "-"` };
    }
    if (/\s/.test(normalized)) {
        return { ok: false, error: `${label} must not contain whitespace` };
    }
    if (normalized.includes('\0')) {
        return { ok: false, error: `${label} contains unsupported characters` };
    }
    return { ok: true, value: normalized };
}

export function normalizeGitRemoteRequest(
    request: Readonly<Pick<GitRemoteRequest, 'remote' | 'branch'>>
): GitRemoteRequestNormalizationResult {
    const remote = normalizeGitRemoteValue(request.remote, 'Remote name');
    if (!remote.ok) {
        return remote;
    }
    const branch = normalizeGitRemoteValue(request.branch, 'Branch name');
    if (!branch.ok) {
        return branch;
    }
    return {
        ok: true,
        request: {
            remote: remote.value,
            branch: branch.value,
        },
    };
}

export function mapGitErrorCode(stderr: string): keyof typeof GIT_OPERATION_ERROR_CODES {
    const lower = stderr.toLowerCase();
    if (lower.includes('not a git repository')) {
        return 'NOT_GIT_REPO';
    }
    if (lower.includes('no such remote') || lower.includes('does not appear to be a git repository')) {
        return 'REMOTE_NOT_FOUND';
    }
    if (
        lower.includes('authentication failed') ||
        lower.includes('permission denied') ||
        lower.includes('could not read username') ||
        lower.includes('terminal prompts disabled') ||
        lower.includes('support for password authentication was removed')
    ) {
        return 'REMOTE_AUTH_REQUIRED';
    }
    if (
        lower.includes('no upstream configured') ||
        lower.includes('has no upstream branch') ||
        lower.includes('no tracking information for the current branch')
    ) {
        return 'REMOTE_UPSTREAM_REQUIRED';
    }
    if (
        lower.includes('non-fast-forward') ||
        lower.includes('fetch first') ||
        lower.includes('tip of your current branch is behind')
    ) {
        return 'REMOTE_NON_FAST_FORWARD';
    }
    if (lower.includes('not possible to fast-forward') || (lower.includes('ff-only') && lower.includes('aborting'))) {
        return 'REMOTE_FF_ONLY_REQUIRED';
    }
    if (
        lower.includes('remote rejected') ||
        lower.includes('pre-receive hook declined') ||
        lower.includes('protected branch hook declined') ||
        lower.includes('remote: error: gh006') ||
        lower.includes('remote: error: gh013')
    ) {
        return 'REMOTE_REJECTED';
    }
    return 'COMMAND_FAILED';
}
