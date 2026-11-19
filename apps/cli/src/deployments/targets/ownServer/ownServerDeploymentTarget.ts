import type { DeploymentBackupRestoreInputV1, DeploymentBackupRestoreResultV1,
    DeploymentRestoreActivationReferenceV1, DeploymentTransitionInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentRestoreDestinationV1, DeploymentRestoreResultV1 } from '@happier-dev/deployments';
import type { DeploymentBackupManifestV1 as BackupManifestV1, DeploymentPreMigrationBackupV1, DeploymentBackupRestoreCaptureV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentBackupActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentBackupActionInputV1, DeploymentBackupActionResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import type { OwnServerRestorePreparationForHost } from './restorePreparation';
import type { ActionExecutorContext, DeploymentTeardownProofV1 } from '@happier-dev/protocol';
import type { DeploymentTransitionResultForHost } from '../../deploymentTransitionResult';
import type { DeploymentChildExecutionProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { DeploymentContentV1, DeploymentOwnServerContentV1, DeploymentEnvironmentContentV1, DeploymentEnvironmentDetailV1, DeploymentEnvironmentHeaderV1, DeploymentReceiptDetailV1, DeploymentReceiptHeaderV1, DeploymentSourceIntentV1, DeploymentStateV1, OwnServerDeploymentInputBasisV1, DeploymentMachineResultV1, OwnServerDeploymentImageArchiveV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/contracts/v1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { StoredCredentials } from '@/persistence';
import type { DeploymentReceiptDispatchV1 } from '@/deployments/createCliDeploymentActionDeps';
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { CurrentDomainEdgeObservation } from '@/deployments/healthChecks/currentDomainEdgeObservation';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import type { DeploymentSourceAdmissionForHost } from './exactCommitRelease';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { MachineNativeEffectContext } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { NativeComposeStartFirstRoutes } from '@/daemon/local/services/launch/nativeComposeStartFirst';
import { createOwnServerDeploymentExecutor } from './ownServerDeploymentExecutor';

export type OwnServerDeploymentRequest = Exclude<DeploymentReceiptDispatchV1, { actionId: 'deployments.teardown' }>;
/** Opened only after the stored target source admits the native host target. */
export type OwnServerDeploymentReceipt = Omit<DeploymentReceiptDetailV1, 'content'> & Readonly<{
    content: DeploymentOwnServerContentV1;
}>;
/** Opened by the canonical Action preparation owner before receipt admission. */
export type OwnServerDeploymentReviewRequest = Omit<OwnServerDeploymentRequest, 'receipt'> & Readonly<{
    content: DeploymentContentV1;
    /** This preparation's opened input; never transported to another Machine. */
    environment?: DeploymentEnvironmentDetailV1;
    candidateEnvironmentContent?: DeploymentEnvironmentContentV1;
}>;
export type OwnServerDeploymentMaterialization = Readonly<
    { kind: 'review'; contentArtifactId: string } | { kind: 'deployment'; deploymentId: string }
    | { kind: 'restoration'; deploymentId: string; sourceDeploymentId: string }
>;
export type OwnServerDeploymentRuntimeRequest = Omit<OwnServerDeploymentRequest, 'receipt' | 'actionId'> & Readonly<{
    actionId: OwnServerDeploymentRequest['actionId'] | DeploymentBackupActionIdV1;
    materialization: OwnServerDeploymentMaterialization;
    executionRole?: 'build' | 'runtime';
}>;
export type OwnServerDeploymentResult = DeploymentTransitionResultForHost;
export type OwnServerDeploymentReview = Readonly<{
    inputBasis: OwnServerDeploymentInputBasisV1;
    reviewedEffect: JsonValue;
    runtimePlatform: string;
}>;
/** Host-only child references. The receiving transport derives authority from
 * the existing parent operation and opens all content at its canonical reader. */
export type OwnServerDeploymentMemberRequest = Readonly<{
    request: OwnServerDeploymentRequest;
    /** This receiver's opened inputs; never transported to another Machine. */
    admitted?: Readonly<{ environment: DeploymentEnvironmentDetailV1; receipt: OwnServerDeploymentReceipt }>;
    machineId: string;
    installationId: string;
    phase: 'activate' | 'restore' | 'observe' | 'cleanup';
    selectedDeploymentId: string;
}>;
export type OwnServerDeploymentMemberReviewRequest = Readonly<{
    request: OwnServerDeploymentReviewRequest;
    machineId: string;
    installationId: string;
}>;
export type OwnServerDeploymentRetentionRequest = Readonly<{
    request: OwnServerDeploymentRequest; machineId: string; installationId: string;
    settledTargetLinkRevision: number; settledDeploymentRevision: number; activeDeploymentId: string;
}>;
/** The admitted rollout lends its current-U native result to the ingress owner.
 * Final receipt settlement remains the sole membership commit. */
export type OwnServerDeploymentMemberRouteEnrollmentForHost = Readonly<{
    link: DeploymentTargetLinkHeaderV1;
    signal: AbortSignal;
}>;
export type OwnServerDeploymentReadContext = Readonly<{
    environmentId: string;
    targetLinkId?: string;
    context: ActionExecutorContext;
}>;
export type OwnServerDeploymentTransition = OwnServerDeploymentReadContext & Readonly<{
    deploymentId: string;
    /** Admitted receipt identity; the server owns transition revision admission. */
    receiptHeader: DeploymentReceiptHeaderV1;
    expectedRevision: number;
    state: DeploymentStateV1;
    content: DeploymentContentV1;
    teardownProof?: DeploymentTeardownProofV1;
}> & Pick<DeploymentTransitionInputV1, 'telemetryMachineId' | 'telemetryTokenHash'>;

/** The installed daemon lends its existing ports; this is not another effect dispatcher. */
export type OwnServerDomainCaddyRequest = Readonly<{
    domain: Pick<import('@happier-dev/protocol/deployments/deploymentDomainV1').DeploymentDomainContentV1, 'hostname' | 'target'>;
    environment: DeploymentEnvironmentContentV1;
    replicas: readonly Readonly<{ containerName: string; networkNames: readonly string[] }>[];
    retainedCaddy?: Extract<import('@happier-dev/cli-common/machineSetup').NativeCaddyObservationResult, { status: 'ready' }>;
    privateNetworks: readonly import('@happier-dev/protocol/plugins/contributions/accessProviders').MachinePrivateNetworkObservationV1[];
    daemonGroup: string; daemonGroupId: number;
}>;
export type OwnServerDomainCaddyPreparation = Readonly<{
    status: 'ready'; input: import('@happier-dev/cli-common/machineSetup').NativeCaddySetupInput;
    steps: import('@happier-dev/cli-common/machineSetup').MachineRecipeStepV1[];
    ensure(options: Readonly<{
        setup: import('./ownServerDomainNative').DomainNativeSetupForHost;
        context: ActionExecutorContext; actionId: string; installationId: string; dockerEngineId: string;
        run(command: import('@happier-dev/cli-common/machineSetup').MachineSetupNativeCommand):
            Promise<import('@happier-dev/cli-common/machineSetup').MachineSetupNativeCommandResult>;
        signal: AbortSignal;
    }>):
        ReturnType<typeof import('@happier-dev/cli-common/machineSetup').ensureNativeCaddyContainer>;
}> | Readonly<{ status: 'unavailable'; reason: 'required_fact_unavailable' | 'private_scope_unenforceable';
    details?: Readonly<{ requiredFact: string }> }>;
export type OwnServerDeploymentRuntime = Readonly<{
    prepareBackupSourceChoices?(request: Readonly<{
        environment: Pick<DeploymentEnvironmentDetailV1, 'environment' | 'content'>; context: ActionExecutorContext;
    }>): Promise<readonly import('@happier-dev/deployments/contracts/v1').DeploymentBackupSourceV1[]>;
    /** Domain setup borrows the deployed generation's already observed routing facts. */
    prepareDomainCaddy?(input: OwnServerDomainCaddyRequest): OwnServerDomainCaddyPreparation;
    acquireRetention?(request: OwnServerDeploymentRetentionRequest, assertCurrent: () => Promise<void>): Promise<Readonly<{
        exec: ExecService; nativeIo: ProjectNativeToolchainIo; deploymentRoot: string;
        assertCurrent(): Promise<void>; settleNative(): Promise<void>; release(): Promise<void>;
    }>>;
    acquireTeardown?(request: Readonly<{ request: Extract<DeploymentReceiptDispatchV1, { actionId: 'deployments.teardown' }>;
        machineId: string; installationId: string }>, assertCurrent: () => Promise<void>):
        Promise<Awaited<ReturnType<NonNullable<OwnServerDeploymentRuntime['acquireRetention']>>> & Readonly<{
            retireEnvironmentObservers(scope: Readonly<{ homeServerIdentityId: string; environmentId: string }>): Promise<void>;
        }>>;
    acquireTeardownReview?(request: Readonly<{ machineId: string; installationId: string;
        request: Readonly<{ input: Readonly<{ serverId: string }>; context: ActionExecutorContext }> }>, assertCurrent: () => Promise<void>):
        ReturnType<NonNullable<OwnServerDeploymentRuntime['acquireRetention']>>;
    acquireCandidate?(request: Readonly<{ environmentId: string; targetLinkId: string;
        sourceIntent?: DeploymentSourceIntentV1;
        sha?: string;
        stageContent(sourceIntent: DeploymentSourceIntentV1): Promise<string>;
        context: ActionExecutorContext;
        readReferenceEnvironment?: OwnServerDeploymentTargetHostInput['readEnvironment'];
        readTelemetryCollectorDomain?: OwnServerDeploymentTargetHostInput['readTelemetryCollectorDomain'];
        readPreviewDomain?: OwnServerDeploymentTargetHostInput['readPreviewDomain'] }>, environment: DeploymentEnvironmentDetailV1):
        Promise<OwnServerDeploymentRuntimeAcquisition & Readonly<{ sourceIntent: DeploymentOwnServerContentV1['sourceIntent'] }>>;
    acquire(request: OwnServerDeploymentRuntimeRequest, snapshot: Readonly<{
        environment: DeploymentEnvironmentDetailV1;
        content: DeploymentOwnServerContentV1;
        /** Selected by the retained-serving source owner for a joining deployment. */
        retainedSourceIntent?: DeploymentOwnServerContentV1['sourceIntent'] | null;
        readReferenceEnvironment?: OwnServerDeploymentTargetHostInput['readEnvironment'];
        readTelemetryCollectorDomain?: OwnServerDeploymentTargetHostInput['readTelemetryCollectorDomain'];
        readPreviewDomain?: OwnServerDeploymentTargetHostInput['readPreviewDomain'];
        /** Absent only while reviewing a candidate before receipt acceptance. */
        deployment?: DeploymentReceiptHeaderV1;
    }>): Promise<OwnServerDeploymentRuntimeAcquisition>;
}>;
export type OwnServerDeploymentRuntimeAcquisition = Readonly<{
        /** Activated App services reuse ordinary terminal enrollment through native Compose custody. */
        enrollAppServices?(input: Readonly<{
            render: import('@/daemon/local/services/launch/nativeComposeLifecycle').NativeComposeProjectRender;
            project: import('@/daemon/local/services/launch/nativeComposeLifecycle').NativeComposeActivatedProject;
            services: readonly import('@/plugins/runtime/invocation/services/managedServicesOwner').EnvironmentProjectManagedServiceHandle[];
            deployment: DeploymentReceiptHeaderV1;
            nativeContext: MachineNativeEffectContext;
            signal?: AbortSignal;
        }>): Promise<void>;
        prepareReferenceContainerNetwork?: import('@/daemon/local/services/launch/nativeComposeLifecycle').NativeComposeEnvironmentProjectInput['prepareReferenceContainerNetwork'];
        retainServiceReferences?(consumers: readonly Pick<import('@/plugins/runtime/invocation/services/managedServicesOwner').ProjectManagedServiceHandle,
            'retirementSignal' | 'reportDependencyFailure'>[]): void;
        /** Invocation-owned empty cwd; build tools must not discover source .env files. */
        buildExecutionDirectory?: string;
        exec: ExecService;
        nativeIo: ProjectNativeToolchainIo;
        projectManagedServices: Pick<ReturnType<typeof createManagedServicesOwner>, 'superviseProject' | 'listProjectServices' | 'resolveEnvironmentService' | 'machineServiceRows'>;
        currentDomainEdgeObservation?: CurrentDomainEdgeObservation;
        readHealthAlertSource?: PluginRuntimeRegistryLease['registry']['readHealthAlertSource'];
        source: DeploymentSourceAdmissionForHost;
        secrets: Omit<Parameters<typeof prepareEnvironmentSecretBindingsForLaunch>[0],
            'environmentId' | 'machineId' | 'installationId' | 'phase' | 'bindings' | 'assertCurrent'>;
        /** Source backup credentials retain their original Environment/installation subjects. */
        acquireCopySourceSecrets?(input: Readonly<{ environmentId: string; targetLinkId: string;
            deploymentId: string; actionOperationId: string }>): Promise<import('./ownServerDeploymentHostRuntime').OwnServerSecretLaunchAdmission>;
        /** Reopen captured nonsecret transport without selecting the current backup configuration. */
        openBackupDestination?(configuration: import('@happier-dev/deployments/contracts/v1').DeploymentBackupConfigurationV1):
            ReturnType<typeof import('./backupDestination').openDeploymentBackupDestinationForHost>;
        /** Lazy use of this acquisition's captured destination and P42 bindings. */
        preparePreMigrationBackupOperands?(): Promise<import('./backupDestination').OwnServerPreMigrationBackupOperandsForHost>;
        prepareBackupRepositoryOperands?(): Promise<import('./backupDestination').OwnServerBackupRepositoryOperandsForHost>;
        prepareBackupRunOperands?(): Promise<import('./backupDestination').OwnServerBackupRepositoryOperandsForHost
            | import('./backupDestination').OwnServerBackupRunOperandsForHost>;
        /** Explicit Source/workspace physical custody witness with the local installed-runtime guard. */
        assertSourceCurrent(): Promise<void>;
        /** Local admitted-runtime cancellation, installation and invocation lifetime. */
        assertCurrent(): Promise<void>;
        copyDeploymentImageArchive?(input: Readonly<{ archive: OwnServerDeploymentImageArchiveV1; signal: AbortSignal;
            assertCurrent(): Promise<void> }>): Promise<Readonly<{ path: string; sizeBytes: number; sha256: string }>>;
        /** Physical finite native processes only; never receipt ACK or serving containers. */
        settleNative(): Promise<void>;
        release(): Promise<void>;
}>;

export type OwnServerDeploymentTargetHostInput = Readonly<{
    credentials: StoredCredentials;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    readEnvironment(request: OwnServerDeploymentReadContext): Promise<DeploymentEnvironmentDetailV1>;
    readTelemetryCollectorPlacement?(machineId: string, context: ActionExecutorContext):
        Promise<import('./domainRouteSelection').TelemetryCollectorPlacement>;
    readTelemetryCollectorDomain?(request: OwnServerDeploymentReadContext & Readonly<{
        targetLinkId: string; collectorMachineId: string; deployment: DeploymentReceiptHeaderV1;
    }>): Promise<import('./domainRouteSelection').TelemetryCollectorDomainEndpoint>;
    readPreviewDomain?(request: Parameters<typeof import('../../previewDomainForHost').readPreviewDomainForHost>[0]
        & Readonly<{ context: ActionExecutorContext }>): ReturnType<typeof import('../../previewDomainForHost').readPreviewDomainForHost>;
    readExpectedDownDomains?(request: OwnServerDeploymentReadContext & Readonly<{ targetLinkId: string; affectedServices: readonly string[] }>):
        Promise<readonly import('@happier-dev/protocol/machines/machineDeploymentDomainReferenceV1').MachineDeploymentDomainReferenceV1[] | null>;
    readEnvironmentMetadata?(request: OwnServerDeploymentReadContext): Promise<DeploymentEnvironmentHeaderV1>;
    readRetentionHeaders?(request: OwnServerDeploymentReadContext & Readonly<{ deploymentId: string; targetLinkId: string }>): Promise<Readonly<{
        environment: DeploymentEnvironmentHeaderV1; deployment: DeploymentReceiptHeaderV1; link: DeploymentTargetLinkHeaderV1;
    }>>;
    readReceipt(request: OwnServerDeploymentReadContext & Readonly<{ deploymentId: string;
        nativeIncumbentSource?: DeploymentChildExecutionProofV1['nativeIncumbentSource'] }>): Promise<OwnServerDeploymentReceipt>;
    readBuildHistory?(request: OwnServerDeploymentReadContext & Readonly<{
        targetLinkId?: string; environment?: DeploymentEnvironmentDetailV1;
    }>): AsyncIterable<OwnServerDeploymentReceipt>;
    writeTransition(request: OwnServerDeploymentTransition): Promise<OwnServerDeploymentResult>;
    dispatchMember?(request: OwnServerDeploymentMemberRequest): Promise<OwnServerDeploymentResult>;
    enrollMemberRoutes?(request: OwnServerDeploymentRequest,
        input: OwnServerDeploymentMemberRouteEnrollmentForHost): Promise<OwnServerDeploymentResult>;
    dispatchRetention?(request: OwnServerDeploymentRetentionRequest): Promise<OwnServerDeploymentResult>;
    dispatchBuild?(request: OwnServerDeploymentRequest, receiptHeader: DeploymentReceiptHeaderV1): Promise<OwnServerDeploymentResult>;
    reviewMember?(request: OwnServerDeploymentMemberReviewRequest): Promise<OwnServerDeploymentReview>;
    readMemberVersions?(request: OwnServerDeploymentReadContext & Readonly<{ targetLinkId: string }>): Promise<readonly DeploymentMachineResultV1[]>;
    readStartFirstRoutes?(request: OwnServerDeploymentRequest, input: Readonly<{
        docker: ProjectNativeDockerPort; installationId: string; affectedServices: readonly string[];
        context: MachineNativeEffectContext; signal: AbortSignal;
    }>): Promise<NativeComposeStartFirstRoutes>;
    settlePrivateWorkloadFirewall?(request: OwnServerDeploymentRequest, input: Readonly<{
        environment: DeploymentEnvironmentDetailV1;
        render: import('@/daemon/local/services/launch/nativeComposeLifecycle').NativeComposeProjectRender;
        docker: ProjectNativeDockerPort; installationId: string;
        context: MachineNativeEffectContext; signal: AbortSignal;
    }>): Promise<void>;
    runtime: OwnServerDeploymentRuntime;
    signal?: AbortSignal;
}>;
export type OwnServerRestoreRequestForHost = Readonly<{
    input: DeploymentBackupRestoreInputV1;
    context: ActionExecutorContext;
    /** Decoded once from the scoped, succeeded prepare Action operation. */
    prepared?: OwnServerRestorePreparationForHost;
    /** Exact preserved volume identities from the scoped failed restore operation. */
    recovery?: Parameters<typeof import('@happier-dev/deployments').recoverDeploymentRestoreV1>[0]['recovery'];
    /** Selected once from the exact scoped, successful backup Action operation. */
    backup?: Readonly<{ manifest: BackupManifestV1;
        capture?: import('@happier-dev/deployments/contracts/v1').DeploymentBackupRestoreCaptureV1 }>;
    upload?: import('@/transfers/targets/deploymentRestoreUpload').AdmittedDeploymentRestoreUpload;
    /** Prepare lends the admitted native tuple; selector bytes never enter public evidence. */
    reviewNativeSnapshot?(input: Readonly<{
        destination: DeploymentRestoreDestinationV1;
        selection: Readonly<{ prefix: readonly string[]; env: Readonly<Record<string, string>> }>;
    }>): Promise<void>;
}>;
export type OwnServerRestoreResultForHost = (Readonly<{ kind: 'prepared' }> & OwnServerRestorePreparationForHost)
    | (DeploymentRestoreResultV1 & Readonly<{ activation?: DeploymentRestoreActivationReferenceV1 }>)
    | Extract<DeploymentBackupRestoreResultV1, { kind: 'superseded' | 'recoveryRequired' }>;

type OwnServerNativeBackupActionId = Exclude<DeploymentBackupActionIdV1, 'deployments.backups.history'>;
export type OwnServerBackupRequestForHost = {
    [TId in OwnServerNativeBackupActionId]: Readonly<{
        actionId: TId; input: DeploymentBackupActionInputV1<TId>; context: ActionExecutorContext;
    }> & (TId extends 'deployments.backups.inventory' ? Readonly<{
        verificationEvidence?: readonly Readonly<{ backupOperationId: string; manifest: BackupManifestV1 }>[];
    }> : TId extends 'deployments.backups.verify' ? Readonly<{
        manifest: BackupManifestV1; capture?: DeploymentBackupRestoreCaptureV1;
    }>
        : TId extends 'deployments.backups.prune' ? Readonly<{
            verification: Readonly<{ kind: 'verified'; level: 'manifestReadBack' | 'repositoryCheck'; manifest: BackupManifestV1 }>;
            protectedSnapshotIds: readonly string[];
        }> : Readonly<Record<never, never>>)
}[OwnServerNativeBackupActionId];

export type OwnServerDeploymentTargetForHost = Readonly<{
    backup(request: OwnServerBackupRequestForHost): Promise<DeploymentBackupActionResultV1>;
    restore(request: OwnServerRestoreRequestForHost): Promise<OwnServerRestoreResultForHost>;
    review(request: OwnServerDeploymentReviewRequest): Promise<OwnServerDeploymentReview>;
    execute(request: OwnServerDeploymentRequest): Promise<OwnServerDeploymentResult>;
    reviewMember(request: OwnServerDeploymentMemberReviewRequest): Promise<OwnServerDeploymentReview>;
    executeMember(request: OwnServerDeploymentMemberRequest): Promise<OwnServerDeploymentResult>;
    retain(request: OwnServerDeploymentRetentionRequest): Promise<OwnServerDeploymentResult>;
}>;

/** The existing Action front door awaits this one target executor through settlement. */
export function createOwnServerDeploymentTargetForHost(input: OwnServerDeploymentTargetHostInput): OwnServerDeploymentTargetForHost {
    return createOwnServerDeploymentExecutor(input);
}
