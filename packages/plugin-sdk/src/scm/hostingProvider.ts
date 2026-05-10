import { AsyncLocalStorage } from 'node:async_hooks';

import type {
    ScmHostingRepositoryPublishTarget,
    ScmHostingRepositorySummary,
    ScmHostingRepositoryVisibility,
    ScmHostingRepositoryOwnerKind,
    ScmHostingProviderRef,
    ScmRepositoryCloneRepositorySelector,
    ScmRepositoryCloneTargetDescription,
    ScmPullRequestReference,
    ScmPullRequestState,
    ScmPullRequestSummary,
} from '@happier-dev/protocol';

export type ScmHostingProviderRemoteDetectionInput = Readonly<{
    remoteName: string | null;
    remoteUrl: string;
}>;

export type ScmHostingProviderResolvedRemote = Readonly<{
    id: string;
    kind: ScmHostingProviderRef['kind'];
    displayName: string;
    baseUrl: string;
    nameWithOwner?: string;
    remoteName?: string;
    urlSafety?: ScmHostingProviderRef['urlSafety'];
}>;

export type ScmHostingProviderCompareUrlInput = Readonly<{
    provider: ScmHostingProviderRef;
    base: string;
    head: string;
}>;

export type ScmHostingProviderRuntimeTokenMaterializationResult =
    | Readonly<{
        kind: 'available';
        token: string;
        profileKey?: string;
    }>
    | Readonly<{
        kind: 'missing';
        reason: string;
    }>;

export type ScmHostingProviderRuntimeBasicAuthMaterializationResult =
    | Readonly<{
        kind: 'available';
        username: string;
        password: string;
        profileKey?: string;
    }>
    | Readonly<{
        kind: 'missing';
        reason: string;
    }>;

export type ScmHostingProviderRuntimeCommandResolution =
    | Readonly<{
        kind: 'available';
        source: 'system' | 'managed' | string;
        binPath: string;
    }>
    | Readonly<{
        kind: 'missing';
    }>;

export type ScmHostingProviderRuntimeCommandResult = Readonly<{
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}>;

export type ScmHostingProviderRuntimeServices = Readonly<{
    resolveScmHostingProviderRegistry?: () => Promise<Readonly<{
        detectRemote(input: ScmHostingProviderRemoteDetectionInput): Readonly<
            | {
                kind: 'resolved';
                providerId: string;
                provider: ScmHostingProviderResolvedRemote;
            }
            | { kind: 'unsupported' }
        >;
        buildCompareUrl(input: ScmHostingProviderCompareUrlInput): Readonly<
            | { kind: 'resolved'; url: string }
            | { kind: 'unsupported' }
        >;
    }>>;
    resolveScmHostingTokenMaterialization?: (input: Readonly<{
        kind: 'scm_hosting_token';
        providerId: string;
        host: string;
        provider: ScmHostingProviderRef;
        profileId?: string | null;
    }>) => Promise<ScmHostingProviderRuntimeTokenMaterializationResult>;
    resolveScmHostingBasicAuthMaterialization?: (input: Readonly<{
        kind: 'scm_hosting_basic_auth';
        providerId: string;
        host: string;
        provider: ScmHostingProviderRef;
        profileId?: string | null;
    }>) => Promise<ScmHostingProviderRuntimeBasicAuthMaterializationResult>;
    resolveInstallableCommand?: (input: Readonly<{
        capabilityId: string;
    }>) => Promise<ScmHostingProviderRuntimeCommandResolution>;
    runCommand?: (input: Readonly<{
        binPath: string;
        args: readonly string[];
        timeoutMs: number;
        env?: Readonly<Record<string, string>>;
    }>) => Promise<ScmHostingProviderRuntimeCommandResult>;
}>;

const scmHostingProviderRuntimeServicesStorage = new AsyncLocalStorage<ScmHostingProviderRuntimeServices>();

export function runWithScmHostingProviderRuntimeServices<T>(
    services: ScmHostingProviderRuntimeServices,
    callback: () => T,
): T {
    return scmHostingProviderRuntimeServicesStorage.run(services, callback);
}

export function readCurrentScmHostingProviderRuntimeServices(): ScmHostingProviderRuntimeServices | null {
    return scmHostingProviderRuntimeServicesStorage.getStore() ?? null;
}

type ScmHostingProviderOperationRuntimeInput = Readonly<{
    runtimeServices?: ScmHostingProviderRuntimeServices;
}>;

export type ScmHostingProviderPullRequestListInput = ScmHostingProviderOperationRuntimeInput & Readonly<{
    provider: ScmHostingProviderRef;
    base?: string;
    head: string;
    state?: ScmPullRequestState;
}>;

export type ScmHostingProviderPullRequestGetInput = ScmHostingProviderOperationRuntimeInput & Readonly<{
    provider: ScmHostingProviderRef;
    reference: ScmPullRequestReference;
}>;

export type ScmHostingProviderPullRequestCreateInput = ScmHostingProviderOperationRuntimeInput & Readonly<{
    provider: ScmHostingProviderRef;
    base: string;
    head: string;
    title: string;
    body?: string;
    draft?: boolean;
}>;

export type ScmHostingProviderDefaultBranchInput = ScmHostingProviderOperationRuntimeInput & Readonly<{
    provider: ScmHostingProviderRef;
}>;

export type ScmHostingProviderDefaultBranchMetadata = Readonly<{
    name: string;
    sha?: string | null;
}>;

export type ScmHostingProviderPullRequestCheckoutReferenceInput = ScmHostingProviderOperationRuntimeInput & Readonly<{
    provider: ScmHostingProviderRef;
    reference: ScmPullRequestReference;
}>;

export type ScmHostingProviderPullRequestCheckoutReferenceMetadata = Readonly<{
    pullRequest: ScmPullRequestSummary | null;
    branch?: string;
    headSha?: string | null;
    baseSha?: string | null;
}>;

export type ScmHostingProviderRepositoryDescribePublishTargetsInput = ScmHostingProviderOperationRuntimeInput & Readonly<{
    provider: ScmHostingProviderRef;
    defaultRepositoryName: string;
}>;

export type ScmHostingProviderRepositoryDescribePublishTargetsResult = Readonly<{
    auth: ScmHostingRepositoryPublishTarget['auth'];
    targets: readonly ScmHostingRepositoryPublishTarget[];
}>;

export type ScmHostingProviderRepositoryCreateInput = ScmHostingProviderOperationRuntimeInput & Readonly<{
    provider: ScmHostingProviderRef;
    owner: string;
    ownerKind?: ScmHostingRepositoryOwnerKind;
    repositoryName: string;
    visibility: ScmHostingRepositoryVisibility;
    description?: string;
}>;

export type ScmHostingProviderRepositoryGetInput = ScmHostingProviderOperationRuntimeInput & Readonly<{
    provider: ScmHostingProviderRef;
    owner: string;
    repositoryName: string;
}>;

export type ScmHostingProviderRepositoryDescribeCloneTargetsInput = ScmHostingProviderOperationRuntimeInput & Readonly<{
    provider: ScmHostingProviderRef;
    repository: ScmRepositoryCloneRepositorySelector;
}>;

export type ScmHostingProviderRuntimeAdapter = Readonly<Record<string, unknown> & {
    detectRemote?: (input: ScmHostingProviderRemoteDetectionInput) => ScmHostingProviderResolvedRemote | null;
    buildCompareUrl?: (input: ScmHostingProviderCompareUrlInput) => string | null;
    getPullRequestAuthProfileKey?: (input: Readonly<{ provider: ScmHostingProviderRef }>) => string | null;
    listPullRequests?: (input: ScmHostingProviderPullRequestListInput) => Promise<readonly ScmPullRequestSummary[]>;
    getPullRequest?: (input: ScmHostingProviderPullRequestGetInput) => Promise<ScmPullRequestSummary | null>;
    createPullRequest?: (input: ScmHostingProviderPullRequestCreateInput) => Promise<ScmPullRequestSummary>;
    getDefaultBranch?: (input: ScmHostingProviderDefaultBranchInput) => Promise<ScmHostingProviderDefaultBranchMetadata>;
    resolvePullRequestCheckoutReference?: (
        input: ScmHostingProviderPullRequestCheckoutReferenceInput
    ) => Promise<ScmHostingProviderPullRequestCheckoutReferenceMetadata>;
    describePublishTargets?: (
        input: ScmHostingProviderRepositoryDescribePublishTargetsInput
    ) => Promise<ScmHostingProviderRepositoryDescribePublishTargetsResult>;
    createRepository?: (
        input: ScmHostingProviderRepositoryCreateInput
    ) => Promise<ScmHostingRepositorySummary>;
    getRepository?: (
        input: ScmHostingProviderRepositoryGetInput
    ) => Promise<ScmHostingRepositorySummary | null>;
    describeCloneTargets?: (
        input: ScmHostingProviderRepositoryDescribeCloneTargetsInput
    ) => Promise<ScmRepositoryCloneTargetDescription>;
}>;

export type ScmHostingProviderRuntimeRegistration = Readonly<{
    id: string;
    adapter: ScmHostingProviderRuntimeAdapter;
}>;
