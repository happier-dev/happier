import { basename } from 'node:path';

import {
  evaluateScmRemoteMutationPreconditions,
  SCM_OPERATION_ERROR_CODES,
  normalizeScmRemoteName,
  type ScmHostingRepositoryDescribePublishTargetsRequest,
  type ScmHostingRepositoryDescribePublishTargetsResponse,
  type ScmHostingRepositoryPublishRequest,
  type ScmHostingRepositoryPublishResponse,
  type ScmHostingRepositoryRemoteUrlKind,
  type ScmHostingRepositorySummary,
  type ScmOperationErrorCode,
  type ScmRemoteInfo,
  type ScmRemoteMutationGuardResult,
  type ScmRemoteMutationKind,
  type ScmRemoteMutationReason,
  type ScmRemoteManagementResponse,
  type ScmRemotePublishResponse,
  type ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import {
  ScmHostingProviderKindSchema,
  type HostingProviderRepositoryPublishingCapability,
  type ScmHostingProviderKind,
  type ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import {
    readCurrentHostingProviderRuntimeServices as readCurrentScmHostingProviderRuntimeServices,
    type HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/hosting';
import type { ScmBackendContext } from '../types.js';
import { runScmCommand } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { invalidatePrStatusCacheAfterSuccessfulScmMutation } from '../hostingProviders/prStatusCacheInvalidation.js';
import type { ResolvedScmHostingProviderRegistry } from '../hostingProviders/types.js';
import { readScmHostingProviderRuntimeDescriptor } from '../hostingProviders/runtimeDescriptor.js';
import { gitRemoteAdd, gitRemoteSetUrl } from './remoteManagementOperations.js';
import { gitRemotePublish } from './publishOperations.js';
import { readGitSnapshotForChecks } from './snapshotChecks.js';

type HostingRepositoryRegistry = Pick<ResolvedScmHostingProviderRegistry, 'getRepositoryPublishing'> & Readonly<{
    providers?: readonly unknown[];
}>;

type ScmHostingProviderRepositoryGetInput = Readonly<{
    provider: ScmHostingProviderRef;
    owner: string;
    repositoryName: string;
    runtimeServices?: ScmHostingProviderRuntimeServices;
}>;

type ScmHostingProviderRepositoryCreateInput = ScmHostingProviderRepositoryGetInput & Readonly<{
    ownerKind?: ScmHostingRepositoryPublishRequest['ownerKind'];
    visibility: ScmHostingRepositoryPublishRequest['visibility'];
    description?: string;
}>;

type GitHostingRepositoryPublishOperationDeps = Readonly<{
    registry?: HostingRepositoryRegistry;
    runtimeServices?: ScmHostingProviderRuntimeServices;
    readSnapshot?: (input: Readonly<{ context: ScmBackendContext }>) => Promise<ScmWorkingSnapshot | null>;
    hasCurrentCommit?: (input: Readonly<{ context: ScmBackendContext }>) => Promise<boolean>;
    remoteAdd?: typeof gitRemoteAdd;
    remoteSetUrl?: typeof gitRemoteSetUrl;
    remotePublish?: typeof gitRemotePublish;
}>;

export type GitHostingRepositoryPublishOperation = Readonly<{
    describePublishTargets(input: Readonly<{
        context: ScmBackendContext;
        request: ScmHostingRepositoryDescribePublishTargetsRequest;
    }>): Promise<ScmHostingRepositoryDescribePublishTargetsResponse>;
    publish(input: Readonly<{
        context: ScmBackendContext;
        request: ScmHostingRepositoryPublishRequest;
    }>): Promise<ScmHostingRepositoryPublishResponse>;
}>;

function errorResponse(
    error: string,
    errorCode: ScmOperationErrorCode,
    extra?: Omit<Partial<Extract<ScmHostingRepositoryPublishResponse, { success: false }>>, 'success' | 'error' | 'errorCode'>,
): ScmHostingRepositoryPublishResponse {
    return {
        success: false,
        error,
        errorCode,
        ...extra,
    };
}

function mapProviderError(error: unknown): Readonly<{ message: string; code: ScmOperationErrorCode }> {
    const message = error instanceof Error ? error.message : 'Hosting repository provider operation failed';
    const code = typeof error === 'object' && error !== null
        ? (error as { errorCode?: unknown }).errorCode
        : undefined;
    return {
        message,
        code: typeof code === 'string' && Object.values(SCM_OPERATION_ERROR_CODES).includes(code as ScmOperationErrorCode)
            ? code as ScmOperationErrorCode
            : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    };
}

function normalizeRemoteNameForPublish(remoteName: string | undefined): { ok: true; remoteName: string } | { ok: false; response: ScmHostingRepositoryPublishResponse } {
    const normalized = normalizeScmRemoteName(remoteName ?? 'origin', { allowSlash: false });
    return normalized.ok
        ? { ok: true, remoteName: normalized.name }
        : {
            ok: false,
            response: errorResponse(normalized.error, SCM_OPERATION_ERROR_CODES.INVALID_REQUEST),
        };
}

function findRemote(snapshot: ScmWorkingSnapshot, remoteName: string): ScmRemoteInfo | null {
    return snapshot.repo.remotes.find((remote) => remote.name === remoteName) ?? null;
}

function remoteUrlForRepository(
    repository: ScmHostingRepositorySummary,
    requestedKind: ScmHostingRepositoryRemoteUrlKind | undefined,
): string | null {
    if (requestedKind === 'ssh') return repository.sshUrl ?? null;
    if (requestedKind === 'https') return repository.cloneUrl ?? null;
    return repository.cloneUrl ?? repository.sshUrl ?? null;
}

function readRemoteFromManagementResponse(
    response: ScmRemoteManagementResponse,
    remoteName: string,
    remoteUrl: string,
): ScmRemoteInfo {
    return response.remotes?.find((remote) => remote.name === remoteName) ?? {
        name: remoteName,
        fetchUrl: remoteUrl,
        pushUrl: remoteUrl,
    };
}

function existingRemoteMatchesTarget(remote: ScmRemoteInfo, remoteUrl: string): boolean {
    return remote.fetchUrl === remoteUrl && (remote.pushUrl ?? remote.fetchUrl) === remoteUrl;
}

function mapPublishPreconditionFailure(
    kind: ScmRemoteMutationKind,
    reason: ScmRemoteMutationReason,
): Exclude<ScmRemoteMutationGuardResult, { ok: true }> {
    switch (reason) {
        case 'conflicts_present':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                error: 'Resolve conflicts before publishing.',
            };
        case 'detached_head':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Publish is unavailable while HEAD is detached',
            };
        case 'branch_behind_remote':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
                error: 'Local branch is behind upstream. Pull before publishing.',
            };
        case 'clean_worktree_required':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                error: 'Working tree must be clean before publishing',
            };
        case 'upstream_required':
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                error: kind === 'push' ? 'Set an upstream branch before publishing.' : 'Set an upstream branch before publishing.',
            };
        default:
            return {
                ok: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: 'Publish preconditions failed',
            };
    }
}

function evaluatePublishPreconditions(snapshot: ScmWorkingSnapshot): ScmRemoteMutationGuardResult {
    return evaluateScmRemoteMutationPreconditions({
        kind: 'push',
        snapshot,
        hasExplicitTarget: true,
        policy: {
            requireUpstreamWhenNoExplicitTarget: false,
            requireActiveHead: true,
            blockPushOnConflicts: true,
            blockPushWhenBehind: true,
            requireCleanPull: false,
        },
        mapReasonToError: mapPublishPreconditionFailure,
    });
}

function invalidateAfterPublishMutation(input: Readonly<{
    context: ScmBackendContext;
    headBranch?: string | null;
}>): void {
    invalidatePrStatusCacheAfterSuccessfulScmMutation({
        response: { success: true },
        context: input.context,
        headBranch: input.headBranch,
    });
}

function providerRefFromDescriptor(input: Readonly<{
    registry: HostingRepositoryRegistry;
    providerId?: string;
    providerKind?: ScmHostingProviderKind;
}>): ScmHostingProviderRef | null {
    const provider = input.registry.providers
        ?.map(readScmHostingProviderRuntimeDescriptor)
        .filter((entry) => entry !== null)
        .find((entry) => input.providerId
            ? entry.id === input.providerId && (!input.providerKind || entry.kind === input.providerKind)
            : !input.providerKind || entry.kind === input.providerKind);
    if (!provider) return null;
    const providerKind = ScmHostingProviderKindSchema.safeParse(provider.kind);
    if (!providerKind.success) return null;
    return {
        id: provider.id,
        kind: providerKind.data,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        urlSafety: {
            ...(provider.urlSafety?.allowedBaseUrls ? { allowedBaseUrls: [...provider.urlSafety.allowedBaseUrls] } : {}),
            ...(provider.urlSafety?.allowedOrigins ? { allowedOrigins: [...provider.urlSafety.allowedOrigins] } : {}),
            allowedSchemes: [...(provider.urlSafety?.allowedSchemes ?? ['https:'])],
        },
    };
}

async function readHasCurrentCommit(input: Readonly<{ context: ScmBackendContext }>): Promise<boolean> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['rev-parse', '--verify', 'HEAD'],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    return result.success;
}

async function createOrReuseRepository(input: Readonly<{
    adapter: HostingProviderRepositoryPublishingCapability;
    provider: ScmHostingProviderRef;
    request: ScmHostingRepositoryPublishRequest;
    runtimeServices: ScmHostingProviderRuntimeServices;
}>): Promise<ScmHostingRepositorySummary> {
    const getInput: ScmHostingProviderRepositoryGetInput = {
        provider: input.provider,
        owner: input.request.owner,
        repositoryName: input.request.repositoryName,
        runtimeServices: input.runtimeServices,
    };
    const existing = await input.adapter.getRepository(getInput);
    if (existing) return existing;
    return input.adapter.createRepository({
        provider: input.provider,
        owner: input.request.owner,
        ...(input.request.ownerKind ? { ownerKind: input.request.ownerKind } : {}),
        repositoryName: input.request.repositoryName,
        visibility: input.request.visibility,
        ...(input.request.description !== undefined ? { description: input.request.description } : {}),
        runtimeServices: input.runtimeServices,
    });
}

export function createGitHostingRepositoryPublishOperation(
    deps?: GitHostingRepositoryPublishOperationDeps,
): GitHostingRepositoryPublishOperation {
    async function readRegistry(): Promise<HostingRepositoryRegistry> {
        if (deps?.registry) return deps.registry;
        const { resolveDefaultPullRequestStatusProjectionRegistry } = await import('./pullRequestStatusProjection.js');
        return await resolveDefaultPullRequestStatusProjectionRegistry();
    }

    function readRuntimeServices(): ScmHostingProviderRuntimeServices {
        if (deps?.runtimeServices) return deps.runtimeServices;
        const currentServices = readCurrentScmHostingProviderRuntimeServices();
        if (currentServices) return currentServices;
        throw new Error('Git hosting repository publish operations require host-injected SCM hosting provider runtime services.');
    }

    const readSnapshot = deps?.readSnapshot ?? (async ({ context }) => {
        const response = await readGitSnapshotForChecks(context);
        return response.success ? response.snapshot ?? null : null;
    });
    const hasCurrentCommit = deps?.hasCurrentCommit ?? readHasCurrentCommit;
    const remoteAdd = deps?.remoteAdd ?? gitRemoteAdd;
    const remoteSetUrl = deps?.remoteSetUrl ?? gitRemoteSetUrl;
    const remotePublish = deps?.remotePublish ?? gitRemotePublish;

    return Object.freeze({
        async publish({ context, request }) {
            const remoteName = normalizeRemoteNameForPublish(request.remoteName);
            if (!remoteName.ok) return remoteName.response;

            const snapshot = await readSnapshot({ context });
            if (!snapshot) {
                return errorResponse(
                    'Failed to evaluate repository state',
                    SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                );
            }
            if (request.pushCurrentBranch && !await hasCurrentCommit({ context })) {
                return errorResponse(
                    'Create at least one commit before publishing this branch.',
                    SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
                    {
                        remediation: {
                            kind: 'commit_required',
                        },
                    },
                );
            }
            if (request.pushCurrentBranch) {
                const guard = evaluatePublishPreconditions(snapshot);
                if (!guard.ok) {
                    return errorResponse(guard.error, guard.errorCode);
                }
            }

            const existingRemote = findRemote(snapshot, remoteName.remoteName);
            const remoteConflictStrategy = request.remoteConflictStrategy ?? 'fail';

            const registry = await readRegistry();
            const provider = providerRefFromDescriptor({
                registry,
                ...(request.providerId ? { providerId: request.providerId } : {}),
                providerKind: request.providerKind,
            });
            if (!provider) {
                return errorResponse(
                    request.providerId
                        ? `No SCM hosting provider is registered for "${request.providerId}".`
                        : `No SCM hosting provider is registered for "${request.providerKind}".`,
                    SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                    {
                        remediation: {
                            kind: 'unsupported_provider',
                        },
                    },
                );
            }

            const adapter = registry.getRepositoryPublishing(provider.id);
            if (!adapter) {
                return errorResponse(
                    `The selected hosting provider "${provider.displayName}" does not support repository publishing.`,
                    SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                    {
                        remediation: {
                            kind: 'unsupported_provider',
                        },
                    },
                );
            }

            let repository: ScmHostingRepositorySummary;
            try {
                repository = await createOrReuseRepository({
                    adapter,
                    provider,
                    request,
                    runtimeServices: readRuntimeServices(),
                });
            } catch (error) {
                const mapped = mapProviderError(error);
                return errorResponse(mapped.message, mapped.code);
            }

            const remoteUrl = remoteUrlForRepository(repository, request.remoteUrlKind);
            if (!remoteUrl) {
                return errorResponse(
                    'The created hosting repository did not provide a supported clone URL.',
                    SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                );
            }

            if (existingRemote && !existingRemoteMatchesTarget(existingRemote, remoteUrl) && remoteConflictStrategy !== 'set-url') {
                return errorResponse(
                    `Remote "${remoteName.remoteName}" already exists. Confirm set-url before replacing it.`,
                    SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
                    {
                        remediation: {
                            kind: 'set_url_required',
                        },
                    },
                );
            }

            let remote: ScmRemoteInfo;
            let remoteMutationOutput: Pick<ScmRemoteManagementResponse, 'stdout' | 'stderr'> = {};
            if (existingRemote && existingRemoteMatchesTarget(existingRemote, remoteUrl)) {
                remote = existingRemote;
            } else {
                const remoteMutation = existingRemote
                    ? await remoteSetUrl({
                        context,
                        request: {
                            cwd: request.cwd,
                            name: remoteName.remoteName,
                            fetchUrl: remoteUrl,
                        },
                    })
                    : await remoteAdd({
                        context,
                        request: {
                            cwd: request.cwd,
                            name: remoteName.remoteName,
                            fetchUrl: remoteUrl,
                        },
                    });
                if (!remoteMutation.success) {
                    return {
                        success: false,
                        error: remoteMutation.error ?? 'Failed to attach Git remote',
                        errorCode: remoteMutation.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        repository,
                        stdout: remoteMutation.stdout,
                        stderr: remoteMutation.stderr,
                    };
                }
                invalidateAfterPublishMutation({
                    context,
                    headBranch: snapshot.branch.head,
                });
                remote = readRemoteFromManagementResponse(remoteMutation, remoteName.remoteName, remoteUrl);
                remoteMutationOutput = {
                    stdout: remoteMutation.stdout,
                    stderr: remoteMutation.stderr,
                };
            }

            if (request.pushCurrentBranch) {
                const pushed = await remotePublish({
                    context,
                    request: {
                        cwd: request.cwd,
                        remote: remoteName.remoteName,
                    },
                });
                invalidateAfterPublishMutation({
                    context,
                    headBranch: snapshot.branch.head,
                });
                if (!pushed.success) {
                    return {
                        success: false,
                        error: pushed.error ?? 'Failed to publish current branch',
                        errorCode: pushed.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        repository,
                        remote,
                        stdout: pushed.stdout,
                        stderr: pushed.stderr,
                    };
                }
            }

            const response: ScmHostingRepositoryPublishResponse = {
                success: true,
                repository,
                remote,
                pushed: Boolean(request.pushCurrentBranch),
                stdout: remoteMutationOutput.stdout,
                stderr: remoteMutationOutput.stderr,
                ...(await readSnapshot({ context }).then((fresh) => fresh ? { snapshot: fresh } : {})),
            };
            return response;
        },
        async describePublishTargets({ context, request }) {
            const registry = await readRegistry();
            const provider = providerRefFromDescriptor({
                registry,
                ...(request.providerId ? { providerId: request.providerId } : {}),
                ...(request.providerKind ? { providerKind: request.providerKind } : {}),
            });
            if (!provider) {
                return errorResponse(
                    request.providerId
                        ? `No SCM hosting provider is registered for "${request.providerId}".`
                        : 'No SCM hosting provider is registered for the requested publish target.',
                    SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                    { remediation: { kind: 'unsupported_provider' } },
                ) as ScmHostingRepositoryDescribePublishTargetsResponse;
            }

            const adapter = registry.getRepositoryPublishing(provider.id);
            if (!adapter) {
                return errorResponse(
                    `The selected hosting provider "${provider.displayName}" does not support repository publish target discovery.`,
                    SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                    { remediation: { kind: 'unsupported_provider' } },
                ) as ScmHostingRepositoryDescribePublishTargetsResponse;
            }

            try {
                const defaultRepositoryName = basename(context.detection.rootPath ?? context.cwd) || 'repository';
                const result = await adapter.describePublishTargets({
                    provider,
                    defaultRepositoryName,
                    runtimeServices: readRuntimeServices(),
                });
                return {
                    success: true,
                    auth: result.auth,
                    defaultRepositoryName,
                    targets: [...result.targets],
                };
            } catch (error) {
                const mapped = mapProviderError(error);
                return errorResponse(mapped.message, mapped.code) as ScmHostingRepositoryDescribePublishTargetsResponse;
            }
        },
    });
}

export const gitHostingRepositoryPublish = createGitHostingRepositoryPublishOperation();
