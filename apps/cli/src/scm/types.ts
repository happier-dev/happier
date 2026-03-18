import type {
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
    ScmBranchCheckoutRequest,
    ScmBranchCheckoutResponse,
    ScmBranchCreateRequest,
    ScmBranchCreateResponse,
    ScmBranchListRequest,
    ScmBranchListResponse,
    ScmCapabilities,
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
    ScmLogListRequest,
    ScmLogListResponse,
    ScmRemotePublishRequest,
    ScmRemotePublishResponse,
    ScmRemoteRequest,
    ScmRemoteResponse,
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
    ScmWorktreePruneRequest,
    ScmWorktreePruneResponse,
    ScmWorktreeRemoveRequest,
    ScmWorktreeRemoveResponse,
    ScmBackendId,
    WorkspaceCheckoutKind,
    WorkspaceLocationScm,
} from '@happier-dev/protocol';

import type { ScmSourceControllerCheckoutMaterializationRequest } from './sourceController/checkoutMaterialization';
import type {
    ScmSourceControllerWorkspaceCheckoutCreationRequest,
    ScmSourceControllerWorkspaceCheckoutCreationResult,
} from './sourceController/workspaceCheckoutCreation';
import type {
    ScmSourceControllerPortableWorkspacePathClassification,
    ScmSourceControllerPortableWorkspacePathRequest,
} from './sourceController/portableWorkspacePath';
import type {
    ScmSourceControllerWorkspaceCheckoutRealizationRequest,
    ScmSourceControllerWorkspaceCheckoutRealizationResult,
} from './sourceController/workspaceCheckoutRealization';
import type { ScmSourceControllerWorkspaceCheckoutMaterializationRequest } from './sourceController/workspaceCheckoutMaterialization';
import type { ScmSourceControllerWorkspaceCheckoutMaterializationResult } from './sourceController/workspaceCheckoutMaterialization';
import type {
    ScmSourceControllerWorkspaceTransferEntry,
    ScmSourceControllerWorkspaceTransferMetadata,
    ScmSourceControllerWorkspaceTransferRequest,
    ScmSourceControllerWorkspaceTransferResult,
} from './sourceController/workspaceTransfer';
import type { ScmSourceControllerWorkspaceExportArtifacts } from './sourceController/workspaceExportArtifacts';

export type ScmRepoDetection = {
    isRepo: boolean;
    rootPath: string | null;
    mode: ScmRepoMode | null;
};

export type ScmBackendContext = {
    cwd: string;
    projectKey: string;
    detection: ScmRepoDetection;
};

export type ScmBackendSelection = {
    modeSelectionScores: Partial<Record<ScmRepoMode, number>>;
    preferenceAllowedModes?: readonly ScmRepoMode[];
};

export type ScmSourceControllerWorkspaceLocationInspection = Readonly<{
    rootPath: string;
    scmProvider?: WorkspaceLocationScm['provider'];
    checkoutDiscovery?: readonly ScmSourceControllerCheckoutDiscovery[];
    checkoutProviderKinds?: readonly Exclude<WorkspaceCheckoutKind, 'primary'>[];
}>;

export type ScmSourceControllerCheckoutDiscovery = Readonly<{
    kind: Exclude<WorkspaceCheckoutKind, 'primary'>;
    path?: string;
}>;

export type ScmSourceControllerPostMaterializationInput = Readonly<{
    context: ScmBackendContext;
    checkoutMaterialization: ScmSourceControllerCheckoutMaterializationRequest;
    sourcePath?: string;
    previousTargetPath?: string;
    sourceControllerMetadata?: ScmSourceControllerWorkspaceTransferMetadata;
}>;

export type ScmSourceControllerWorkspaceTransferInput = Readonly<{
    context: ScmBackendContext;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequest;
}>;

export type ScmSourceControllerWorkspaceTransferEntryInput = ScmSourceControllerWorkspaceTransferEntry;

export type ScmSourceControllerWorkspaceCheckoutMaterializationInput = Readonly<{
    context: ScmBackendContext;
    workspaceCheckoutMaterialization: ScmSourceControllerWorkspaceCheckoutMaterializationRequest;
}>;

export type ScmSourceControllerWorkspaceCheckoutCreationInput = Readonly<{
    context: ScmBackendContext;
    workspaceCheckoutCreation: ScmSourceControllerWorkspaceCheckoutCreationRequest;
}>;

export type { ScmSourceControllerWorkspaceCheckoutCreationResult };

export type ScmSourceControllerWorkspaceCheckoutRealizationInput = Readonly<{
    context: ScmBackendContext;
    workspaceCheckoutRealization: ScmSourceControllerWorkspaceCheckoutRealizationRequest;
}>;

export type { ScmSourceControllerWorkspaceCheckoutRealizationResult };

export type ScmSourceControllerPortableWorkspaceEntriesInput = Readonly<{
    entries: readonly Readonly<{
        relativePath: string;
    }>[];
}>;

export type ScmSourceControllerAdministrativePathInput = Readonly<{
    relativePath: string;
}>;

export type ScmSourceControllerPortableWorkspacePathInput = ScmSourceControllerPortableWorkspacePathRequest;

export type ScmSourceController = Readonly<{
    inspectWorkspaceLocation: (input: Readonly<{
        context: ScmBackendContext;
    }>) => Promise<ScmSourceControllerWorkspaceLocationInspection | null>;
    reconcilePostMaterialization?: (input: ScmSourceControllerPostMaterializationInput) => Promise<void>;
    realizeWorkspaceCheckout?: (
        input: ScmSourceControllerWorkspaceCheckoutRealizationInput,
    ) => Promise<ScmSourceControllerWorkspaceCheckoutRealizationResult>;
    createWorkspaceCheckout?: (
        input: ScmSourceControllerWorkspaceCheckoutCreationInput,
    ) => Promise<ScmSourceControllerWorkspaceCheckoutCreationResult>;
    materializeWorkspaceCheckout?: (
        input: ScmSourceControllerWorkspaceCheckoutMaterializationInput,
    ) => Promise<ScmSourceControllerWorkspaceCheckoutMaterializationResult | void>;
    resolveWorkspaceTransfer?: (input: ScmSourceControllerWorkspaceTransferInput) => Promise<ScmSourceControllerWorkspaceTransferResult | null>;
    resolveWorkspaceExportArtifacts?: (
        input: ScmSourceControllerWorkspaceTransferInput,
    ) => Promise<ScmSourceControllerWorkspaceExportArtifacts | null>;
    resolveWorkspaceTransferEntries?: (input: ScmSourceControllerWorkspaceTransferInput) => Promise<readonly ScmSourceControllerWorkspaceTransferEntry[] | null>;
    resolveWorkspaceTransferMetadata?: (input: ScmSourceControllerWorkspaceTransferInput) => Promise<ScmSourceControllerWorkspaceTransferMetadata | null>;
    assertPortableWorkspaceEntries?: (input: ScmSourceControllerPortableWorkspaceEntriesInput) => Promise<void>;
    classifyPortableWorkspaceTransferEntry?: (
        input: ScmSourceControllerWorkspaceTransferEntryInput,
    ) => ScmSourceControllerPortableWorkspacePathClassification;
    isAdministrativeWorkspacePath?: (input: ScmSourceControllerAdministrativePathInput) => boolean;
    classifyPortableWorkspacePath?: (input: ScmSourceControllerPortableWorkspacePathInput) => ScmSourceControllerPortableWorkspacePathClassification;
}>;

export interface ScmBackend {
    id: ScmBackendId;
    selection: ScmBackendSelection;
    sourceController?: ScmSourceController;
    detectRepo(input: { cwd: string }): Promise<ScmRepoDetection>;
    getCapabilities(input: { mode: ScmRepoMode | null }): ScmCapabilities;
    describeBackend(input: {
        context: ScmBackendContext;
        request: ScmBackendDescribeRequest;
    }): Promise<ScmBackendDescribeResponse>;
    statusSnapshot(input: {
        context: ScmBackendContext;
        request: ScmStatusSnapshotRequest;
    }): Promise<ScmStatusSnapshotResponse>;
    diffFile(input: {
        context: ScmBackendContext;
        request: ScmDiffFileRequest;
    }): Promise<ScmDiffFileResponse>;
    diffCommit(input: {
        context: ScmBackendContext;
        request: ScmDiffCommitRequest;
    }): Promise<ScmDiffCommitResponse>;
    changeInclude(input: {
        context: ScmBackendContext;
        request: ScmChangeApplyRequest;
    }): Promise<ScmChangeApplyResponse>;
    changeExclude(input: {
        context: ScmBackendContext;
        request: ScmChangeApplyRequest;
    }): Promise<ScmChangeApplyResponse>;
    changeDiscard(input: {
        context: ScmBackendContext;
        request: ScmChangeDiscardRequest;
    }): Promise<ScmChangeDiscardResponse>;
    commitCreate(input: {
        context: ScmBackendContext;
        request: ScmCommitCreateRequest;
    }): Promise<ScmCommitCreateResponse>;
    commitBackout(input: {
        context: ScmBackendContext;
        request: ScmCommitBackoutRequest;
    }): Promise<ScmCommitBackoutResponse>;
    logList(input: {
        context: ScmBackendContext;
        request: ScmLogListRequest;
    }): Promise<ScmLogListResponse>;
    branchList(input: {
        context: ScmBackendContext;
        request: ScmBranchListRequest;
    }): Promise<ScmBranchListResponse>;
    branchCreate(input: {
        context: ScmBackendContext;
        request: ScmBranchCreateRequest;
    }): Promise<ScmBranchCreateResponse>;
    branchCheckout(input: {
        context: ScmBackendContext;
        request: ScmBranchCheckoutRequest;
    }): Promise<ScmBranchCheckoutResponse>;
    worktreeCreate(input: {
        context: ScmBackendContext;
        request: ScmWorktreeCreateRequest;
    }): Promise<ScmWorktreeCreateResponse>;
    worktreeRemove(input: {
        context: ScmBackendContext;
        request: ScmWorktreeRemoveRequest;
    }): Promise<ScmWorktreeRemoveResponse>;
    worktreePrune(input: {
        context: ScmBackendContext;
        request: ScmWorktreePruneRequest;
    }): Promise<ScmWorktreePruneResponse>;
    remoteFetch(input: {
        context: ScmBackendContext;
        request: ScmRemoteRequest;
    }): Promise<ScmRemoteResponse>;
    remotePull(input: {
        context: ScmBackendContext;
        request: ScmRemoteRequest;
    }): Promise<ScmRemoteResponse>;
    remotePush(input: {
        context: ScmBackendContext;
        request: ScmRemoteRequest;
    }): Promise<ScmRemoteResponse>;
    remotePublish(input: {
        context: ScmBackendContext;
        request: ScmRemotePublishRequest;
    }): Promise<ScmRemotePublishResponse>;
    stashList(input: {
        context: ScmBackendContext;
        request: ScmStashListRequest;
    }): Promise<ScmStashListResponse>;
    stashDrop(input: {
        context: ScmBackendContext;
        request: ScmStashDropRequest;
    }): Promise<ScmStashDropResponse>;
    stashPop(input: {
        context: ScmBackendContext;
        request: ScmStashPopRequest;
    }): Promise<ScmStashPopResponse>;
    stashApply(input: {
        context: ScmBackendContext;
        request: ScmStashApplyRequest;
    }): Promise<ScmStashApplyResponse>;
    stashShow(input: {
        context: ScmBackendContext;
        request: ScmStashShowRequest;
    }): Promise<ScmStashShowResponse>;
}
