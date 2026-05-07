import type {
    ScmRemoteAddRequest,
    ScmRemoteInfo,
    ScmRemoteManagementResponse,
    ScmRemoteRemoveRequest,
    ScmRemoteSetUrlRequest,
} from '@happier-dev/protocol';
import {
    SCM_OPERATION_ERROR_CODES,
    normalizeScmRemoteName,
    normalizeScmRemoteUrl,
} from '@happier-dev/protocol';

import { runScmCommand } from '../../../runtime';
import type { ScmBackendContext } from '../../../types';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import { mapGitErrorCode } from '../remote';
import { parseGitRemoteVerbose } from '../remoteListParser';

const GIT_REMOTE_MANAGEMENT_TIMEOUT_MS = 30_000;

type RemoteListResult =
    | { ok: true; remotes: ScmRemoteInfo[] }
    | { ok: false; response: ScmRemoteManagementResponse };

async function readGitRemotes(context: ScmBackendContext): Promise<RemoteListResult> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['remote', '-v'],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!result.success) {
        return {
            ok: false,
            response: {
                success: false,
                errorCode: mapGitErrorCode(result.stderr),
                error: result.stderr || 'Failed to list Git remotes',
                stderr: result.stderr,
            },
        };
    }
    return {
        ok: true,
        remotes: parseGitRemoteVerbose(result.stdout),
    };
}

async function successWithRemotes(input: {
    context: ScmBackendContext;
    stdout?: string;
    stderr?: string;
}): Promise<ScmRemoteManagementResponse> {
    const remotes = await readGitRemotes(input.context);
    return {
        success: true,
        stdout: input.stdout,
        stderr: input.stderr,
        ...(remotes.ok ? { remotes: remotes.remotes } : {}),
    };
}

function invalidRequest(error: string): ScmRemoteManagementResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        error,
    };
}

function normalizeRemoteNameForRequest(name: string | undefined): { ok: true; name: string } | { ok: false; response: ScmRemoteManagementResponse } {
    const normalized = normalizeScmRemoteName(name);
    return normalized.ok
        ? normalized
        : { ok: false, response: invalidRequest(normalized.error) };
}

function normalizeRemoteUrlForRequest(
    value: string | undefined,
    label: string
): { ok: true; url: string } | { ok: false; response: ScmRemoteManagementResponse } {
    const normalized = normalizeScmRemoteUrl(value, label);
    return normalized.ok
        ? normalized
        : { ok: false, response: invalidRequest(normalized.error) };
}

function findRemote(remotes: readonly ScmRemoteInfo[], name: string): ScmRemoteInfo | null {
    return remotes.find((remote) => remote.name === name) ?? null;
}

async function runGitRemoteCommand(input: {
    context: ScmBackendContext;
    args: string[];
    failureMessage: string;
}): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; response: ScmRemoteManagementResponse }> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: input.args,
        timeoutMs: GIT_REMOTE_MANAGEMENT_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv(),
    });
    return result.success
        ? { ok: true, stdout: result.stdout, stderr: result.stderr }
        : {
            ok: false,
            response: {
                success: false,
                errorCode: mapGitErrorCode(result.stderr),
                error: result.stderr || input.failureMessage,
                stdout: result.stdout,
                stderr: result.stderr,
            },
        };
}

export async function gitRemoteAdd(input: {
    context: ScmBackendContext;
    request: ScmRemoteAddRequest;
}): Promise<ScmRemoteManagementResponse> {
    const name = normalizeRemoteNameForRequest(input.request.name);
    if (!name.ok) return name.response;
    const fetchUrl = normalizeRemoteUrlForRequest(input.request.fetchUrl, 'Remote fetch URL');
    if (!fetchUrl.ok) return fetchUrl.response;
    const pushUrl = input.request.pushUrl === undefined
        ? null
        : normalizeRemoteUrlForRequest(input.request.pushUrl, 'Remote push URL');
    if (pushUrl && !pushUrl.ok) return pushUrl.response;

    const current = await readGitRemotes(input.context);
    if (!current.ok) return current.response;
    if (findRemote(current.remotes, name.name)) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
            error: `Remote "${name.name}" already exists`,
        };
    }

    const add = await runGitRemoteCommand({
        context: input.context,
        args: ['remote', 'add', name.name, fetchUrl.url],
        failureMessage: 'Failed to add Git remote',
    });
    if (!add.ok) return add.response;

    if (pushUrl?.ok && pushUrl.url !== fetchUrl.url) {
        const setPush = await runGitRemoteCommand({
            context: input.context,
            args: ['remote', 'set-url', '--push', name.name, pushUrl.url],
            failureMessage: 'Failed to set Git remote push URL',
        });
        if (!setPush.ok) return setPush.response;
    }

    return successWithRemotes({
        context: input.context,
        stdout: add.stdout,
        stderr: add.stderr,
    });
}

export async function gitRemoteSetUrl(input: {
    context: ScmBackendContext;
    request: ScmRemoteSetUrlRequest;
}): Promise<ScmRemoteManagementResponse> {
    const name = normalizeRemoteNameForRequest(input.request.name);
    if (!name.ok) return name.response;
    if (input.request.fetchUrl === undefined && input.request.pushUrl === undefined) {
        return invalidRequest('At least one remote URL field is required');
    }

    const fetchUrl = input.request.fetchUrl === undefined
        ? null
        : normalizeRemoteUrlForRequest(input.request.fetchUrl, 'Remote fetch URL');
    if (fetchUrl && !fetchUrl.ok) return fetchUrl.response;
    const pushUrl = input.request.pushUrl === undefined || input.request.pushUrl === null
        ? null
        : normalizeRemoteUrlForRequest(input.request.pushUrl, 'Remote push URL');
    if (pushUrl && !pushUrl.ok) return pushUrl.response;

    const current = await readGitRemotes(input.context);
    if (!current.ok) return current.response;
    if (!findRemote(current.remotes, name.name)) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
            error: `Remote "${name.name}" was not found`,
        };
    }

    let stdout = '';
    let stderr = '';
    if (fetchUrl?.ok) {
        const setFetch = await runGitRemoteCommand({
            context: input.context,
            args: ['remote', 'set-url', name.name, fetchUrl.url],
            failureMessage: 'Failed to set Git remote fetch URL',
        });
        if (!setFetch.ok) return setFetch.response;
        stdout += setFetch.stdout;
        stderr += setFetch.stderr;
    }

    if (input.request.pushUrl === null) {
        const unsetPush = await runScmCommand({
            bin: 'git',
            cwd: input.context.cwd,
            args: ['config', '--unset-all', `remote.${name.name}.pushurl`],
            timeoutMs: GIT_REMOTE_MANAGEMENT_TIMEOUT_MS,
            env: buildScmNonInteractiveEnv(),
        });
        if (!unsetPush.success && unsetPush.exitCode !== 5) {
            return {
                success: false,
                errorCode: mapGitErrorCode(unsetPush.stderr),
                error: unsetPush.stderr || 'Failed to clear Git remote push URL',
                stdout: unsetPush.stdout,
                stderr: unsetPush.stderr,
            };
        }
        stdout += unsetPush.stdout;
        stderr += unsetPush.stderr;
    } else if (pushUrl?.ok) {
        const setPush = await runGitRemoteCommand({
            context: input.context,
            args: ['remote', 'set-url', '--push', name.name, pushUrl.url],
            failureMessage: 'Failed to set Git remote push URL',
        });
        if (!setPush.ok) return setPush.response;
        stdout += setPush.stdout;
        stderr += setPush.stderr;
    }

    return successWithRemotes({
        context: input.context,
        stdout,
        stderr,
    });
}

export async function gitRemoteRemove(input: {
    context: ScmBackendContext;
    request: ScmRemoteRemoveRequest;
}): Promise<ScmRemoteManagementResponse> {
    const name = normalizeRemoteNameForRequest(input.request.name);
    if (!name.ok) return name.response;

    const current = await readGitRemotes(input.context);
    if (!current.ok) return current.response;
    if (!findRemote(current.remotes, name.name)) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
            error: `Remote "${name.name}" was not found`,
        };
    }

    const remove = await runGitRemoteCommand({
        context: input.context,
        args: ['remote', 'remove', name.name],
        failureMessage: 'Failed to remove Git remote',
    });
    if (!remove.ok) return remove.response;

    return successWithRemotes({
        context: input.context,
        stdout: remove.stdout,
        stderr: remove.stderr,
    });
}
