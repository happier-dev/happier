import { AsyncLocalStorage } from 'node:async_hooks';

import type {
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
    ScmBackendCapabilities,
    ScmBranchCheckoutRequest,
    ScmBranchCheckoutResponse,
    ScmBranchCreateRequest,
    ScmBranchCreateResponse,
    ScmBranchIntegrationRequest,
    ScmBranchIntegrationResponse,
    ScmBranchListRequest,
    ScmBranchListResponse,
    ScmBranchOperationControlRequest,
    ScmChangeApplyRequest,
    ScmChangeApplyResponse,
    ScmChangeDiscardRequest,
    ScmChangeDiscardResponse,
    ScmCommitBackoutRequest,
    ScmCommitBackoutResponse,
    ScmCommitCreateRequest,
    ScmCommitCreateResponse,
    ScmDiffCommitRequest,
    ScmDiffCommitResponse,
    ScmDiffFileRequest,
    ScmDiffFileResponse,
    ScmHostingRepositoryDescribePublishTargetsRequest,
    ScmHostingRepositoryDescribePublishTargetsResponse,
    ScmHostingRepositoryPublishRequest,
    ScmHostingRepositoryPublishResponse,
    ScmLogListRequest,
    ScmLogListResponse,
    ScmPullRequestGetRequest,
    ScmPullRequestGetResponse,
    ScmPullRequestListRequest,
    ScmPullRequestListResponse,
    ScmPullRequestOpenComposeRequest,
    ScmPullRequestOpenComposeResponse,
    ScmPullRequestOpenOrReuseRequest,
    ScmPullRequestOpenOrReuseResponse,
    ScmPullRequestCheckoutRequest,
    ScmPullRequestCheckoutResponse,
    ScmPullRequestPrepareWorktreeRequest,
    ScmPullRequestPrepareWorktreeResponse,
    ScmPullRequestRunStackedRequest,
    ScmPullRequestRunStackedResponse,
    ScmRemoteAddRequest,
    ScmRemoteManagementResponse,
    ScmRemotePublishRequest,
    ScmRemotePublishResponse,
    ScmRemoteRemoveRequest,
    ScmRemoteRequest,
    ScmRemoteResponse,
    ScmRemoteSetUrlRequest,
    ScmRepositoryCloneInput,
    ScmRepositoryCloneOutput,
    ScmRepositoryInitRequest,
    ScmRepositoryInitResponse,
    ScmRepositoryRemoveIndexLockRequest,
    ScmRepositoryRemoveIndexLockResponse,
    ScmRepoMode,
    ScmStashApplyRequest,
    ScmStashApplyResponse,
    ScmStashDropRequest,
    ScmStashDropResponse,
    ScmStashListRequest,
    ScmStashListResponse,
    ScmStashPopRequest,
    ScmStashPopResponse,
    ScmStashShowRequest,
    ScmStashShowResponse,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
    ScmWorktreeCreateRequest,
    ScmWorktreeCreateResponse,
    ScmWorktreesEnrichmentRequest,
    ScmWorktreesEnrichmentResponse,
    ScmWorktreePruneRequest,
    ScmWorktreePruneResponse,
    ScmWorktreeRemoveRequest,
    ScmWorktreeRemoveResponse,
    WorkspaceCheckoutKind,
    WorkspaceLocationScm,
} from '@happier-dev/protocol';

export type ScmBackendRuntimeContext = Readonly<{
    cwd: string;
    projectKey: string;
    detection: Readonly<{
        isRepo: boolean;
        rootPath: string | null;
        mode: ScmRepoMode | null;
    }>;
}>;

export type ScmBackendRuntimeDetection = Readonly<{
    isRepo: boolean;
    rootPath: string | null;
    mode: ScmRepoMode | null;
}>;

export type ScmBackendRuntimeHandlerInput<TRequest> = Readonly<{
    context: ScmBackendRuntimeContext;
    request: TRequest;
    /** Operation-scoped cancellation; plugin code must forward it across external awaits. */
    signal: AbortSignal;
}>;

export type ScmWorkspaceIntegrationCheckoutMaterializationRequest = Readonly<{
    targetPath: string;
    sourcePath?: string;
    previousTargetPath?: string;
    workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutKind = 'git_worktree';

export type ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    sourcePath: string;
    displayName: string;
    baseRef: string | null;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    targetPath: string;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    sourcePath: string;
    targetPath: string;
    displayName: string;
    baseRef: string | null;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult = Readonly<{
    targetPath: string;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    sourcePath: string;
    displayName: string;
    baseRef: string | null;
    targetPath: string | null;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    targetPath: string;
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferEntry = Readonly<{
    relativePath: string;
    sourcePath: string;
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferMetadata = Readonly<Record<string, unknown>>;

export type ScmWorkspaceIntegrationWorkspaceTransferRequest = Readonly<{
    strategy: 'transfer_snapshot' | 'sync_changes';
    includeIgnoredMode: 'exclude' | 'include_selected';
    ignoredIncludeGlobs: readonly string[];
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferResult = Readonly<{
    entries: readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[];
    metadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata | null;
}>;

export type ScmWorkspaceIntegrationPortableWorkspacePathClassification =
    | 'portable'
    | 'non_portable'
    | 'scm_administrative'
    | 'unknown';

export type ScmWorkspaceIntegrationPortableWorkspacePathRequest = Readonly<{
    relativePath: string;
}>;

export type ScmWorkspaceIntegrationWorkspaceLocationInspection = Readonly<{
    rootPath: string;
    scmProvider?: WorkspaceLocationScm['provider'];
    checkoutDiscovery?: readonly Readonly<{
        kind: Exclude<WorkspaceCheckoutKind, 'primary'>;
        path?: string;
    }>[];
    checkoutProviderKinds?: readonly Exclude<WorkspaceCheckoutKind, 'primary'>[];
}>;

export type ScmBackendRuntimeWorkspaceIntegrationHandlers = Readonly<{
    inspectWorkspaceLocation?: (
        input: Readonly<{ context: ScmBackendRuntimeContext }>
    ) => Promise<ScmWorkspaceIntegrationWorkspaceLocationInspection | null> | ScmWorkspaceIntegrationWorkspaceLocationInspection | null;
    reconcilePostMaterialization?: (
        input: Readonly<{
            context: ScmBackendRuntimeContext;
            checkoutMaterialization: ScmWorkspaceIntegrationCheckoutMaterializationRequest;
            sourcePath?: string;
            previousTargetPath?: string;
            workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata;
        }>
    ) => Promise<void> | void;
    realizeWorkspaceCheckout?: (
        input: Readonly<{
            context: ScmBackendRuntimeContext;
            workspaceCheckoutRealization: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest;
        }>
    ) => Promise<ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult> | ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult;
    createWorkspaceCheckout?: (
        input: Readonly<{
            context: ScmBackendRuntimeContext;
            workspaceCheckoutCreation: ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest;
        }>
    ) => Promise<ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult> | ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult;
    materializeWorkspaceCheckout?: (
        input: Readonly<{
            context: ScmBackendRuntimeContext;
            workspaceCheckoutMaterialization: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest;
        }>
    ) => Promise<ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult | void> | ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult | void;
    resolveWorkspaceTransferEntries?: (
        input: Readonly<{
            context: ScmBackendRuntimeContext;
            workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequest;
        }>
    ) => Promise<readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[] | null> | readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[] | null;
    resolveWorkspaceTransferMetadata?: (
        input: Readonly<{
            context: ScmBackendRuntimeContext;
            workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequest;
        }>
    ) => Promise<ScmWorkspaceIntegrationWorkspaceTransferMetadata | null> | ScmWorkspaceIntegrationWorkspaceTransferMetadata | null;
    assertPortableWorkspaceEntries?: (
        input: Readonly<{ entries: readonly Readonly<{ relativePath: string }>[] }>
    ) => Promise<void> | void;
    classifyPortableWorkspaceTransferEntry?: (
        input: ScmWorkspaceIntegrationWorkspaceTransferEntry
    ) => ScmWorkspaceIntegrationPortableWorkspacePathClassification;
    isAdministrativeWorkspacePath?: (
        input: Readonly<{ relativePath: string }>
    ) => boolean;
    classifyPortableWorkspacePath?: (
        input: ScmWorkspaceIntegrationPortableWorkspacePathRequest
    ) => ScmWorkspaceIntegrationPortableWorkspacePathClassification;
}>;

export type ScmBackendRuntimeHandlers = Readonly<{
    detection?: Readonly<{
        detectRepo?: (input: Readonly<{ cwd: string }>) => Promise<ScmBackendRuntimeDetection> | ScmBackendRuntimeDetection;
        describeBackend?: (
            input: ScmBackendRuntimeHandlerInput<ScmBackendDescribeRequest>
        ) => Promise<ScmBackendDescribeResponse> | ScmBackendDescribeResponse;
    }>;
    read?: Readonly<{
        statusSnapshot?: (
            input: ScmBackendRuntimeHandlerInput<ScmStatusSnapshotRequest>
        ) => Promise<ScmStatusSnapshotResponse> | ScmStatusSnapshotResponse;
        worktreesEnrichment?: (
            input: ScmBackendRuntimeHandlerInput<ScmWorktreesEnrichmentRequest>
        ) => Promise<ScmWorktreesEnrichmentResponse> | ScmWorktreesEnrichmentResponse;
        diffFile?: (
            input: ScmBackendRuntimeHandlerInput<ScmDiffFileRequest>
        ) => Promise<ScmDiffFileResponse> | ScmDiffFileResponse;
        diffCommit?: (
            input: ScmBackendRuntimeHandlerInput<ScmDiffCommitRequest>
        ) => Promise<ScmDiffCommitResponse> | ScmDiffCommitResponse;
        logList?: (
            input: ScmBackendRuntimeHandlerInput<ScmLogListRequest>
        ) => Promise<ScmLogListResponse> | ScmLogListResponse;
        stashList?: (
            input: ScmBackendRuntimeHandlerInput<ScmStashListRequest>
        ) => Promise<ScmStashListResponse> | ScmStashListResponse;
    }>;
    changeSet?: Readonly<{
        include?: (input: ScmBackendRuntimeHandlerInput<ScmChangeApplyRequest>) => Promise<ScmChangeApplyResponse> | ScmChangeApplyResponse;
        exclude?: (input: ScmBackendRuntimeHandlerInput<ScmChangeApplyRequest>) => Promise<ScmChangeApplyResponse> | ScmChangeApplyResponse;
        discard?: (input: ScmBackendRuntimeHandlerInput<ScmChangeDiscardRequest>) => Promise<ScmChangeDiscardResponse> | ScmChangeDiscardResponse;
    }>;
    commit?: Readonly<{
        create?: (input: ScmBackendRuntimeHandlerInput<ScmCommitCreateRequest>) => Promise<ScmCommitCreateResponse> | ScmCommitCreateResponse;
        backout?: (input: ScmBackendRuntimeHandlerInput<ScmCommitBackoutRequest>) => Promise<ScmCommitBackoutResponse> | ScmCommitBackoutResponse;
    }>;
    remote?: Readonly<{
        add?: (input: ScmBackendRuntimeHandlerInput<ScmRemoteAddRequest>) => Promise<ScmRemoteManagementResponse> | ScmRemoteManagementResponse;
        setUrl?: (input: ScmBackendRuntimeHandlerInput<ScmRemoteSetUrlRequest>) => Promise<ScmRemoteManagementResponse> | ScmRemoteManagementResponse;
        remove?: (input: ScmBackendRuntimeHandlerInput<ScmRemoteRemoveRequest>) => Promise<ScmRemoteManagementResponse> | ScmRemoteManagementResponse;
        fetch?: (input: ScmBackendRuntimeHandlerInput<ScmRemoteRequest>) => Promise<ScmRemoteResponse> | ScmRemoteResponse;
        pull?: (input: ScmBackendRuntimeHandlerInput<ScmRemoteRequest>) => Promise<ScmRemoteResponse> | ScmRemoteResponse;
        push?: (input: ScmBackendRuntimeHandlerInput<ScmRemoteRequest>) => Promise<ScmRemoteResponse> | ScmRemoteResponse;
        publish?: (input: ScmBackendRuntimeHandlerInput<ScmRemotePublishRequest>) => Promise<ScmRemotePublishResponse> | ScmRemotePublishResponse;
    }>;
    branch?: Readonly<{
        list?: (input: ScmBackendRuntimeHandlerInput<ScmBranchListRequest>) => Promise<ScmBranchListResponse> | ScmBranchListResponse;
        create?: (input: ScmBackendRuntimeHandlerInput<ScmBranchCreateRequest>) => Promise<ScmBranchCreateResponse> | ScmBranchCreateResponse;
        checkout?: (input: ScmBackendRuntimeHandlerInput<ScmBranchCheckoutRequest>) => Promise<ScmBranchCheckoutResponse> | ScmBranchCheckoutResponse;
        merge?: (input: ScmBackendRuntimeHandlerInput<ScmBranchIntegrationRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
        rebase?: (input: ScmBackendRuntimeHandlerInput<ScmBranchIntegrationRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
        operationContinue?: (input: ScmBackendRuntimeHandlerInput<ScmBranchOperationControlRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
        operationAbort?: (input: ScmBackendRuntimeHandlerInput<ScmBranchOperationControlRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
    }>;
    worktree?: Readonly<{
        create?: (input: ScmBackendRuntimeHandlerInput<ScmWorktreeCreateRequest>) => Promise<ScmWorktreeCreateResponse> | ScmWorktreeCreateResponse;
        remove?: (input: ScmBackendRuntimeHandlerInput<ScmWorktreeRemoveRequest>) => Promise<ScmWorktreeRemoveResponse> | ScmWorktreeRemoveResponse;
        prune?: (input: ScmBackendRuntimeHandlerInput<ScmWorktreePruneRequest>) => Promise<ScmWorktreePruneResponse> | ScmWorktreePruneResponse;
    }>;
    lifecycle?: Readonly<{
        init?: (input: ScmBackendRuntimeHandlerInput<ScmRepositoryInitRequest>) => Promise<ScmRepositoryInitResponse> | ScmRepositoryInitResponse;
        clone?: (input: ScmBackendRuntimeHandlerInput<ScmRepositoryCloneInput>) => Promise<ScmRepositoryCloneOutput> | ScmRepositoryCloneOutput;
        removeIndexLock?: (input: ScmBackendRuntimeHandlerInput<ScmRepositoryRemoveIndexLockRequest>) => Promise<ScmRepositoryRemoveIndexLockResponse> | ScmRepositoryRemoveIndexLockResponse;
    }>;
    hosting?: Readonly<{
        repositoryDescribePublishTargets?: (
            input: ScmBackendRuntimeHandlerInput<ScmHostingRepositoryDescribePublishTargetsRequest>
        ) => Promise<ScmHostingRepositoryDescribePublishTargetsResponse> | ScmHostingRepositoryDescribePublishTargetsResponse;
        repositoryPublish?: (
            input: ScmBackendRuntimeHandlerInput<ScmHostingRepositoryPublishRequest>
        ) => Promise<ScmHostingRepositoryPublishResponse> | ScmHostingRepositoryPublishResponse;
        pullRequestList?: (input: ScmBackendRuntimeHandlerInput<ScmPullRequestListRequest>) => Promise<ScmPullRequestListResponse> | ScmPullRequestListResponse;
        pullRequestGet?: (input: ScmBackendRuntimeHandlerInput<ScmPullRequestGetRequest>) => Promise<ScmPullRequestGetResponse> | ScmPullRequestGetResponse;
        pullRequestOpenCompose?: (
            input: ScmBackendRuntimeHandlerInput<ScmPullRequestOpenComposeRequest>
        ) => Promise<ScmPullRequestOpenComposeResponse> | ScmPullRequestOpenComposeResponse;
        pullRequestOpenOrReuse?: (
            input: ScmBackendRuntimeHandlerInput<ScmPullRequestOpenOrReuseRequest>
        ) => Promise<ScmPullRequestOpenOrReuseResponse> | ScmPullRequestOpenOrReuseResponse;
        pullRequestCheckout?: (
            input: ScmBackendRuntimeHandlerInput<ScmPullRequestCheckoutRequest>
        ) => Promise<ScmPullRequestCheckoutResponse> | ScmPullRequestCheckoutResponse;
        pullRequestPrepareWorktree?: (
            input: ScmBackendRuntimeHandlerInput<ScmPullRequestPrepareWorktreeRequest>
        ) => Promise<ScmPullRequestPrepareWorktreeResponse> | ScmPullRequestPrepareWorktreeResponse;
        pullRequestRunStacked?: (
            input: ScmBackendRuntimeHandlerInput<ScmPullRequestRunStackedRequest>
        ) => Promise<ScmPullRequestRunStackedResponse> | ScmPullRequestRunStackedResponse;
    }>;
    stash?: Readonly<{
        drop?: (input: ScmBackendRuntimeHandlerInput<ScmStashDropRequest>) => Promise<ScmStashDropResponse> | ScmStashDropResponse;
        pop?: (input: ScmBackendRuntimeHandlerInput<ScmStashPopRequest>) => Promise<ScmStashPopResponse> | ScmStashPopResponse;
        apply?: (input: ScmBackendRuntimeHandlerInput<ScmStashApplyRequest>) => Promise<ScmStashApplyResponse> | ScmStashApplyResponse;
        show?: (input: ScmBackendRuntimeHandlerInput<ScmStashShowRequest>) => Promise<ScmStashShowResponse> | ScmStashShowResponse;
    }>;
    workspaceIntegration?: ScmBackendRuntimeWorkspaceIntegrationHandlers;
}>;

export type ScmBackendRuntimeRegistration = Readonly<{
    id: string;
    runtime?: Readonly<{
        repoModes: readonly ScmRepoMode[];
        capabilities: ScmBackendCapabilities;
        commands: readonly Readonly<{
            installableKey: string;
            command: string;
        }>[];
    }>;
    handlers: ScmBackendRuntimeHandlers;
}>;

export type ScmBackendCommandRunInput = Readonly<{
    installableKey: string;
    command: string;
    cwd: string;
    args: readonly string[];
    timeoutMs?: number;
    stdin?: string;
    maxOutputBytes?: number;
    env?: Readonly<Record<string, string | undefined>>;
}>;

export type ScmBackendCommandRunResult = Readonly<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
}>;

export type ScmBackendRuntimeServices = Readonly<{
    runCommand(input: ScmBackendCommandRunInput): Promise<ScmBackendCommandRunResult>;
}>;

const SCM_BACKEND_RUNTIME_SERVICES_STORAGE_KEY = Symbol.for(
    'happier.pluginSdk.scm.backendRuntimeServicesStorage',
);

function resolveScmBackendRuntimeServicesStorage(): AsyncLocalStorage<ScmBackendRuntimeServices> {
    const globalScope = globalThis as typeof globalThis & Record<symbol, unknown>;
    const existing = globalScope[SCM_BACKEND_RUNTIME_SERVICES_STORAGE_KEY];
    if (existing instanceof AsyncLocalStorage) {
        return existing as AsyncLocalStorage<ScmBackendRuntimeServices>;
    }

    const storage = new AsyncLocalStorage<ScmBackendRuntimeServices>();
    globalScope[SCM_BACKEND_RUNTIME_SERVICES_STORAGE_KEY] = storage;
    return storage;
}

const scmBackendRuntimeServicesStorage = resolveScmBackendRuntimeServicesStorage();

export function runWithScmBackendRuntimeServices<T>(
    services: ScmBackendRuntimeServices,
    callback: () => T,
): T {
    return scmBackendRuntimeServicesStorage.run(services, callback);
}

export function readCurrentScmBackendRuntimeServices(): ScmBackendRuntimeServices | null {
    return scmBackendRuntimeServicesStorage.getStore() ?? null;
}
