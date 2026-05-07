import {
    SCM_OPERATION_ERROR_CODES,
    type ScmPullRequestGetRequest,
    type ScmPullRequestGetResponse,
    type ScmPullRequestCheckoutRequest,
    type ScmPullRequestCheckoutResponse,
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
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import { defaultPrStatusCache } from '../../../hostingProviders/prStatusCache';
import type { PrStatusCache } from '../../../hostingProviders/prStatusCache';
import { defaultScmHostingProviderRegistry } from '../../../hostingProviders/registry';
import { githubCliScmHostingProviderAdapter } from '../../../hostingProviders/providers/githubCliAdapter';
import { detectGithubCliAuth } from '../../../hostingProviders/providers/githubCliDetection';
import { gitlabCliScmHostingProviderAdapter } from '../../../hostingProviders/providers/gitlabCliAdapter';
import { detectGitlabCliAuth } from '../../../hostingProviders/providers/gitlabCliDetection';
import { githubRestScmHostingProviderAdapter } from '../../../hostingProviders/providers/githubRestAdapter';
import type { ScmHostingProviderAdapter } from '../../../hostingProviders/types';
import { getGitSnapshot } from '../repository';
import { gitBranchCreate } from './branchOperations';
import { gitCommitCreate } from './commitOperations';
import { gitRemotePublish } from './publishOperations';
import { gitRemotePush } from './remoteOperations';
import {
    buildNoAuthOpenOrReuseResponse,
    providerUnavailableResponse,
    resolveGithubConnectedAccountAuth,
    resolveOpenOrReuseHead,
} from './pullRequestOperationHelpers';
import { createGitPullRequestCheckoutOperations } from './pullRequestCheckoutOperations';
import {
    resolvePullRequestReferenceHead,
    resolvePullRequestReferenceNumber,
} from './pullRequestReference';
import { createRunStackedPullRequestAction } from './runStackedPullRequestAction';

type GithubCliAuthDetector = typeof detectGithubCliAuth;
type GitlabCliAuthDetector = typeof detectGitlabCliAuth;

type GitPullRequestOperationDeps = Readonly<{
    readSnapshot?: (context: ScmBackendContext) => Promise<ScmWorkingSnapshot | null>;
    prStatusCache?: PrStatusCache;
    githubRestAdapter?: ScmHostingProviderAdapter;
    githubCliAdapter?: ScmHostingProviderAdapter;
    detectGithubCliAuth?: GithubCliAuthDetector;
    gitlabCliAdapter?: ScmHostingProviderAdapter;
    detectGitlabCliAuth?: GitlabCliAuthDetector;
}>;

type RestPullRequestFailure = Readonly<{
    error: string;
    errorCode: typeof SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
}>;

async function readDefaultSnapshot(context: ScmBackendContext): Promise<ScmWorkingSnapshot | null> {
    const response = await getGitSnapshot({ context });
    return response.success && response.snapshot ? response.snapshot : null;
}

export function createGitPullRequestBackend(deps: GitPullRequestOperationDeps = {}) {
    const readSnapshot = deps.readSnapshot ?? readDefaultSnapshot;
    const prStatusCache = deps.prStatusCache ?? defaultPrStatusCache;
    const githubRestAdapter = deps.githubRestAdapter ?? githubRestScmHostingProviderAdapter;
    const githubCliAdapter = deps.githubCliAdapter ?? githubCliScmHostingProviderAdapter;
    const detectCliAuth = deps.detectGithubCliAuth ?? detectGithubCliAuth;
    const gitlabCliAdapter = deps.gitlabCliAdapter ?? gitlabCliScmHostingProviderAdapter;
    const detectGitlabAuth = deps.detectGitlabCliAuth ?? detectGitlabCliAuth;

    function toRestFailure(error: unknown, fallbackMessage: string): RestPullRequestFailure {
        return {
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: error instanceof Error ? error.message : fallbackMessage,
        };
    }

    function cliAuthProfileKeyForProvider(providerKind: string): string {
        return providerKind === 'gitlab' ? 'glab-cli' : 'gh-cli';
    }

    async function openCompose(input: {
        context: ScmBackendContext;
        request: ScmPullRequestOpenComposeRequest;
    }): Promise<ScmPullRequestOpenComposeResponse> {
        const snapshot = await readSnapshot(input.context);
        const provider = snapshot?.hostingProvider ?? null;
        if (!provider) return providerUnavailableResponse<ScmPullRequestOpenComposeResponse & { success: false }>();

        const url = defaultScmHostingProviderRegistry.buildCompareUrl({
            provider,
            base: input.request.base,
            head: input.request.head,
        });
        if (!url) return providerUnavailableResponse<ScmPullRequestOpenComposeResponse & { success: false }>();

        return {
            success: true,
            url,
        };
    }

    async function list(input: {
        context: ScmBackendContext;
        request: ScmPullRequestListRequest;
    }): Promise<ScmPullRequestListResponse> {
        const snapshot = await readSnapshot(input.context);
        const provider = snapshot?.hostingProvider ?? null;
        if (!snapshot || !provider) return providerUnavailableResponse<ScmPullRequestListResponse & { success: false }>();
        const head = input.request.head ?? snapshot.branch.head ?? null;
        const githubConnectedAccountAuth =
            provider.kind === 'github'
                ? await resolveGithubConnectedAccountAuth({
                    context: input.context,
                    providerBaseUrl: provider.baseUrl,
                    requireDotComHost: true,
                })
                : { kind: 'missing' } as const;
        if (head && snapshot.repo.rootPath) {
            const cached = prStatusCache.getFresh({
                repoRootPath: snapshot.repo.rootPath,
                provider,
                head,
                authProfileKey: githubConnectedAccountAuth.kind === 'available'
                    ? githubConnectedAccountAuth.authProfileKey
                    : cliAuthProfileKeyForProvider(provider.kind),
            });
            if (cached?.kind === 'success') {
                return {
                    success: true,
                    pullRequests: [...cached.pullRequests],
                };
            }
        }

        let restFailure: RestPullRequestFailure | null = null;
        if (provider.kind === 'github' && head && githubConnectedAccountAuth.kind === 'available' && githubRestAdapter.listOpenPullRequests) {
            try {
                const pullRequests = await githubRestAdapter.listOpenPullRequests({
                    provider,
                    token: githubConnectedAccountAuth.token,
                    base: input.request.base,
                    head,
                });
                if (snapshot.repo.rootPath) {
                    prStatusCache.setSuccess({
                        repoRootPath: snapshot.repo.rootPath,
                        provider,
                        head,
                        authProfileKey: githubConnectedAccountAuth.authProfileKey,
                    }, pullRequests);
                }
                return {
                    success: true,
                    pullRequests: [...pullRequests],
                };
            } catch (error) {
                restFailure = toRestFailure(error, 'GitHub REST pull request list failed.');
            }
        }

        if (provider.kind === 'github' && head) {
            const cliAuth = await detectCliAuth({ providerBaseUrl: provider.baseUrl });
            if (cliAuth.kind === 'authenticated' && githubCliAdapter.listOpenPullRequests) {
                try {
                    const pullRequests = await githubCliAdapter.listOpenPullRequests({
                        provider,
                        base: input.request.base,
                        head,
                    });
                    if (snapshot.repo.rootPath) {
                        prStatusCache.setSuccess({
                            repoRootPath: snapshot.repo.rootPath,
                            provider,
                            head,
                            authProfileKey: 'gh-cli',
                        }, pullRequests);
                    }
                    return {
                        success: true,
                        pullRequests: [...pullRequests],
                    };
                } catch (error) {
                    return {
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        error: error instanceof Error ? error.message : 'GitHub CLI pull request list failed.',
                    };
                }
            }
        }

        if (provider.kind === 'gitlab' && head) {
            const cliAuth = await detectGitlabAuth({ providerBaseUrl: provider.baseUrl });
            if (cliAuth.kind === 'authenticated' && gitlabCliAdapter.listOpenPullRequests) {
                try {
                    const pullRequests = await gitlabCliAdapter.listOpenPullRequests({
                        provider,
                        base: input.request.base,
                        head,
                    });
                    if (snapshot.repo.rootPath) {
                        prStatusCache.setSuccess({
                            repoRootPath: snapshot.repo.rootPath,
                            provider,
                            head,
                            authProfileKey: 'glab-cli',
                        }, pullRequests);
                    }
                    return {
                        success: true,
                        pullRequests: [...pullRequests],
                    };
                } catch (error) {
                    return {
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        error: error instanceof Error ? error.message : 'GitLab CLI merge request list failed.',
                    };
                }
            }
        }

        if (restFailure) {
            return {
                success: false,
                errorCode: restFailure.errorCode,
                error: restFailure.error,
            };
        }

        return {
            success: true,
            pullRequests: [],
        };
    }

    async function get(input: {
        context: ScmBackendContext;
        request: ScmPullRequestGetRequest;
    }): Promise<ScmPullRequestGetResponse> {
        const snapshot = await readSnapshot(input.context);
        const provider = snapshot?.hostingProvider ?? null;
        if (!provider) return providerUnavailableResponse<ScmPullRequestGetResponse & { success: false }>();

        const referenceHead = resolvePullRequestReferenceHead(input.request.prReference);
        if (referenceHead) {
            const response = await list({
                context: input.context,
                request: {
                    cwd: input.request.cwd,
                    head: referenceHead,
                },
            });
            return response.success
                ? {
                    success: true,
                    pullRequest: response.pullRequests[0] ?? null,
                }
                : response;
        }

        const referenceNumber = resolvePullRequestReferenceNumber(input.request.prReference);
        if (provider.kind === 'github' && referenceNumber != null) {
            let restFailure: RestPullRequestFailure | null = null;
            const githubConnectedAccountAuth = await resolveGithubConnectedAccountAuth({
                context: input.context,
                providerBaseUrl: provider.baseUrl,
                requireDotComHost: true,
            });
            if (githubConnectedAccountAuth.kind === 'available' && githubRestAdapter.getPullRequest) {
                try {
                    const pullRequest = await githubRestAdapter.getPullRequest({
                        provider,
                        token: githubConnectedAccountAuth.token,
                        number: referenceNumber,
                    });
                    return {
                        success: true,
                        pullRequest,
                    };
                } catch (error) {
                    restFailure = toRestFailure(error, 'GitHub REST pull request lookup failed.');
                }
            }
            const cliAuth = await detectCliAuth({ providerBaseUrl: provider.baseUrl });
            if (cliAuth.kind === 'authenticated' && githubCliAdapter.getPullRequest) {
                try {
                    const pullRequest = await githubCliAdapter.getPullRequest({
                        provider,
                        number: referenceNumber,
                    });
                    return {
                        success: true,
                        pullRequest,
                    };
                } catch (error) {
                    return {
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        error: error instanceof Error ? error.message : 'GitHub CLI pull request lookup failed.',
                    };
                }
            }
            if (restFailure) {
                return {
                    success: false,
                    errorCode: restFailure.errorCode,
                    error: restFailure.error,
                };
            }
        }

        if (provider.kind === 'gitlab' && referenceNumber != null) {
            const cliAuth = await detectGitlabAuth({ providerBaseUrl: provider.baseUrl });
            if (cliAuth.kind === 'authenticated' && gitlabCliAdapter.getPullRequest) {
                try {
                    const pullRequest = await gitlabCliAdapter.getPullRequest({
                        provider,
                        number: referenceNumber,
                    });
                    return {
                        success: true,
                        pullRequest,
                    };
                } catch (error) {
                    return {
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        error: error instanceof Error ? error.message : 'GitLab CLI merge request lookup failed.',
                    };
                }
            }
        }

        return {
            success: true,
            pullRequest: null,
        };
    }

    async function openOrReuse(input: {
        context: ScmBackendContext;
        request: ScmPullRequestOpenOrReuseRequest;
    }): Promise<ScmPullRequestOpenOrReuseResponse> {
        const snapshot = await readSnapshot(input.context);
        const provider = snapshot?.hostingProvider ?? null;
        if (!snapshot || !provider) return providerUnavailableResponse<ScmPullRequestOpenOrReuseResponse & { success: false }>();

        const head = resolveOpenOrReuseHead({ snapshot, request: input.request });
        if (!head.ok) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: head.error,
            };
        }

        if (provider.kind === 'github') {
            let restFailure: RestPullRequestFailure | null = null;
            const githubConnectedAccountAuth = await resolveGithubConnectedAccountAuth({
                context: input.context,
                providerBaseUrl: provider.baseUrl,
                requireDotComHost: true,
            });
            if (githubConnectedAccountAuth.kind === 'available' && githubRestAdapter.createPullRequest) {
                try {
                    const existingPullRequests = await githubRestAdapter.listOpenPullRequests?.({
                        provider,
                        token: githubConnectedAccountAuth.token,
                        base: input.request.base,
                        head: head.head,
                    }) ?? [];
                    const existing = existingPullRequests[0];
                    if (existing) {
                        if (snapshot.repo.rootPath) {
                            prStatusCache.setSuccess({
                                repoRootPath: snapshot.repo.rootPath,
                                provider,
                                head: head.head,
                                authProfileKey: githubConnectedAccountAuth.authProfileKey,
                            }, [existing]);
                        }
                        return {
                            success: true,
                            kind: 'opened',
                            pullRequest: existing,
                            reused: true,
                        };
                    }
                    const pullRequest = await githubRestAdapter.createPullRequest({
                        provider,
                        token: githubConnectedAccountAuth.token,
                        base: input.request.base,
                        head: head.head,
                        title: input.request.title,
                        body: input.request.body,
                    });
                    if (snapshot.repo.rootPath) {
                            prStatusCache.setSuccess({
                                repoRootPath: snapshot.repo.rootPath,
                                provider,
                                head: head.head,
                                authProfileKey: githubConnectedAccountAuth.authProfileKey,
                            }, [pullRequest]);
                        }
                        return {
                        success: true,
                        kind: 'opened',
                        pullRequest,
                        reused: false,
                    };
                } catch (error) {
                    restFailure = toRestFailure(error, 'GitHub REST pull request operation failed.');
                }
            }
            const cliAuth = await detectCliAuth({ providerBaseUrl: provider.baseUrl });
            if (cliAuth.kind === 'authenticated' && githubCliAdapter.createPullRequest) {
                try {
                    const existingPullRequests = await githubCliAdapter.listOpenPullRequests?.({
                        provider,
                        base: input.request.base,
                        head: head.head,
                    }) ?? [];
                    const existing = existingPullRequests[0];
                    if (existing) {
                        if (snapshot.repo.rootPath) {
                            prStatusCache.setSuccess({
                                repoRootPath: snapshot.repo.rootPath,
                                provider,
                                head: head.head,
                                authProfileKey: 'gh-cli',
                            }, [existing]);
                        }
                        return {
                            success: true,
                            kind: 'opened',
                            pullRequest: existing,
                            reused: true,
                        };
                    }
                    const pullRequest = await githubCliAdapter.createPullRequest({
                        provider,
                        base: input.request.base,
                        head: head.head,
                        title: input.request.title,
                        body: input.request.body,
                    });
                    if (snapshot.repo.rootPath) {
                        prStatusCache.setSuccess({
                            repoRootPath: snapshot.repo.rootPath,
                            provider,
                            head: head.head,
                            authProfileKey: 'gh-cli',
                        }, [pullRequest]);
                    }
                    return {
                        success: true,
                        kind: 'opened',
                        pullRequest,
                        reused: false,
                    };
                } catch (error) {
                    return {
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        error: error instanceof Error ? error.message : 'GitHub CLI pull request operation failed.',
                    };
                }
            }
            if (restFailure) {
                return {
                    success: false,
                    errorCode: restFailure.errorCode,
                    error: restFailure.error,
                };
            }
        }

        if (provider.kind === 'gitlab') {
            const cliAuth = await detectGitlabAuth({ providerBaseUrl: provider.baseUrl });
            if (cliAuth.kind === 'authenticated' && gitlabCliAdapter.createPullRequest) {
                try {
                    const existingPullRequests = await gitlabCliAdapter.listOpenPullRequests?.({
                        provider,
                        base: input.request.base,
                        head: head.head,
                    }) ?? [];
                    const existing = existingPullRequests[0];
                    if (existing) {
                        if (snapshot.repo.rootPath) {
                            prStatusCache.setSuccess({
                                repoRootPath: snapshot.repo.rootPath,
                                provider,
                                head: head.head,
                                authProfileKey: 'glab-cli',
                            }, [existing]);
                        }
                        return {
                            success: true,
                            kind: 'opened',
                            pullRequest: existing,
                            reused: true,
                        };
                    }
                    const pullRequest = await gitlabCliAdapter.createPullRequest({
                        provider,
                        base: input.request.base,
                        head: head.head,
                        title: input.request.title,
                        body: input.request.body,
                    });
                    if (snapshot.repo.rootPath) {
                        prStatusCache.setSuccess({
                            repoRootPath: snapshot.repo.rootPath,
                            provider,
                            head: head.head,
                            authProfileKey: 'glab-cli',
                        }, [pullRequest]);
                    }
                    return {
                        success: true,
                        kind: 'opened',
                        pullRequest,
                        reused: false,
                    };
                } catch (error) {
                    return {
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        error: error instanceof Error ? error.message : 'GitLab CLI merge request operation failed.',
                    };
                }
            }
        }

        return buildNoAuthOpenOrReuseResponse({
            provider,
            base: input.request.base,
            head: head.head,
        });
    }

    const checkoutOperations = createGitPullRequestCheckoutOperations({
        readSnapshot,
        getPullRequest: get,
    });

    async function checkout(input: {
        context: ScmBackendContext;
        request: ScmPullRequestCheckoutRequest;
    }): Promise<ScmPullRequestCheckoutResponse> {
        return await checkoutOperations.checkout(input);
    }

    async function prepareWorktree(input: {
        context: ScmBackendContext;
        request: ScmPullRequestPrepareWorktreeRequest;
    }): Promise<ScmPullRequestPrepareWorktreeResponse> {
        return await checkoutOperations.prepareWorktree(input);
    }

    const runStackedOperation = createRunStackedPullRequestAction({
        readSnapshot,
        branchCreate: gitBranchCreate,
        commitCreate: gitCommitCreate,
        remotePush: gitRemotePush,
        remotePublish: gitRemotePublish,
        openOrReuse,
    });

    async function runStacked(input: {
        context: ScmBackendContext;
        request: ScmPullRequestRunStackedRequest;
    }): Promise<ScmPullRequestRunStackedResponse> {
        return await runStackedOperation(input);
    }

    return {
        list,
        get,
        openCompose,
        openOrReuse,
        checkout,
        prepareWorktree,
        runStacked,
    };
}

const defaultGitPullRequestBackend = createGitPullRequestBackend();

export const gitPullRequestOpenCompose = defaultGitPullRequestBackend.openCompose;
export const gitPullRequestList = defaultGitPullRequestBackend.list;
export const gitPullRequestGet = defaultGitPullRequestBackend.get;
export const gitPullRequestOpenOrReuse = defaultGitPullRequestBackend.openOrReuse;
export const gitPullRequestCheckout = defaultGitPullRequestBackend.checkout;
export const gitPullRequestPrepareWorktree = defaultGitPullRequestBackend.prepareWorktree;
export const gitPullRequestRunStacked = defaultGitPullRequestBackend.runStacked;
