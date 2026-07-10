import type {
  ScmHostingProviderRef,
  ScmOperationErrorCode,
  ScmPullRequestCheckoutRequest,
  ScmPullRequestCheckoutResponse,
  ScmPullRequestPrepareWorktreeRequest,
  ScmPullRequestPrepareWorktreeResponse,
  ScmPullRequestReference,
  ScmPullRequestSummary,
  ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import {
    readCurrentScmHostingProviderRuntimeServices,
    type ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk';

import type { ScmBackendContext } from '../types.js';
import { getGitSnapshot } from '../repository.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { runScmCommand } from '../runtime.js';
import { mapGitErrorCode } from '../remote.js';
import type { ResolvedScmHostingProviderRegistry } from '../hostingProviders/types.js';
import { resolveDefaultPullRequestStatusProjectionRegistry } from './pullRequestStatusProjection.js';
import { realizeGitWorkspaceCheckout } from '../workspaceIntegration.js';
import type {
    ScmWorkspaceIntegrationWorkspaceCheckoutRealizationInput,
    ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
} from '../types.js';

export type GitPullRequestCheckoutOperations = Readonly<{
    checkout(input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestCheckoutRequest;
    }>): Promise<ScmPullRequestCheckoutResponse>;
    prepareWorktree(input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestPrepareWorktreeRequest;
    }>): Promise<ScmPullRequestPrepareWorktreeResponse>;
}>;

type PullRequestCheckoutRegistry = Pick<ResolvedScmHostingProviderRegistry, 'getAdapter'>;

type PullRequestCheckoutMetadata = Readonly<{
    pullRequest: ScmPullRequestSummary | null;
    branch?: string;
    remoteRef?: string;
    headSha?: string | null;
    baseSha?: string | null;
}>;

type PullRequestCheckoutAdapter = Readonly<{
    resolvePullRequestCheckoutReference?: (input: Readonly<{
        provider: ScmHostingProviderRef;
        reference: ScmPullRequestReference;
        runtimeServices?: ScmHostingProviderRuntimeServices;
    }>) => Promise<PullRequestCheckoutMetadata>;
}>;

type GitPullRequestCheckoutOperationDeps = Readonly<{
    registry?: PullRequestCheckoutRegistry;
    runtimeServices?: ScmHostingProviderRuntimeServices;
    readSnapshot?: (input: Readonly<{ context: ScmBackendContext }>) => Promise<ScmWorkingSnapshot | null>;
    realizeWorkspaceCheckout?: (
        input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationInput,
    ) => Promise<ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult>;
}>;

function errorResponse(error: string, errorCode: ScmOperationErrorCode): ScmPullRequestCheckoutResponse & ScmPullRequestPrepareWorktreeResponse {
    return { success: false, error, errorCode };
}

function resolveProvider(snapshot: ScmWorkingSnapshot): ScmHostingProviderRef | null {
    const provider = snapshot.hostingProvider ?? snapshot.pullRequestStatus?.provider ?? null;
    if (!provider) return null;
    return {
        ...provider,
        urlSafety: provider.urlSafety ?? { allowedSchemes: ['https:'] },
    };
}

function isPullRequestCheckoutAdapter(adapter: unknown): adapter is PullRequestCheckoutAdapter {
    return Boolean(
        adapter
        && typeof adapter === 'object'
        && typeof (adapter as PullRequestCheckoutAdapter).resolvePullRequestCheckoutReference === 'function',
    );
}

function validateBranchName(branch: string): { ok: true } | { ok: false; error: string } {
    if (!branch.trim()) return { ok: false, error: 'Pull request branch is required' };
    if (
        branch !== branch.trim()
        || branch.startsWith('-')
        || branch.startsWith('+')
        || branch.startsWith('.')
        || branch.startsWith('/')
        || branch.endsWith('/')
        || branch.endsWith('.')
        || branch.endsWith('.lock')
        || branch.includes('\\')
        || branch.includes('//')
        || branch.includes('@{')
        || branch.includes('..')
        || /[\s\0-\x1f\x7f:~^?*\[]/.test(branch)
    ) {
        return { ok: false, error: 'Pull request branch contains unsupported syntax' };
    }
    return { ok: true };
}

function validateFetchRemoteName(remoteName: string): { ok: true } | { ok: false; error: string } {
    if (!remoteName.trim()) return { ok: false, error: 'Pull request checkout requires a configured remote' };
    if (
        remoteName !== remoteName.trim()
        || remoteName.startsWith('-')
        || /[\s\0-\x1f\x7f:/\\]/.test(remoteName)
        || remoteName.includes('..')
        || remoteName.includes('@{')
        || remoteName === '.'
    ) {
        return { ok: false, error: 'Pull request checkout remote name contains unsupported syntax' };
    }
    return { ok: true };
}

function validateProviderCheckoutRef(remoteRef: string): { ok: true } | { ok: false; error: string } {
    if (
        remoteRef !== remoteRef.trim()
        || !remoteRef.startsWith('refs/')
        || remoteRef.startsWith('-')
        || remoteRef.endsWith('/')
        || remoteRef.endsWith('.')
        || /[\s\0-\x1f\x7f:~^?*[\\]/.test(remoteRef)
        || remoteRef.includes('..')
        || remoteRef.includes('@{')
        || remoteRef.split('/').some((segment) => (
            !segment
            || segment === '.'
            || segment === '..'
            || segment.startsWith('.')
            || segment.endsWith('.lock')
        ))
    ) {
        return { ok: false, error: 'Pull request checkout ref contains unsupported syntax' };
    }
    return { ok: true };
}

async function readRef(input: Readonly<{ cwd: string; ref: string }>): Promise<string | null> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['rev-parse', '--verify', input.ref],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    return result.success ? result.stdout.trim() || null : null;
}

export function createGitPullRequestCheckoutOperations(
    deps?: GitPullRequestCheckoutOperationDeps,
): GitPullRequestCheckoutOperations {
    function readRuntimeServices(): ScmHostingProviderRuntimeServices {
        if (deps?.runtimeServices) return deps.runtimeServices;
        const currentServices = readCurrentScmHostingProviderRuntimeServices();
        if (currentServices) return currentServices;
        if (deps?.registry) return {};
        throw new Error('Git SCM pull request checkout requires host-injected SCM hosting provider runtime services.');
    }

    const readSnapshot = deps?.readSnapshot ?? (async ({ context }) => {
        const response = await getGitSnapshot({ context });
        return response.success ? response.snapshot ?? null : null;
    });

    async function readRegistry(): Promise<PullRequestCheckoutRegistry> {
        return deps?.registry ?? await resolveDefaultPullRequestStatusProjectionRegistry();
    }

    async function resolveCheckoutMetadata(input: Readonly<{
        context: ScmBackendContext;
        reference: ScmPullRequestReference;
    }>): Promise<
        | Readonly<{
            snapshot: ScmWorkingSnapshot;
            provider: ScmHostingProviderRef;
            metadata: PullRequestCheckoutMetadata;
            branch: string;
        }>
        | Readonly<{ error: ScmPullRequestCheckoutResponse & ScmPullRequestPrepareWorktreeResponse }>
    > {
        const snapshot = await readSnapshot({ context: input.context });
        if (!snapshot) {
            return { error: errorResponse('SCM status snapshot is unavailable', SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE) };
        }
        const provider = resolveProvider(snapshot);
        if (!provider) {
            return { error: errorResponse('No supported SCM hosting provider detected for this repository', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) };
        }
        const adapter = (await readRegistry()).getAdapter(provider.id);
        if (!isPullRequestCheckoutAdapter(adapter)) {
            return { error: errorResponse('SCM hosting provider does not support pull request checkout', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) };
        }
        const resolveCheckoutReference = adapter.resolvePullRequestCheckoutReference;
        if (!resolveCheckoutReference) {
            return { error: errorResponse('SCM hosting provider does not support pull request checkout', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) };
        }
        const metadata = await resolveCheckoutReference({
            provider,
            reference: input.reference,
            runtimeServices: readRuntimeServices(),
        });
        const branch = metadata.branch ?? metadata.pullRequest?.headBranch;
        if (!branch) {
            return { error: errorResponse('Pull request checkout metadata did not include a branch', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST) };
        }
        const branchValidation = validateBranchName(branch);
        if (!branchValidation.ok) {
            return { error: errorResponse(branchValidation.error, SCM_OPERATION_ERROR_CODES.INVALID_REQUEST) };
        }
        return { snapshot, provider, metadata, branch };
    }

    async function prepareProviderCheckoutBranch(input: Readonly<{
        context: ScmBackendContext;
        snapshot: ScmWorkingSnapshot;
        provider: ScmHostingProviderRef;
        metadata: PullRequestCheckoutMetadata;
        branch: string;
        requireRemoteRef: boolean;
    }>): Promise<(ScmPullRequestCheckoutResponse & ScmPullRequestPrepareWorktreeResponse) | null> {
        if (!input.metadata.remoteRef) {
            return input.requireRemoteRef
                ? errorResponse('Pull request checkout metadata did not include a provider checkout ref', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED)
                : null;
        }

        const remoteRefValidation = validateProviderCheckoutRef(input.metadata.remoteRef);
        if (!remoteRefValidation.ok) {
            return errorResponse(remoteRefValidation.error, SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        }

        const remoteName = input.provider.remoteName ?? input.snapshot.repo.remotes?.[0]?.name;
        if (!remoteName) {
            return errorResponse('Pull request checkout requires a configured remote', SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND);
        }
        const remoteNameValidation = validateFetchRemoteName(remoteName);
        if (!remoteNameValidation.ok) {
            return errorResponse(remoteNameValidation.error, SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        }

        const fetched = await runScmCommand({
            bin: 'git',
            cwd: input.context.cwd,
            args: ['fetch', remoteName, input.metadata.remoteRef],
            timeoutMs: 30_000,
            env: buildScmNonInteractiveEnv(),
        });
        if (!fetched.success) {
            return errorResponse(fetched.stderr || 'Pull request fetch failed', mapGitErrorCode(fetched.stderr));
        }

        const existingBranchSha = await readRef({ cwd: input.context.cwd, ref: `refs/heads/${input.branch}` });
        if (existingBranchSha) {
            const fetchedSha = await readRef({ cwd: input.context.cwd, ref: 'FETCH_HEAD' });
            if (fetchedSha && existingBranchSha !== fetchedSha) {
                return errorResponse(
                    'A local branch with the pull request name already exists at a different commit',
                    SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                );
            }
            return null;
        }

        const created = await runScmCommand({
            bin: 'git',
            cwd: input.context.cwd,
            args: ['branch', '--', input.branch, 'FETCH_HEAD'],
            timeoutMs: 30_000,
            env: buildScmNonInteractiveEnv(),
        });
        if (!created.success) {
            return errorResponse(created.stderr || 'Pull request branch creation failed', mapGitErrorCode(created.stderr));
        }
        return null;
    }

    return Object.freeze({
        async checkout({ context, request }) {
            const resolved = await resolveCheckoutMetadata({
                context,
                reference: request.prReference,
            });
            if ('error' in resolved) return resolved.error;
            const { snapshot, provider, metadata, branch } = resolved;
            const branchPreparationError = await prepareProviderCheckoutBranch({
                context,
                snapshot,
                provider,
                metadata,
                branch,
                requireRemoteRef: true,
            });
            if (branchPreparationError) return branchPreparationError;

            const switched = await runScmCommand({
                bin: 'git',
                cwd: context.cwd,
                args: ['switch', branch],
                timeoutMs: 60_000,
                env: buildScmNonInteractiveEnv(),
            });
            if (!switched.success) {
                return errorResponse(switched.stderr || 'Pull request branch checkout failed', mapGitErrorCode(switched.stderr));
            }
            return {
                success: true,
                pullRequest: metadata.pullRequest,
                branch,
                headSha: metadata.headSha,
                baseSha: metadata.baseSha,
            };
        },
        async prepareWorktree({ context, request }) {
            const resolved = await resolveCheckoutMetadata({
                context,
                reference: request.prReference,
            });
            if ('error' in resolved) return resolved.error;
            const { snapshot, provider, metadata, branch } = resolved;
            const branchPreparationError = await prepareProviderCheckoutBranch({
                context,
                snapshot,
                provider,
                metadata,
                branch,
                requireRemoteRef: false,
            });
            if (branchPreparationError) return branchPreparationError;
            const realizeWorkspaceCheckout = deps?.realizeWorkspaceCheckout ?? realizeGitWorkspaceCheckout;
            const realized = await realizeWorkspaceCheckout({
                context,
                workspaceCheckoutRealization: {
                    kind: 'git_worktree',
                    sourcePath: request.sourcePath,
                    displayName: branch,
                    baseRef: branch,
                    targetPath: request.mode === 'local' ? context.cwd : null,
                },
            });
            return {
                success: true,
                targetPath: realized.targetPath,
                branch,
                pullRequest: metadata.pullRequest,
            };
        },
    });
}

const gitPullRequestCheckoutOperations = createGitPullRequestCheckoutOperations();

export const gitPullRequestCheckout = gitPullRequestCheckoutOperations.checkout;
export const gitPullRequestPrepareWorktree = gitPullRequestCheckoutOperations.prepareWorktree;
