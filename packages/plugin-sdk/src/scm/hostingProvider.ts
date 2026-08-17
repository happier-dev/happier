/** @moduleRealm daemon */
import type {
    ScmHostingRepositoryPublishTarget,
    ScmHostingRepositorySummary,
    ScmHostingRepositoryVisibility,
    ScmRepositoryCloneTargetDescription,
    ScmPullRequestReference,
    ScmPullRequestState,
    ScmPullRequestSummary,
} from './projections.js';
import type { PluginJsonValueV2 } from '../identity.js';

export type ScmHostingProviderKind =
    | 'github'
    | 'gitlab'
    | 'bitbucket'
    | 'azure-devops'
    | 'custom'
    | 'unknown';

export type ScmHostingProviderRef = {
    [key: string]: unknown;
    id: string;
    kind: ScmHostingProviderKind;
    displayName: string;
    baseUrl: string;
    nameWithOwner?: string;
    repositoryWebUrl?: string;
    remoteName?: string;
    urlSafety: {
        [key: string]: unknown;
        allowedSchemes: string[];
    };
};

export type HostingProviderContribution = {
    id: string;
    title: string | { key: string; fallback: string };
    description?: string | { key: string; fallback: string };
    kind: string;
    capabilities: ('detect' | 'clone' | 'fetch' | 'status' | 'diff' | 'commit' | 'push' | 'pullRequest')[];
    authService?: string | Readonly<{ pluginId: string; localId: string }>;
    metadata?: Record<string, PluginJsonValueV2>;
};

export type HostingProviderRemoteDetectionInput = Readonly<{
    remoteName: string | null;
    remoteUrl: string;
}>;

export type HostingProviderResolvedRemote = Readonly<{
    id: string;
    kind: string;
    displayName: string;
    /** Released-predecessor display field retained during the provider-ref transition. */
    name?: string;
    /** Canonical authored category when the predecessor-safe wire kind is `unknown`. */
    providerKind?: string;
    baseUrl: string;
    repositoryWebUrl?: string;
    nameWithOwner?: string;
    remoteName?: string | null;
    urlSafety?: Readonly<{
        allowedSchemes: readonly string[];
        allowedBaseUrls?: readonly string[];
        allowedOrigins?: readonly string[];
    }>;
}>;

export type HostingProviderUnresolvedRemote = Readonly<{
    id: 'unknown';
    kind: 'unknown';
    displayName: string;
    remoteName?: string | null;
    unsupportedReason: string;
}>;

export type HostingProviderCompareUrlInput = Readonly<{
    provider: ScmHostingProviderRef;
    base: string;
    head: string;
}>;

export type HostingProviderRuntimeTokenMaterializationResult =
    | Readonly<{
        kind: 'available';
        token: string;
        profileKey?: string;
    }>
    | Readonly<{
        kind: 'missing';
        reason: string;
    }>;

export type HostingProviderRuntimeBasicAuthMaterializationResult =
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

export type HostingProviderRuntimeCommandResult = Readonly<{
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}>;

export type HostingProviderDescriptor = Readonly<Omit<HostingProviderContribution, 'title'> & {
    pluginId?: string;
    displayName: string;
    urlSafety?: Readonly<{
        allowedSchemes: readonly string[];
        allowedBaseUrls: readonly string[];
        allowedOrigins: readonly string[];
    }>;
}>;

export type HostingProviderRegistryDiagnostic = Readonly<{
    code: string;
    message: string;
    pluginId?: string;
    providerId?: string;
}>;

export type HostingProviderResolvedProvider = HostingProviderDescriptor;

export type HostingProviderRemoteDetectionResult =
    | Readonly<{
        kind: 'resolved';
        providerId: string;
        provider: HostingProviderResolvedRemote;
    }>
    | Readonly<{
        kind: 'unknown';
        provider: HostingProviderUnresolvedRemote;
    }>;

export type HostingProviderCompareUrlResult =
    | Readonly<{
        kind: 'resolved';
        url: string;
    }>
    | Readonly<{
        kind: 'unsupported';
        reason: 'unknown_provider' | 'adapter_unavailable' | 'unsupported_by_provider' | string;
        provider: HostingProviderResolvedRemote | HostingProviderUnresolvedRemote;
    }>;

export type HostingProviderResolvedRegistry = Readonly<{
    providers: readonly HostingProviderResolvedProvider[];
    providersById: ReadonlyMap<string, HostingProviderResolvedProvider>;
    diagnostics: readonly HostingProviderRegistryDiagnostic[];
    getProvider: (id: string) => HostingProviderResolvedProvider | undefined;
    getAdapter: (id: string) => HostingProviderRuntimeAdapter | undefined;
    detectRemote: (input: HostingProviderRemoteDetectionInput) => HostingProviderRemoteDetectionResult;
    buildCompareUrl: (input: Readonly<{
        provider: HostingProviderResolvedRemote | HostingProviderUnresolvedRemote;
        base: string;
        head: string;
    }>) => HostingProviderCompareUrlResult;
}>;

export type HostingProviderRuntimeServices = Readonly<{
    resolveScmHostingProviderRegistry?: () => Promise<HostingProviderResolvedRegistry>;
    resolveScmHostingTokenMaterialization?: (input: Readonly<{
        kind: 'scm_hosting_token';
        providerId: string;
        host: string;
        provider: ScmHostingProviderRef;
        profileId?: string | null;
    }>, options?: Readonly<{ signal?: AbortSignal }>) => Promise<HostingProviderRuntimeTokenMaterializationResult>;
    resolveScmHostingBasicAuthMaterialization?: (input: Readonly<{
        kind: 'scm_hosting_basic_auth';
        providerId: string;
        host: string;
        provider: ScmHostingProviderRef;
        profileId?: string | null;
    }>, options?: Readonly<{ signal?: AbortSignal }>) => Promise<HostingProviderRuntimeBasicAuthMaterializationResult>;
    executeCommand?: (input: Readonly<{
        executable:
            | Readonly<{
                kind: 'managedDependency';
                id: string | Readonly<{ pluginId: string; localId: string }>;
            }>
            | Readonly<{
                kind: 'systemTool';
                id: string | Readonly<{ pluginId: string; localId: string }>;
            }>
            | Readonly<{
                kind: 'packaged-runtime-binary';
                directorySegments: readonly string[];
                executableBaseName: string;
            }>;
        args: readonly string[];
        timeoutMs: number;
        env?: Readonly<Record<string, string>>;
        maxStdoutBytes?: number;
        maxStderrBytes?: number;
    }>, options?: Readonly<{ signal?: AbortSignal }>) => Promise<HostingProviderRuntimeCommandResult>;
}>;

export {
    readCurrentHostingProviderRuntimeServices,
    runWithHostingProviderRuntimeServices,
} from './hostingProviderRuntimeServices.js';

export type HostingProviderPullRequestListInput = Readonly<{
    runtimeServices?: HostingProviderRuntimeServices;
    signal?: AbortSignal;
    provider: ScmHostingProviderRef;
    base?: string;
    head: string;
    state?: ScmPullRequestState;
}>;

export type HostingProviderPullRequestGetInput = Readonly<{
    runtimeServices?: HostingProviderRuntimeServices;
    signal?: AbortSignal;
    provider: ScmHostingProviderRef;
    reference: ScmPullRequestReference;
}>;

export type HostingProviderPullRequestCreateInput = Readonly<{
    runtimeServices?: HostingProviderRuntimeServices;
    signal?: AbortSignal;
    provider: ScmHostingProviderRef;
    base: string;
    head: string;
    title: string;
    body?: string;
    draft?: boolean;
}>;

export type HostingProviderDefaultBranchInput = Readonly<{
    runtimeServices?: HostingProviderRuntimeServices;
    signal?: AbortSignal;
    provider: ScmHostingProviderRef;
}>;

export type HostingProviderDefaultBranchMetadata = Readonly<{
    name: string;
    sha?: string | null;
}>;

export type HostingProviderPullRequestCheckoutReferenceInput = Readonly<{
    runtimeServices?: HostingProviderRuntimeServices;
    signal?: AbortSignal;
    provider: ScmHostingProviderRef;
    reference: ScmPullRequestReference;
}>;

export type HostingProviderPullRequestCheckoutReferenceMetadata = Readonly<{
    pullRequest: ScmPullRequestSummary | null;
    branch?: string;
    remoteRef?: string;
    headSha?: string | null;
    baseSha?: string | null;
}>;

export type HostingProviderRepositoryDescribePublishTargetsInput = Readonly<{
    runtimeServices?: HostingProviderRuntimeServices;
    signal?: AbortSignal;
    provider: ScmHostingProviderRef;
    defaultRepositoryName: string;
}>;

export type HostingProviderRepositoryDescribePublishTargetsResult = Readonly<{
    auth: ScmHostingRepositoryPublishTarget['auth'];
    targets: readonly ScmHostingRepositoryPublishTarget[];
}>;

export type HostingProviderRepositoryCreateInput = Readonly<{
    runtimeServices?: HostingProviderRuntimeServices;
    signal?: AbortSignal;
    provider: ScmHostingProviderRef;
    owner: string;
    ownerKind?: 'user' | 'org';
    repositoryName: string;
    visibility: ScmHostingRepositoryVisibility;
    description?: string;
}>;

export type HostingProviderRepositoryGetInput = Readonly<{
    runtimeServices?: HostingProviderRuntimeServices;
    signal?: AbortSignal;
    provider: ScmHostingProviderRef;
    owner: string;
    repositoryName: string;
}>;

export type HostingProviderRepositoryDescribeCloneTargetsInput = Readonly<{
    runtimeServices?: HostingProviderRuntimeServices;
    signal?: AbortSignal;
    provider: ScmHostingProviderRef;
    repository: Readonly<{
        nameWithOwner: string;
        webUrl?: string;
        cloneUrl?: string;
        sshUrl?: string;
        defaultBranch?: string | null;
        visibility: ScmHostingRepositoryVisibility;
    }>;
}>;

export type HostingProviderRuntimeAdapter = Readonly<Record<string, unknown> & {
    detectRemote?: (input: HostingProviderRemoteDetectionInput) => HostingProviderResolvedRemote | null;
    buildCompareUrl?: (input: HostingProviderCompareUrlInput) => string | null;
    getPullRequestAuthProfileKey?: (input: Readonly<{ provider: ScmHostingProviderRef }>) => string | null;
    listPullRequests?: (input: HostingProviderPullRequestListInput) => Promise<readonly ScmPullRequestSummary[]>;
    getPullRequest?: (input: HostingProviderPullRequestGetInput) => Promise<ScmPullRequestSummary | null>;
    createPullRequest?: (input: HostingProviderPullRequestCreateInput) => Promise<ScmPullRequestSummary>;
    getDefaultBranch?: (input: HostingProviderDefaultBranchInput) => Promise<HostingProviderDefaultBranchMetadata>;
    resolvePullRequestCheckoutReference?: (
        input: HostingProviderPullRequestCheckoutReferenceInput
    ) => Promise<HostingProviderPullRequestCheckoutReferenceMetadata>;
    describePublishTargets?: (
        input: HostingProviderRepositoryDescribePublishTargetsInput
    ) => Promise<HostingProviderRepositoryDescribePublishTargetsResult>;
    createRepository?: (
        input: HostingProviderRepositoryCreateInput
    ) => Promise<ScmHostingRepositorySummary>;
    getRepository?: (
        input: HostingProviderRepositoryGetInput
    ) => Promise<ScmHostingRepositorySummary | null>;
    describeCloneTargets?: (
        input: HostingProviderRepositoryDescribeCloneTargetsInput
    ) => Promise<ScmRepositoryCloneTargetDescription>;
}>;

export type HostingProviderRuntimeRegistration = Readonly<{
    id: string;
    adapter: HostingProviderRuntimeAdapter;
}>;

/** @realm any */
export {
    ScmHostingProviderKindSchema,
    resolveScmHostingProviderFollowupAllowedBaseUrl,
} from './hostingProviderProjections.js';

export {
    requestScmForgeJson as requestForgeJson,
} from './forgeHttp.js';

export type {
    ScmForgeHttpErrorContext as ForgeHttpErrorContext,
    ScmForgeHttpErrorMapper as ForgeHttpErrorMapper,
    ScmForgeHttpFetcher as ForgeHttpFetcher,
    ScmForgeHttpJsonRequest as ForgeHttpJsonRequest,
    ScmForgeHttpResponse as ForgeHttpResponse,
} from './forgeHttp.js';

export type { HostingProviderRuntime } from '../activation.js';

// Pre-EU-4 source bridge for the still-live experimental SCM consumers. The
// final /scm/hosting inventory excludes these predecessor identities, and no
// final declaration above depends on them.
export type ScmHostingProviderCompareUrlInput = HostingProviderCompareUrlInput;
export type ScmHostingProviderCompareUrlResult = HostingProviderCompareUrlResult;
export type ScmHostingProviderDefaultBranchInput = HostingProviderDefaultBranchInput;
export type ScmHostingProviderDefaultBranchMetadata = HostingProviderDefaultBranchMetadata;
export type ScmHostingProviderDescriptor = HostingProviderDescriptor;
export type ScmHostingProviderPullRequestCheckoutReferenceInput = HostingProviderPullRequestCheckoutReferenceInput;
export type ScmHostingProviderPullRequestCheckoutReferenceMetadata = HostingProviderPullRequestCheckoutReferenceMetadata;
export type ScmHostingProviderPullRequestCreateInput = HostingProviderPullRequestCreateInput;
export type ScmHostingProviderPullRequestGetInput = HostingProviderPullRequestGetInput;
export type ScmHostingProviderPullRequestListInput = HostingProviderPullRequestListInput;
export type ScmHostingProviderRegistryDiagnostic = HostingProviderRegistryDiagnostic;
export type ScmHostingProviderRemoteDetectionInput = HostingProviderRemoteDetectionInput;
export type ScmHostingProviderRemoteDetectionResult = HostingProviderRemoteDetectionResult;
export type ScmHostingProviderRepositoryCreateInput = HostingProviderRepositoryCreateInput;
export type ScmHostingProviderRepositoryDescribeCloneTargetsInput = HostingProviderRepositoryDescribeCloneTargetsInput;
export type ScmHostingProviderRepositoryDescribePublishTargetsInput = HostingProviderRepositoryDescribePublishTargetsInput;
export type ScmHostingProviderRepositoryDescribePublishTargetsResult = HostingProviderRepositoryDescribePublishTargetsResult;
export type ScmHostingProviderRepositoryGetInput = HostingProviderRepositoryGetInput;
export type ScmHostingProviderResolvedProvider = HostingProviderResolvedProvider;
export type ScmHostingProviderResolvedRegistry = HostingProviderResolvedRegistry;
export type ScmHostingProviderResolvedRemote = HostingProviderResolvedRemote;
export type ScmHostingProviderRuntimeAdapter = HostingProviderRuntimeAdapter;
export type ScmHostingProviderRuntimeBasicAuthMaterializationResult = HostingProviderRuntimeBasicAuthMaterializationResult;
export type ScmHostingProviderRuntimeCommandResult = HostingProviderRuntimeCommandResult;
export type ScmHostingProviderRuntimeRegistration = HostingProviderRuntimeRegistration;
export type ScmHostingProviderRuntimeServices = HostingProviderRuntimeServices;
export type ScmHostingProviderRuntimeTokenMaterializationResult = HostingProviderRuntimeTokenMaterializationResult;
export type ScmHostingProviderUnresolvedRemote = HostingProviderUnresolvedRemote;

export {
    readCurrentHostingProviderRuntimeServices as readCurrentScmHostingProviderRuntimeServices,
    runWithHostingProviderRuntimeServices as runWithScmHostingProviderRuntimeServices,
} from './hostingProviderRuntimeServices.js';
