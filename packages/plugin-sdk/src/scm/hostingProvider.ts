import { AsyncLocalStorage } from 'node:async_hooks';

import type {
    ConnectedServiceCredentialKind,
    ConnectedServiceCredentialRecordV1,
    ConnectedServiceId,
    ScmHostingProviderContribution,
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
    kind: string;
    displayName: string;
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

export type ScmHostingProviderUnresolvedRemote = Readonly<{
    id: 'unknown';
    kind: 'unknown';
    displayName: string;
    remoteName?: string | null;
    unsupportedReason: string;
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

export type ScmHostingProviderRuntimeAuthMaterializationMissingReason =
    | 'unsupported_materialization'
    | 'unsupported_provider'
    | 'unsupported_host'
    | 'credential_unavailable';

export type ScmHostingProviderRuntimeTokenMaterializerRequest = Readonly<{
    kind: 'scm_hosting_token';
    providerId: string;
    host: string;
    profileId?: string | null;
    records: readonly ConnectedServiceCredentialRecordV1[];
}>;

export type ScmHostingProviderRuntimeTokenMaterializerResult =
    | Readonly<{
        kind: 'available';
        token: string;
        profileId: string;
        serviceId: ConnectedServiceId;
        credentialKind: ConnectedServiceCredentialKind;
        providerAccountId: string | null;
        providerEmail: string | null;
    }>
    | Readonly<{
        kind: 'missing';
        reason: ScmHostingProviderRuntimeAuthMaterializationMissingReason;
    }>;

export type ScmHostingProviderRuntimeTokenMaterializer = Readonly<{
    serviceId: ConnectedServiceId;
    materialize(
        request: ScmHostingProviderRuntimeTokenMaterializerRequest
    ): Promise<ScmHostingProviderRuntimeTokenMaterializerResult> | ScmHostingProviderRuntimeTokenMaterializerResult;
}>;

export type ScmHostingProviderRuntimeBasicAuthMaterializerRequest = Readonly<{
    kind: 'scm_hosting_basic_auth';
    providerId: string;
    host: string;
    profileId?: string | null;
    records: readonly ConnectedServiceCredentialRecordV1[];
}>;

export type ScmHostingProviderRuntimeBasicAuthMaterializerResult =
    | Readonly<{
        kind: 'available';
        username: string;
        password: string;
        profileId: string;
        serviceId: ConnectedServiceId;
        credentialKind: 'bitbucket_basic_auth';
        providerAccountId: string | null;
        providerEmail: string | null;
    }>
    | Readonly<{
        kind: 'missing';
        reason: ScmHostingProviderRuntimeAuthMaterializationMissingReason;
    }>;

export type ScmHostingProviderRuntimeBasicAuthMaterializer = Readonly<{
    serviceId: ConnectedServiceId;
    materialize(
        request: ScmHostingProviderRuntimeBasicAuthMaterializerRequest
    ): Promise<ScmHostingProviderRuntimeBasicAuthMaterializerResult> | ScmHostingProviderRuntimeBasicAuthMaterializerResult;
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

export type ScmHostingProviderDescriptor = Readonly<Omit<ScmHostingProviderContribution, 'urlSafety'> & {
    pluginId?: string;
    urlSafety?: Readonly<{
        allowedSchemes: readonly string[];
        allowedBaseUrls: readonly string[];
        allowedOrigins: readonly string[];
    }>;
}>;

export type ScmHostingProviderRuntimeBinding = Readonly<{
    pluginId: string;
    registration: ScmHostingProviderRuntimeRegistration;
}>;

export type ScmHostingProviderRegistryDiagnostic = Readonly<{
    code: string;
    message: string;
    pluginId?: string;
    providerId?: string;
}>;

export type ScmHostingProviderResolvedProvider = ScmHostingProviderDescriptor & Readonly<{
    runtime?: ScmHostingProviderRuntimeBinding;
}>;

export type ScmHostingProviderRemoteDetectionResult =
    | Readonly<{
        kind: 'resolved';
        providerId: string;
        provider: ScmHostingProviderResolvedRemote;
    }>
    | Readonly<{
        kind: 'unknown';
        provider: ScmHostingProviderUnresolvedRemote;
    }>;

export type ScmHostingProviderCompareUrlResult =
    | Readonly<{
        kind: 'resolved';
        url: string;
    }>
    | Readonly<{
        kind: 'unsupported';
        reason: 'unknown_provider' | 'adapter_unavailable' | 'unsupported_by_provider' | string;
        provider: ScmHostingProviderResolvedRemote | ScmHostingProviderUnresolvedRemote;
    }>;

export type ScmHostingProviderResolvedRegistry = Readonly<{
    providers: readonly ScmHostingProviderResolvedProvider[];
    providersById: ReadonlyMap<string, ScmHostingProviderResolvedProvider>;
    diagnostics: readonly ScmHostingProviderRegistryDiagnostic[];
    getProvider: (id: string) => ScmHostingProviderResolvedProvider | undefined;
    getAdapter: (id: string) => ScmHostingProviderRuntimeAdapter | undefined;
    detectRemote: (input: ScmHostingProviderRemoteDetectionInput) => ScmHostingProviderRemoteDetectionResult;
    buildCompareUrl: (input: Readonly<{
        provider: ScmHostingProviderResolvedRemote | ScmHostingProviderUnresolvedRemote;
        base: string;
        head: string;
    }>) => ScmHostingProviderCompareUrlResult;
}>;

export type ScmHostingProviderRuntimeServices = Readonly<{
    resolveScmHostingProviderRegistry?: () => Promise<ScmHostingProviderResolvedRegistry>;
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

const SCM_HOSTING_PROVIDER_RUNTIME_SERVICES_STORAGE_KEY = Symbol.for(
    'happier.pluginSdk.scm.hostingProviderRuntimeServicesStorage',
);

function resolveScmHostingProviderRuntimeServicesStorage(): AsyncLocalStorage<ScmHostingProviderRuntimeServices> {
    const globalScope = globalThis as typeof globalThis & Record<symbol, unknown>;
    const existing = globalScope[SCM_HOSTING_PROVIDER_RUNTIME_SERVICES_STORAGE_KEY];
    if (existing instanceof AsyncLocalStorage) {
        return existing as AsyncLocalStorage<ScmHostingProviderRuntimeServices>;
    }

    const storage = new AsyncLocalStorage<ScmHostingProviderRuntimeServices>();
    globalScope[SCM_HOSTING_PROVIDER_RUNTIME_SERVICES_STORAGE_KEY] = storage;
    return storage;
}

const scmHostingProviderRuntimeServicesStorage = resolveScmHostingProviderRuntimeServicesStorage();

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
    remoteRef?: string;
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
    auth?: Readonly<{
        tokenMaterializer?: ScmHostingProviderRuntimeTokenMaterializer;
        basicAuthMaterializer?: ScmHostingProviderRuntimeBasicAuthMaterializer;
    }>;
}>;
