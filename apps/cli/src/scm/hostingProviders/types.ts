import type {
    ScmHostingRepositoryOwnerKind,
    ScmHostingRepositoryPublishTarget,
    ScmHostingRepositorySummary,
    ScmHostingRepositoryVisibility,
    ScmHostingProvider,
    ScmHostingProviderKind,
    ScmPullRequestSummary,
} from '@happier-dev/protocol';

export type ScmHostingProviderDetectionInput = Readonly<{
    remoteName: string | null;
    remoteUrl: string;
}>;

export type ScmHostingProviderCompareUrlInput = Readonly<{
    provider: ScmHostingProvider;
    base: string;
    head: string;
}>;

export type ScmHostingProviderAdapter = Readonly<{
    kind: ScmHostingProviderKind;
    name: string;
    detectRemote(input: ScmHostingProviderDetectionInput): ScmHostingProvider | null;
    buildCompareUrl(input: ScmHostingProviderCompareUrlInput): string | null;
    listOpenPullRequests?(input: ScmHostingProviderListOpenPullRequestsInput): Promise<readonly ScmPullRequestSummary[]>;
    getPullRequest?(input: ScmHostingProviderGetPullRequestInput): Promise<ScmPullRequestSummary | null>;
    createPullRequest?(input: ScmHostingProviderCreatePullRequestInput): Promise<ScmPullRequestSummary>;
    listRepositoryPublishTargets?(
        input: ScmHostingProviderListRepositoryPublishTargetsInput
    ): Promise<readonly ScmHostingRepositoryPublishTarget[]>;
    createRepository?(input: ScmHostingProviderCreateRepositoryInput): Promise<ScmHostingRepositorySummary>;
}>;

export type ScmHostingProviderRegistry = Readonly<{
    registerScmHostingProvider(adapter: ScmHostingProviderAdapter): void;
    detectRemote(input: ScmHostingProviderDetectionInput): ScmHostingProvider | null;
    buildCompareUrl(input: ScmHostingProviderCompareUrlInput): string | null;
}>;

export type ScmHostingProviderListOpenPullRequestsInput = Readonly<{
    provider: ScmHostingProvider;
    token?: string;
    base?: string;
    head?: string;
}>;

export type ScmHostingProviderGetPullRequestInput = Readonly<{
    provider: ScmHostingProvider;
    token?: string;
    number: number;
}>;

export type ScmHostingProviderCreatePullRequestInput = Readonly<{
    provider: ScmHostingProvider;
    token?: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft?: boolean;
}>;

export type ScmHostingProviderListRepositoryPublishTargetsInput = Readonly<{
    providerBaseUrl: string;
    token?: string;
}>;

export type ScmHostingProviderCreateRepositoryInput = Readonly<{
    providerBaseUrl: string;
    token?: string;
    owner: string;
    ownerKind?: ScmHostingRepositoryOwnerKind;
    repositoryName: string;
    visibility: ScmHostingRepositoryVisibility;
    description?: string;
}>;
