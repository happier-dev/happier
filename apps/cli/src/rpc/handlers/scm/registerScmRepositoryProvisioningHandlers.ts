import type {
    ScmHostingRepositoryDescribePublishTargetsRequest,
    ScmHostingRepositoryDescribePublishTargetsResponse,
    ScmHostingRepositoryPublishRequest,
    ScmHostingRepositoryPublishResponse,
    ScmRepositoryInitRequest,
    ScmRepositoryInitResponse,
    ScmRepositoryRemoveIndexLockRequest,
    ScmRepositoryRemoveIndexLockResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    notRepositoryResponse,
    runScmProvisioningRoute,
    runScmRoute,
} from '@/scm/rpc/dispatch';

import type { ScmHandlerRouteBase } from './scmHandlerRouteBase';

export function registerScmRepositoryProvisioningHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    routeBase: ScmHandlerRouteBase
): void {
    rpcHandlerManager.registerHandler<ScmRepositoryInitRequest, ScmRepositoryInitResponse>(
        RPC_METHODS.SCM_REPOSITORY_INIT,
        async (request) =>
            runScmProvisioningRoute<ScmRepositoryInitRequest, ScmRepositoryInitResponse>({
                request,
                ...routeBase,
                runWithBackend: ({ context, selection }) =>
                    selection.backend.repository?.init({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Repository initialization is not supported by the selected source-control backend.',
                    }),
            })
    );

    rpcHandlerManager.registerHandler<
        ScmHostingRepositoryDescribePublishTargetsRequest,
        ScmHostingRepositoryDescribePublishTargetsResponse
    >(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
        async (request) =>
            runScmProvisioningRoute<ScmHostingRepositoryDescribePublishTargetsRequest, ScmHostingRepositoryDescribePublishTargetsResponse>({
                request,
                ...routeBase,
                runWithBackend: ({ context, selection }) =>
                    selection.backend.repository?.describePublishTargets({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Repository publishing is not supported by the selected source-control backend.',
                    }),
            })
    );

    rpcHandlerManager.registerHandler<ScmHostingRepositoryPublishRequest, ScmHostingRepositoryPublishResponse>(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
        async (request) =>
            runScmRoute<ScmHostingRepositoryPublishRequest, ScmHostingRepositoryPublishResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmHostingRepositoryPublishResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.repository?.publishToHostingProvider({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Repository publishing is not supported by the selected source-control backend.',
                    }),
            })
    );

    rpcHandlerManager.registerHandler<ScmRepositoryRemoveIndexLockRequest, ScmRepositoryRemoveIndexLockResponse>(
        RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
        async (request) =>
            runScmRoute<ScmRepositoryRemoveIndexLockRequest, ScmRepositoryRemoveIndexLockResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRepositoryRemoveIndexLockResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.repository?.removeIndexLock({ context, request }) ?? Promise.resolve({
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        error: 'Git index lock recovery is not supported by the selected source-control backend.',
                    }),
            })
    );
}
