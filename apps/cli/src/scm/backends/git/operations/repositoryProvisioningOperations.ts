import { access, unlink } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import {
    SCM_OPERATION_ERROR_CODES,
    normalizeScmRemoteName,
    type ScmHostingRepositoryAuthSummary,
    type ScmHostingRepositoryDescribePublishTargetsRequest,
    type ScmHostingRepositoryDescribePublishTargetsResponse,
    type ScmHostingRepositoryPublishRequest,
    type ScmHostingRepositoryPublishResponse,
    type ScmHostingRepositoryPublishTarget,
    type ScmHostingRepositorySummary,
    type ScmRemoteInfo,
    type ScmRepositoryInitRequest,
    type ScmRepositoryInitResponse,
    type ScmRepositoryRemoveIndexLockRequest,
    type ScmRepositoryRemoveIndexLockResponse,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import { defaultScmHostingProviderRegistry } from '../../../hostingProviders/registry';
import type { ScmHostingProviderAdapter } from '../../../hostingProviders/types';
import { githubCliScmHostingProviderAdapter } from '../../../hostingProviders/providers/githubCliAdapter';
import { detectGithubCliAuth } from '../../../hostingProviders/providers/githubCliDetection';
import { githubRestScmHostingProviderAdapter } from '../../../hostingProviders/providers/githubRestAdapter';
import { runScmCommand } from '../../../runtime';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import { mapGitErrorCode } from '../remote';
import { detectGitRepo, getGitSnapshot } from '../repository';
import { resolveGithubConnectedAccountAuth } from './pullRequestOperationHelpers';
import { gitRemoteAdd, gitRemoteSetUrl } from './remoteManagementOperations';
import { gitRemotePublish } from './publishOperations';

type GithubCliAuthDetector = typeof detectGithubCliAuth;

type GitRepositoryProvisioningOperationDeps = Readonly<{
    githubRestAdapter?: ScmHostingProviderAdapter;
    githubCliAdapter?: ScmHostingProviderAdapter;
    detectGithubCliAuth?: GithubCliAuthDetector;
}>;

const DEFAULT_GITHUB_PROVIDER_BASE_URL = 'https://github.com';

function repositoryOperationUnsupportedResponse(): ScmHostingRepositoryDescribePublishTargetsResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: 'Repository publishing is supported for GitHub repositories in this version.',
    };
}

async function readGitSnapshot(context: ScmBackendContext): Promise<ScmWorkingSnapshot | null> {
    const response = await getGitSnapshot({ context });
    return response.success && response.snapshot ? response.snapshot : null;
}

function isPathInsideDirectory(parentPath: string, childPath: string): boolean {
    const relativePath = relative(parentPath, childPath);
    return relativePath.length > 0
        && relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath);
}

function isPathInsideAnyDirectory(parentPaths: readonly string[], childPath: string): boolean {
    return parentPaths.some((parentPath) => isPathInsideDirectory(parentPath, childPath));
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function readGitResolvedPath(input: Readonly<{
    cwd: string;
    args: readonly string[];
}>): Promise<string | null> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: [...input.args],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!result.success) {
        return null;
    }
    const output = result.stdout.trim();
    if (!output) {
        return null;
    }
    return isAbsolute(output) ? resolve(output) : resolve(input.cwd, output);
}

function sanitizeRepositoryName(input: string): string {
    const sanitized = input
        .trim()
        .replace(/\.git$/i, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return sanitized || 'repository';
}

function defaultRepositoryNameFromContext(context: ScmBackendContext): string {
    return sanitizeRepositoryName(basename(context.detection.rootPath ?? context.cwd));
}

function chooseRemoteUrl(input: {
    repository: ScmHostingRepositorySummary;
    kind: ScmHostingRepositoryPublishRequest['remoteUrlKind'];
}): string {
    if (input.kind === 'ssh' && input.repository.sshUrl) {
        return input.repository.sshUrl;
    }
    return input.repository.cloneUrl ?? input.repository.url;
}

function findRemote(snapshot: ScmWorkingSnapshot, name: string): ScmRemoteInfo | null {
    return snapshot.repo.remotes?.find((remote) => remote.name === name) ?? null;
}

function validatePublishRemoteName(
    remoteName: string,
): { ok: true; remoteName: string } | { ok: false; response: ScmHostingRepositoryPublishResponse } {
    const normalized = normalizeScmRemoteName(remoteName);
    if (!normalized.ok) {
        return {
            ok: false,
            response: {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: normalized.error,
            },
        };
    }
    return {
        ok: true,
        remoteName: normalized.name,
    };
}

async function assertBranchCanBePushed(input: {
    context: ScmBackendContext;
    snapshot: ScmWorkingSnapshot;
}): Promise<{ ok: true } | { ok: false; response: ScmHostingRepositoryPublishResponse }> {
    if (!input.snapshot.branch.head || input.snapshot.branch.detached) {
        return {
            ok: false,
            response: {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Publishing is unavailable while HEAD is detached or no branch is checked out.',
            },
        };
    }
    const head = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['rev-parse', '--verify', 'HEAD'],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!head.success) {
        return {
            ok: false,
            response: {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
                error: 'Create an initial commit before publishing this repository.',
                stdout: head.stdout,
                stderr: head.stderr,
            },
        };
    }
    return { ok: true };
}

function githubAuthSummary(kind: ScmHostingRepositoryAuthSummary['kind']): ScmHostingRepositoryAuthSummary {
    return kind === 'gh-cli' || kind === 'none'
        ? { kind, authenticated: kind !== 'none', installableKey: 'gh' }
        : { kind, authenticated: true };
}

function resolveGithubProviderBaseUrl(snapshot: ScmWorkingSnapshot | null): string {
    return snapshot?.hostingProvider?.kind === 'github'
        ? snapshot.hostingProvider.baseUrl
        : DEFAULT_GITHUB_PROVIDER_BASE_URL;
}

function mapProviderTargetsToAuthResponse(input: {
    targets: readonly ScmHostingRepositoryPublishTarget[];
    authKind: ScmHostingRepositoryAuthSummary['kind'];
    defaultRepositoryName: string;
}): ScmHostingRepositoryDescribePublishTargetsResponse {
    return {
        success: true,
        auth: githubAuthSummary(input.authKind),
        defaultRepositoryName: input.defaultRepositoryName,
        targets: [...input.targets],
    };
}

async function createRepositoryWithBestAvailableAuth(input: {
    context: ScmBackendContext;
    request: ScmHostingRepositoryPublishRequest;
    providerBaseUrl: string;
    githubRestAdapter: ScmHostingProviderAdapter;
    githubCliAdapter: ScmHostingProviderAdapter;
    detectCliAuth: GithubCliAuthDetector;
}): Promise<
    | { ok: true; repository: ScmHostingRepositorySummary }
    | { ok: false; response: ScmHostingRepositoryPublishResponse }
> {
    let restFailure: ScmHostingRepositoryPublishResponse | null = null;
    const githubConnectedAccountAuth = await resolveGithubConnectedAccountAuth({
        context: input.context,
        providerBaseUrl: input.providerBaseUrl,
    });
    if (githubConnectedAccountAuth.kind === 'available' && input.githubRestAdapter.createRepository) {
        try {
            return {
                ok: true,
                repository: await input.githubRestAdapter.createRepository({
                    providerBaseUrl: input.providerBaseUrl,
                    token: githubConnectedAccountAuth.token,
                    owner: input.request.owner,
                    ownerKind: input.request.ownerKind,
                    repositoryName: input.request.repositoryName,
                    visibility: input.request.visibility,
                    description: input.request.description,
                }),
            };
        } catch (error) {
            restFailure = {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: error instanceof Error ? error.message : 'GitHub repository creation failed.',
            };
        }
    }

    const cliAuth = await input.detectCliAuth({ providerBaseUrl: input.providerBaseUrl });
    if (cliAuth.kind !== 'authenticated' || !input.githubCliAdapter.createRepository) {
        if (restFailure) {
            return {
                ok: false,
                response: restFailure,
            };
        }
        return {
            ok: false,
            response: {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED,
                error: 'Connect GitHub or authenticate the GitHub CLI before publishing this repository.',
            },
        };
    }

    try {
        return {
            ok: true,
            repository: await input.githubCliAdapter.createRepository({
                providerBaseUrl: input.providerBaseUrl,
                owner: input.request.owner,
                ownerKind: input.request.ownerKind,
                repositoryName: input.request.repositoryName,
                visibility: input.request.visibility,
                description: input.request.description,
            }),
        };
    } catch (error) {
        return {
            ok: false,
            response: {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: error instanceof Error ? error.message : 'GitHub CLI repository creation failed.',
            },
        };
    }
}

export function createGitRepositoryProvisioningBackend(
    deps: GitRepositoryProvisioningOperationDeps = {},
) {
    const githubRestAdapter = deps.githubRestAdapter ?? githubRestScmHostingProviderAdapter;
    const githubCliAdapter = deps.githubCliAdapter ?? githubCliScmHostingProviderAdapter;
    const detectCliAuth = deps.detectGithubCliAuth ?? detectGithubCliAuth;

    async function init(input: {
        context: ScmBackendContext;
        request: ScmRepositoryInitRequest;
    }): Promise<ScmRepositoryInitResponse> {
        const existingDetection = await detectGitRepo({ cwd: input.context.cwd });
        if (existingDetection.isRepo) {
            const snapshot = await readGitSnapshot({
                ...input.context,
                detection: existingDetection,
            });
            return {
                success: true,
                alreadyInitialized: true,
                ...(snapshot ? { snapshot } : {}),
            };
        }

        if (input.request.initialBranch) {
            const checkBranch = await runScmCommand({
                bin: 'git',
                cwd: input.context.cwd,
                args: ['check-ref-format', '--branch', input.request.initialBranch],
                timeoutMs: 10_000,
                env: buildScmNonInteractiveEnv(),
            });
            if (!checkBranch.success) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: checkBranch.stderr || 'Initial branch name is invalid.',
                    stdout: checkBranch.stdout,
                    stderr: checkBranch.stderr,
                };
            }
        }

        const result = await runScmCommand({
            bin: 'git',
            cwd: input.context.cwd,
            args: ['init'],
            timeoutMs: 30_000,
            env: buildScmNonInteractiveEnv(),
        });
        if (!result.success) {
            return {
                success: false,
                errorCode: mapGitErrorCode(result.stderr),
                error: result.stderr || 'Failed to initialize Git repository.',
                stdout: result.stdout,
                stderr: result.stderr,
            };
        }

        if (input.request.initialBranch) {
            const setHead = await runScmCommand({
                bin: 'git',
                cwd: input.context.cwd,
                args: ['symbolic-ref', 'HEAD', `refs/heads/${input.request.initialBranch}`],
                timeoutMs: 10_000,
                env: buildScmNonInteractiveEnv(),
            });
            if (!setHead.success) {
                return {
                    success: false,
                    errorCode: mapGitErrorCode(setHead.stderr),
                    error: setHead.stderr || 'Failed to set initial Git branch.',
                    stdout: setHead.stdout,
                    stderr: setHead.stderr,
                };
            }
        }

        const detection = await detectGitRepo({ cwd: input.context.cwd });
        const snapshot = await readGitSnapshot({
            ...input.context,
            detection,
        });
        return {
            success: true,
            alreadyInitialized: false,
            ...(snapshot ? { snapshot } : {}),
            stdout: result.stdout,
            stderr: result.stderr,
        };
    }

    async function describePublishTargets(input: {
        context: ScmBackendContext;
        request: ScmHostingRepositoryDescribePublishTargetsRequest;
    }): Promise<ScmHostingRepositoryDescribePublishTargetsResponse> {
        if (input.request.providerKind && input.request.providerKind !== 'github') {
            return repositoryOperationUnsupportedResponse();
        }

        const snapshot = input.context.detection.isRepo ? await readGitSnapshot(input.context) : null;
        const providerBaseUrl = resolveGithubProviderBaseUrl(snapshot);
        const githubConnectedAccountAuth = await resolveGithubConnectedAccountAuth({
            context: input.context,
            providerBaseUrl,
        });
        if (githubConnectedAccountAuth.kind === 'available' && githubRestAdapter.listRepositoryPublishTargets) {
            try {
                return mapProviderTargetsToAuthResponse({
                    authKind: 'connected-account',
                    defaultRepositoryName: defaultRepositoryNameFromContext(input.context),
                    targets: await githubRestAdapter.listRepositoryPublishTargets({
                        providerBaseUrl,
                        token: githubConnectedAccountAuth.token,
                    }),
                });
            } catch {
                // Fall through to local gh. A stale connected account should not block an authenticated local CLI.
            }
        }

        const cliAuth = await detectCliAuth({ providerBaseUrl });
        if (cliAuth.kind === 'authenticated' && githubCliAdapter.listRepositoryPublishTargets) {
            try {
                return mapProviderTargetsToAuthResponse({
                    authKind: 'gh-cli',
                    defaultRepositoryName: defaultRepositoryNameFromContext(input.context),
                    targets: await githubCliAdapter.listRepositoryPublishTargets({
                        providerBaseUrl,
                    }),
                });
            } catch (error) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: error instanceof Error ? error.message : 'Failed to read GitHub publish targets.',
                };
            }
        }

        return {
            success: true,
            auth: githubAuthSummary('none'),
            defaultRepositoryName: defaultRepositoryNameFromContext(input.context),
            targets: [],
        };
    }

    async function publishToHostingProvider(input: {
        context: ScmBackendContext;
        request: ScmHostingRepositoryPublishRequest;
    }): Promise<ScmHostingRepositoryPublishResponse> {
        if (input.request.providerKind !== 'github') {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'Repository publishing is supported for GitHub repositories in this version.',
            };
        }

        const snapshot = await readGitSnapshot(input.context);
        if (!snapshot) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: 'Failed to evaluate repository state before publishing.',
            };
        }

        if (input.request.pushCurrentBranch) {
            const branchCheck = await assertBranchCanBePushed({
                context: input.context,
                snapshot,
            });
            if (!branchCheck.ok) return branchCheck.response;
        }

        const validatedRemoteName = validatePublishRemoteName(input.request.remoteName ?? 'origin');
        if (!validatedRemoteName.ok) return validatedRemoteName.response;
        const remoteName = validatedRemoteName.remoteName;
        const existingRemote = findRemote(snapshot, remoteName);
        const remoteConflictStrategy = input.request.remoteConflictStrategy ?? 'fail';
        if (existingRemote && remoteConflictStrategy === 'fail') {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
                error: `Remote "${remoteName}" already exists.`,
            };
        }

        if (input.request.ownerKind !== 'user' && input.request.ownerKind !== 'org') {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Repository publishing requires an explicit repository owner kind.',
            };
        }

        const providerBaseUrl = resolveGithubProviderBaseUrl(snapshot);
        const created = await createRepositoryWithBestAvailableAuth({
            context: input.context,
            request: input.request,
            providerBaseUrl,
            githubRestAdapter,
            githubCliAdapter,
            detectCliAuth,
        });
        if (!created.ok) return created.response;

        const remoteUrl = chooseRemoteUrl({
            repository: created.repository,
            kind: input.request.remoteUrlKind ?? 'https',
        });
        const remoteResponse = existingRemote
            ? await gitRemoteSetUrl({
                context: input.context,
                request: {
                    name: remoteName,
                    fetchUrl: remoteUrl,
                    pushUrl: remoteUrl,
                },
            })
            : await gitRemoteAdd({
                context: input.context,
                request: {
                    name: remoteName,
                    fetchUrl: remoteUrl,
                    pushUrl: remoteUrl,
                },
            });
        if (!remoteResponse.success) {
            return {
                success: false,
                errorCode: remoteResponse.errorCode,
                error: remoteResponse.error ?? 'Failed to update Git remote.',
                stdout: remoteResponse.stdout,
                stderr: remoteResponse.stderr,
            };
        }

        if (input.request.pushCurrentBranch) {
            const push = await gitRemotePublish({
                context: input.context,
                request: { remote: remoteName },
            });
            if (!push.success) {
                return {
                    success: false,
                    errorCode: push.errorCode,
                    error: push.error ?? 'Failed to push current branch.',
                    stdout: push.stdout,
                    stderr: push.stderr,
                };
            }
        }

        const updatedSnapshot = await readGitSnapshot(input.context);
        const remote = updatedSnapshot
            ? findRemote(updatedSnapshot, remoteName)
            : remoteResponse.remotes?.find((entry) => entry.name === remoteName) ?? null;
        if (!remote) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: 'Repository was created, but the Git remote could not be verified.',
            };
        }

        const provider = defaultScmHostingProviderRegistry.detectRemote({
            remoteName,
            remoteUrl,
        });

        return {
            success: true,
            repository: {
                ...created.repository,
                provider: provider ?? created.repository.provider,
            },
            remote,
            pushed: input.request.pushCurrentBranch === true,
            ...(updatedSnapshot ? { snapshot: updatedSnapshot } : {}),
        };
    }

    async function removeIndexLock(input: {
        context: ScmBackendContext;
        request: ScmRepositoryRemoveIndexLockRequest;
    }): Promise<ScmRepositoryRemoveIndexLockResponse> {
        const gitPath = await runScmCommand({
            bin: 'git',
            cwd: input.context.cwd,
            args: ['rev-parse', '--git-path', 'index.lock'],
            timeoutMs: 10_000,
            env: buildScmNonInteractiveEnv(),
        });
        if (!gitPath.success) {
            return {
                success: false,
                errorCode: mapGitErrorCode(gitPath.stderr),
                error: gitPath.stderr || 'Failed to locate the Git index lock.',
            };
        }

        const lockPathOutput = gitPath.stdout.trim();
        const lockPath = isAbsolute(lockPathOutput)
            ? resolve(lockPathOutput)
            : resolve(input.context.cwd, lockPathOutput);
        const safeRoots = [
            input.context.detection.rootPath ? resolve(input.context.detection.rootPath) : null,
            await readGitResolvedPath({
                cwd: input.context.cwd,
                args: ['rev-parse', '--absolute-git-dir'],
            }),
            await readGitResolvedPath({
                cwd: input.context.cwd,
                args: ['rev-parse', '--git-common-dir'],
            }),
        ].filter((root): root is string => typeof root === 'string');
        if (
            basename(lockPath) !== 'index.lock'
            || lockPathOutput.split(/[\\/]+/).includes('..')
            || (safeRoots.length > 0 && !isPathInsideAnyDirectory(safeRoots, lockPath))
        ) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Git reported an unsafe index lock path.',
            };
        }

        if (!(await pathExists(lockPath))) {
            const snapshot = await readGitSnapshot(input.context);
            return {
                success: true,
                removed: false,
                lockPath,
                ...(snapshot ? { snapshot } : {}),
            };
        }

        try {
            await unlink(lockPath);
        } catch (error) {
            const maybeNodeError = error as { code?: unknown; message?: unknown };
            if (maybeNodeError.code !== 'ENOENT') {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: typeof maybeNodeError.message === 'string'
                        ? maybeNodeError.message
                        : 'Failed to remove the Git index lock.',
                };
            }
        }

        const snapshot = await readGitSnapshot(input.context);
        return {
            success: true,
            removed: true,
            lockPath,
            ...(snapshot ? { snapshot } : {}),
        };
    }

    return {
        init,
        describePublishTargets,
        publishToHostingProvider,
        removeIndexLock,
    };
}
