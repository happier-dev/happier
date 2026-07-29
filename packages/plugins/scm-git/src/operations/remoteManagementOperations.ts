import type {
  ScmRemoteAddRequest,
  ScmRemoteInfo,
  ScmRemoteManagementResponse,
  ScmRemoteRemoveRequest,
  ScmRemoteSetUrlRequest,
} from '@happier-dev/plugin-sdk/experimental/scm';
import {
  SCM_OPERATION_ERROR_CODES,
  normalizeScmRemoteName,
  normalizeScmRemoteUrl,
} from '@happier-dev/plugin-sdk/experimental/scm';

import { runScmCommand } from '../runtime.js';
import type { ScmBackendContext } from '../types.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { mapGitErrorCode } from '../remote.js';
import { invalidatePrStatusCacheAfterSuccessfulScmMutation } from '../hostingProviders/prStatusCacheInvalidation.js';
import { parseGitRemoteVerbose } from '../remoteListParser.js';

const GIT_REMOTE_MANAGEMENT_TIMEOUT_MS = 30_000;
const ALLOWED_REMOTE_URL_SCHEMES = new Set(['https:', 'ssh:', 'git:', 'file:']);
const TRANSPORT_HELPER_URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*::/;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const SCP_LIKE_REMOTE_PATTERN = /^(?:[^@\s]+@)?[^:\s]+:.+$/;

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
    if (normalized.ok) {
        const safety = validateAllowedGitRemoteUrl(normalized.url, label);
        if (!safety.ok) return { ok: false, response: invalidRequest(safety.error) };
    }
    return normalized.ok
        ? normalized
        : { ok: false, response: invalidRequest(normalized.error) };
}

function validateAllowedGitRemoteUrl(
    url: string,
    label: string,
): { ok: true } | { ok: false; error: string } {
    const trimmed = url.trim();
    if (TRANSPORT_HELPER_URL_PATTERN.test(trimmed)) {
        return { ok: false, error: `${label} uses an unsupported Git transport helper` };
    }
    if (SCP_LIKE_REMOTE_PATTERN.test(trimmed) && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) {
        return { ok: true };
    }
    const schemeMatch = URL_SCHEME_PATTERN.exec(trimmed);
    if (!schemeMatch || WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) {
        return { ok: true };
    }
    const scheme = schemeMatch[0].toLowerCase();
    return ALLOWED_REMOTE_URL_SCHEMES.has(scheme)
        ? { ok: true }
        : { ok: false, error: `${label} uses unsupported scheme "${scheme}"` };
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

async function clearGitRemotePushUrl(input: {
    context: ScmBackendContext;
    remoteName: string;
}): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; response: ScmRemoteManagementResponse }> {
    const unsetPush = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['config', '--unset-all', `remote.${input.remoteName}.pushurl`],
        timeoutMs: GIT_REMOTE_MANAGEMENT_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv(),
    });
    if (!unsetPush.success && unsetPush.exitCode !== 5) {
        return {
            ok: false,
            response: {
                success: false,
                errorCode: mapGitErrorCode(unsetPush.stderr),
                error: unsetPush.stderr || 'Failed to clear Git remote push URL',
                stdout: unsetPush.stdout,
                stderr: unsetPush.stderr,
            },
        };
    }
    return {
        ok: true,
        stdout: unsetPush.stdout,
        stderr: unsetPush.stderr,
    };
}

async function rollbackGitRemoteUrls(input: {
    context: ScmBackendContext;
    remoteName: string;
    previousRemote: ScmRemoteInfo;
}): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; response: ScmRemoteManagementResponse }> {
    let stdout = '';
    let stderr = '';
    const previousFetchUrl = input.previousRemote.fetchUrl;
    const previousPushUrl = input.previousRemote.pushUrl;

    if (!previousFetchUrl) {
        return {
            ok: false,
            response: {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: 'Failed to restore Git remote fetch URL because the previous fetch URL is unavailable',
            },
        };
    }

    const restoreFetch = await runGitRemoteCommand({
        context: input.context,
        args: ['remote', 'set-url', input.remoteName, previousFetchUrl],
        failureMessage: 'Failed to restore Git remote fetch URL',
    });
    if (!restoreFetch.ok) return restoreFetch;
    stdout += restoreFetch.stdout;
    stderr += restoreFetch.stderr;

    const restorePush = !previousPushUrl || previousPushUrl === previousFetchUrl
        ? await clearGitRemotePushUrl({
            context: input.context,
            remoteName: input.remoteName,
        })
        : await runGitRemoteCommand({
            context: input.context,
            args: ['remote', 'set-url', '--push', input.remoteName, previousPushUrl],
            failureMessage: 'Failed to restore Git remote push URL',
        });
    if (!restorePush.ok) return restorePush;
    stdout += restorePush.stdout;
    stderr += restorePush.stderr;

    return {
        ok: true,
        stdout,
        stderr,
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
        if (!setPush.ok) {
            const rollback = await runGitRemoteCommand({
                context: input.context,
                args: ['remote', 'remove', name.name],
                failureMessage: 'Failed to roll back Git remote add',
            });
            if (!rollback.ok) {
                return {
                    ...setPush.response,
                    error: `${setPush.response.error}\nRollback failed: ${rollback.response.error}`,
                    stdout: [setPush.response.stdout, rollback.response.stdout].filter(Boolean).join('\n'),
                    stderr: [setPush.response.stderr, rollback.response.stderr].filter(Boolean).join('\n'),
                };
            }
            return setPush.response;
        }
    }

    const response = await successWithRemotes({
        context: input.context,
        stdout: add.stdout,
        stderr: add.stderr,
    });
    invalidatePrStatusCacheAfterSuccessfulScmMutation({ response, context: input.context });
    return response;
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
    const previousRemote = findRemote(current.remotes, name.name);
    if (!previousRemote) {
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
        const unsetPush = await clearGitRemotePushUrl({
            context: input.context,
            remoteName: name.name,
        });
        if (!unsetPush.ok) {
            const rollback = fetchUrl?.ok
                ? await rollbackGitRemoteUrls({
                    context: input.context,
                    remoteName: name.name,
                    previousRemote,
                })
                : null;
            if (rollback && !rollback.ok) {
                return {
                    ...unsetPush.response,
                    error: `${unsetPush.response.error}\nRollback failed: ${rollback.response.error}`,
                    stdout: [stdout, unsetPush.response.stdout, rollback.response.stdout].filter(Boolean).join('\n'),
                    stderr: [stderr, unsetPush.response.stderr, rollback.response.stderr].filter(Boolean).join('\n'),
                };
            }
            return rollback
                ? {
                    ...unsetPush.response,
                    stdout: [stdout, unsetPush.response.stdout, rollback.stdout].filter(Boolean).join('\n'),
                    stderr: [stderr, unsetPush.response.stderr, rollback.stderr].filter(Boolean).join('\n'),
                }
                : unsetPush.response;
        }
        stdout += unsetPush.stdout;
        stderr += unsetPush.stderr;
    } else if (pushUrl?.ok) {
        const setPush = await runGitRemoteCommand({
            context: input.context,
            args: ['remote', 'set-url', '--push', name.name, pushUrl.url],
            failureMessage: 'Failed to set Git remote push URL',
        });
        if (!setPush.ok) {
            const rollback = fetchUrl?.ok
                ? await rollbackGitRemoteUrls({
                    context: input.context,
                    remoteName: name.name,
                    previousRemote,
                })
                : null;
            if (rollback && !rollback.ok) {
                return {
                    ...setPush.response,
                    error: `${setPush.response.error}\nRollback failed: ${rollback.response.error}`,
                    stdout: [stdout, setPush.response.stdout, rollback.response.stdout].filter(Boolean).join('\n'),
                    stderr: [stderr, setPush.response.stderr, rollback.response.stderr].filter(Boolean).join('\n'),
                };
            }
            return rollback
                ? {
                    ...setPush.response,
                    stdout: [stdout, setPush.response.stdout, rollback.stdout].filter(Boolean).join('\n'),
                    stderr: [stderr, setPush.response.stderr, rollback.stderr].filter(Boolean).join('\n'),
                }
                : setPush.response;
        }
        stdout += setPush.stdout;
        stderr += setPush.stderr;
    }

    const response = await successWithRemotes({
        context: input.context,
        stdout,
        stderr,
    });
    invalidatePrStatusCacheAfterSuccessfulScmMutation({ response, context: input.context });
    return response;
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

    const response = await successWithRemotes({
        context: input.context,
        stdout: remove.stdout,
        stderr: remove.stderr,
    });
    invalidatePrStatusCacheAfterSuccessfulScmMutation({ response, context: input.context });
    return response;
}
