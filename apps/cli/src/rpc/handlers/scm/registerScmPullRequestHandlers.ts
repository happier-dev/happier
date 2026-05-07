import type {
    ScmPullRequestCheckoutRequest,
    ScmPullRequestCheckoutResponse,
    ScmPullRequestGetRequest,
    ScmPullRequestGetResponse,
    ScmPullRequestListRequest,
    ScmPullRequestListResponse,
    ScmPullRequestOpenComposeRequest,
    ScmPullRequestOpenComposeResponse,
    ScmPullRequestOpenOrReuseRequest,
    ScmPullRequestOpenOrReuseResponse,
    ScmPullRequestPrepareWorktreeRequest,
    ScmPullRequestPrepareWorktreeResponse,
    ScmPullRequestRunStackedRequest,
    ScmPullRequestRunStackedResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { notRepositoryResponse, runScmRoute } from '@/scm/rpc/dispatch';

import type { ScmHandlerRouteBase } from './scmHandlerRouteBase';

export function registerScmPullRequestHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    routeBase: ScmHandlerRouteBase
): void {
    rpcHandlerManager.registerHandler<ScmPullRequestListRequest, ScmPullRequestListResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_LIST,
        async (request) =>
            runScmRoute<ScmPullRequestListRequest, ScmPullRequestListResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestListResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.pullRequests?.list({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Pull request operations are not supported by the selected source-control backend.',
                    }),
            })
    );

    rpcHandlerManager.registerHandler<ScmPullRequestGetRequest, ScmPullRequestGetResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_GET,
        async (request) =>
            runScmRoute<ScmPullRequestGetRequest, ScmPullRequestGetResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestGetResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.pullRequests?.get({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Pull request operations are not supported by the selected source-control backend.',
                    }),
            })
    );

    rpcHandlerManager.registerHandler<ScmPullRequestOpenComposeRequest, ScmPullRequestOpenComposeResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
        async (request) =>
            runScmRoute<ScmPullRequestOpenComposeRequest, ScmPullRequestOpenComposeResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestOpenComposeResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.pullRequests?.openCompose({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Pull request operations are not supported by the selected source-control backend.',
                    }),
            })
    );

    rpcHandlerManager.registerHandler<ScmPullRequestOpenOrReuseRequest, ScmPullRequestOpenOrReuseResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
        async (request) =>
            runScmRoute<ScmPullRequestOpenOrReuseRequest, ScmPullRequestOpenOrReuseResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestOpenOrReuseResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.pullRequests?.openOrReuse({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Pull request operations are not supported by the selected source-control backend.',
                    }),
            })
    );

    rpcHandlerManager.registerHandler<ScmPullRequestCheckoutRequest, ScmPullRequestCheckoutResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
        async (request) =>
            runScmRoute<ScmPullRequestCheckoutRequest, ScmPullRequestCheckoutResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestCheckoutResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.pullRequests?.checkout({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Pull request operations are not supported by the selected source-control backend.',
                    }),
            })
    );

    rpcHandlerManager.registerHandler<ScmPullRequestPrepareWorktreeRequest, ScmPullRequestPrepareWorktreeResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE,
        async (request) =>
            runScmRoute<ScmPullRequestPrepareWorktreeRequest, ScmPullRequestPrepareWorktreeResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestPrepareWorktreeResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.pullRequests?.prepareWorktree({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Pull request operations are not supported by the selected source-control backend.',
                    }),
            })
    );

    rpcHandlerManager.registerHandler<ScmPullRequestRunStackedRequest, ScmPullRequestRunStackedResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED,
        async (request) =>
            runScmRoute<ScmPullRequestRunStackedRequest, ScmPullRequestRunStackedResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestRunStackedResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.pullRequests?.runStacked?.({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Pull request stacked operations are not supported by the selected source-control backend.',
                        events: [],
                    }),
            })
    );
}
