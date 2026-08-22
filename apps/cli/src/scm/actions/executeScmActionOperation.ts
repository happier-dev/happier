import {
    getActionSpec,
    type ScmActionId,
    type ScmHostingRepositoryDescribePublishTargetsRequest,
    type ScmHostingRepositoryDescribePublishTargetsResponse,
    type ScmHostingRepositoryPublishRequest,
    type ScmHostingRepositoryPublishResponse,
    type ScmPullRequestCheckoutRequest,
    type ScmPullRequestCheckoutResponse,
    type ScmPullRequestGetRequest,
    type ScmPullRequestGetResponse,
    type ScmPullRequestListRequest,
    type ScmPullRequestListResponse,
    type ScmPullRequestOpenComposeRequest,
    type ScmPullRequestOpenComposeResponse,
    type ScmPullRequestOpenOrReuseRequest,
    type ScmPullRequestOpenOrReuseResponse,
    type ScmPullRequestPrepareWorktreeRequest,
    type ScmPullRequestPrepareWorktreeResponse,
    type ScmPullRequestRunStackedRequest,
    type ScmPullRequestRunStackedResponse,
    type ScmRepositoryCloneInput,
    type ScmRepositoryCloneOutput,
    type ScmRepositoryInitRequest,
    type ScmRepositoryInitResponse,
    type ScmRepositoryRemoveIndexLockRequest,
    type ScmRepositoryRemoveIndexLockResponse,
} from '@happier-dev/protocol';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { ScmBackendRegistry } from '@/scm/registry';
import { notRepositoryResponse, runScmRoute } from '@/scm/rpc/dispatch';
import {
    runScmHostingRepositoryDescribePublishTargetsRoute,
    runScmHostingRepositoryPublishRoute,
    runScmRepositoryCloneRoute,
    runScmRepositoryInitRoute,
    runScmRepositoryRemoveIndexLockRoute,
} from '@/scm/rpc/repositoryProvisioningDispatch';

type ScmDiffSummaryActionId = Extract<ScmActionId, 'scm.diffSummary.generate'>;
type LocalScmActionId = Exclude<ScmActionId, ScmDiffSummaryActionId>;

type RunMutation = <T>(operation: () => Promise<T>) => Promise<T>;

export type ExecuteScmDiffSummaryAction = (input: Readonly<{
    request: unknown;
}>) => Promise<unknown>;

export type ExecuteScmActionOperationParams = Readonly<{
    actionId: ScmActionId;
    input: unknown;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    signal?: AbortSignal;
    registry?: ScmBackendRegistry;
    runMutation?: RunMutation;
    executeDiffSummary?: ExecuteScmDiffSummaryAction;
}>;

function runLocalScmAction(params: ExecuteScmActionOperationParams & Readonly<{
    actionId: LocalScmActionId;
}>): Promise<unknown> {
    const routeBase = {
        workingDirectory: params.workingDirectory,
        ...(params.accessPolicy ? { accessPolicy: params.accessPolicy } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.registry ? { registry: params.registry } : {}),
    } as const;
    const runMutation: RunMutation = params.runMutation ?? (async (operation) => await operation());

    switch (params.actionId) {
        case 'scm.pullRequest.list': {
            const request = params.input as ScmPullRequestListRequest;
            return runScmRoute<ScmPullRequestListRequest, ScmPullRequestListResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestListResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestList
                    ? await selection.backend.pullRequestList({ context, request })
                    : notRepositoryResponse<ScmPullRequestListResponse>(),
            });
        }
        case 'scm.pullRequest.get': {
            const request = params.input as ScmPullRequestGetRequest;
            return runScmRoute<ScmPullRequestGetRequest, ScmPullRequestGetResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestGetResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestGet
                    ? await selection.backend.pullRequestGet({ context, request })
                    : notRepositoryResponse<ScmPullRequestGetResponse>(),
            });
        }
        case 'scm.pullRequest.openCompose': {
            const request = params.input as ScmPullRequestOpenComposeRequest;
            return runScmRoute<ScmPullRequestOpenComposeRequest, ScmPullRequestOpenComposeResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestOpenComposeResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestOpenCompose
                    ? await selection.backend.pullRequestOpenCompose({ context, request })
                    : notRepositoryResponse<ScmPullRequestOpenComposeResponse>(),
            });
        }
        case 'scm.pullRequest.openOrReuse': {
            const request = params.input as ScmPullRequestOpenOrReuseRequest;
            return runMutation(async () => await runScmRoute<ScmPullRequestOpenOrReuseRequest, ScmPullRequestOpenOrReuseResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestOpenOrReuseResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestOpenOrReuse
                    ? await selection.backend.pullRequestOpenOrReuse({ context, request })
                    : notRepositoryResponse<ScmPullRequestOpenOrReuseResponse>(),
            }));
        }
        case 'scm.pullRequest.checkout': {
            const request = params.input as ScmPullRequestCheckoutRequest;
            return runMutation(async () => await runScmRoute<ScmPullRequestCheckoutRequest, ScmPullRequestCheckoutResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestCheckoutResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestCheckout
                    ? await selection.backend.pullRequestCheckout({ context, request })
                    : notRepositoryResponse<ScmPullRequestCheckoutResponse>(),
            }));
        }
        case 'scm.pullRequest.prepareWorktree': {
            const request = params.input as ScmPullRequestPrepareWorktreeRequest;
            return runMutation(async () => await runScmRoute<ScmPullRequestPrepareWorktreeRequest, ScmPullRequestPrepareWorktreeResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestPrepareWorktreeResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestPrepareWorktree
                    ? await selection.backend.pullRequestPrepareWorktree({ context, request })
                    : notRepositoryResponse<ScmPullRequestPrepareWorktreeResponse>(),
            }));
        }
        case 'scm.pullRequest.runStacked': {
            const request = params.input as ScmPullRequestRunStackedRequest;
            return runMutation(async () => await runScmRoute<ScmPullRequestRunStackedRequest, ScmPullRequestRunStackedResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestRunStackedResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestRunStacked
                    ? await selection.backend.pullRequestRunStacked({ context, request })
                    : notRepositoryResponse<ScmPullRequestRunStackedResponse>(),
            }));
        }
        case 'scm.repository.init':
            return runMutation(async () => await runScmRepositoryInitRoute({
                request: params.input as ScmRepositoryInitRequest,
                ...routeBase,
            }) satisfies ScmRepositoryInitResponse);
        case 'scm.repository.clone':
            return runMutation(async () => await runScmRepositoryCloneRoute({
                request: params.input as ScmRepositoryCloneInput,
                ...routeBase,
            }) satisfies ScmRepositoryCloneOutput);
        case 'scm.repository.removeIndexLock':
            return runMutation(async () => await runScmRepositoryRemoveIndexLockRoute({
                request: params.input as ScmRepositoryRemoveIndexLockRequest,
                ...routeBase,
            }) satisfies ScmRepositoryRemoveIndexLockResponse);
        case 'scm.hostingRepository.describePublishTargets':
            return runScmHostingRepositoryDescribePublishTargetsRoute({
                request: params.input as ScmHostingRepositoryDescribePublishTargetsRequest,
                ...routeBase,
            }) satisfies Promise<ScmHostingRepositoryDescribePublishTargetsResponse>;
        case 'scm.hostingRepository.publish':
            return runMutation(async () => await runScmHostingRepositoryPublishRoute({
                request: params.input as ScmHostingRepositoryPublishRequest,
                ...routeBase,
            }) satisfies ScmHostingRepositoryPublishResponse);
    }
}

/** Canonical semantic owner shared by Action execution and SCM RPC transport bindings. */
export async function executeScmActionOperation(
    params: ExecuteScmActionOperationParams,
): Promise<unknown> {
    const spec = getActionSpec(params.actionId);
    const request = spec.inputSchema.parse(params.input);
    const result = params.actionId === 'scm.diffSummary.generate'
        ? await params.executeDiffSummary?.({ request })
        : await runLocalScmAction({
            ...params,
            actionId: params.actionId,
            input: request,
        });
    if (result === undefined) {
        throw new Error(`SCM action operation is unavailable: ${params.actionId}`);
    }
    if (!spec.outputSchema) {
        throw new Error(`SCM action operation has no output schema: ${params.actionId}`);
    }
    return spec.outputSchema.parse(result);
}
