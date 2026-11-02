import type { ActionExecutorContext, DeploymentTeardownProofV1 } from '@happier-dev/protocol';
import type { DeploymentTransitionResultForHost } from '../../deploymentTransitionResult';
import type { DeploymentChildExecutionProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { DeploymentContentV1, DeploymentOwnServerContentV1, DeploymentEnvironmentContentV1, DeploymentEnvironmentDetailV1, DeploymentEnvironmentHeaderV1, DeploymentReceiptDetailV1, DeploymentReceiptHeaderV1, DeploymentSourceIntentV1, DeploymentStateV1, OwnServerDeploymentInputBasisV1, DeploymentMachineResultV1, OwnServerDeploymentImageArchiveV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { StoredCredentials } from '@/persistence';
import type { DeploymentReceiptDispatchV1 } from '@/deployments/createCliDeploymentActionDeps';
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { CurrentDomainEdgeObservation } from '@/deployments/healthChecks/currentDomainEdgeObservation';
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
export type OwnServerDeploymentRuntimeRequest = Omit<OwnServerDeploymentRequest, 'receipt'> & Readonly<{
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
export type OwnServerDeploymentReadContext = Readonly<{
    environmentId: string;
    context: ActionExecutorContext;
}>;
export type OwnServerDeploymentTransition = OwnServerDeploymentReadContext & Readonly<{
    deploymentId: string;
    /** Admitted receipt identity; the server owns transition revision admission. */
    receiptHeader: DeploymentReceiptHeaderV1;
    expectedRevision: number;
    state: DeploymentStateV1;
    content: DeploymentOwnServerContentV1;
    teardownProof?: DeploymentTeardownProofV1;
}>;

/** The installed daemon lends its existing ports; this is not another effect dispatcher. */
export type OwnServerDomainCaddyRequest = Readonly<{
    domain: Pick<import('@happier-dev/deployment-protocol').DeploymentDomainContentV1, 'hostname' | 'target'>;
    environment: DeploymentEnvironmentContentV1;
    replicas: readonly Readonly<{ containerName: string; networkNames: readonly string[] }>[];
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
}> | Readonly<{ status: 'unavailable'; reason: 'required_fact_unavailable' | 'private_scope_unenforceable' }>;
export type OwnServerDeploymentRuntime = Readonly<{
    /** Domain setup borrows the deployed generation's already observed routing facts. */
    prepareDomainCaddy?(input: OwnServerDomainCaddyRequest): OwnServerDomainCaddyPreparation;
    acquireRetention?(request: OwnServerDeploymentRetentionRequest, assertCurrent: () => Promise<void>): Promise<Readonly<{
        exec: ExecService; nativeIo: ProjectNativeToolchainIo; deploymentRoot: string;
        assertCurrent(): Promise<void>; settleNative(): Promise<void>; release(): Promise<void>;
    }>>;
    acquireCandidate?(request: Readonly<{ environmentId: string; targetLinkId: string;
        sourceIntent?: DeploymentSourceIntentV1;
        sha?: string;
        stageContent(sourceIntent: DeploymentSourceIntentV1): Promise<string>;
        context: ActionExecutorContext;
        readReferenceEnvironment?: OwnServerDeploymentTargetHostInput['readEnvironment'] }>, environment: DeploymentEnvironmentDetailV1):
        Promise<OwnServerDeploymentRuntimeAcquisition & Readonly<{ sourceIntent: DeploymentSourceIntentV1 }>>;
    acquire(request: OwnServerDeploymentRuntimeRequest, snapshot: Readonly<{
        environment: DeploymentEnvironmentDetailV1;
        content: DeploymentOwnServerContentV1;
        readReferenceEnvironment?: OwnServerDeploymentTargetHostInput['readEnvironment'];
        /** Absent only while reviewing a candidate before receipt acceptance. */
        deployment?: DeploymentReceiptHeaderV1;
    }>): Promise<OwnServerDeploymentRuntimeAcquisition>;
}>;
export type OwnServerDeploymentRuntimeAcquisition = Readonly<{
        /** Invocation-owned empty cwd; build tools must not discover source .env files. */
        buildExecutionDirectory?: string;
        exec: ExecService;
        nativeIo: ProjectNativeToolchainIo;
        projectManagedServices: Pick<ReturnType<typeof createManagedServicesOwner>, 'superviseProject' | 'listProjectServices' | 'resolveEnvironmentService' | 'machineServiceRows'>;
        currentDomainEdgeObservation?: CurrentDomainEdgeObservation;
        source: DeploymentSourceAdmissionForHost;
        secrets: Omit<Parameters<typeof prepareEnvironmentSecretBindingsForLaunch>[0],
            'environmentId' | 'machineId' | 'installationId' | 'phase' | 'bindings' | 'assertCurrent'>;
        /** Lazy use of this acquisition's captured destination and P42 bindings. */
        preparePreMigrationBackupOperands?(): Promise<import('./backupDestination').OwnServerPreMigrationBackupOperandsForHost>;
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
    readEnvironmentMetadata?(request: OwnServerDeploymentReadContext): Promise<DeploymentEnvironmentHeaderV1>;
    readRetentionHeaders?(request: OwnServerDeploymentReadContext & Readonly<{ deploymentId: string; targetLinkId: string }>): Promise<Readonly<{
        environment: DeploymentEnvironmentHeaderV1; deployment: DeploymentReceiptHeaderV1; link: DeploymentTargetLinkHeaderV1;
    }>>;
    readReceipt(request: OwnServerDeploymentReadContext & Readonly<{ deploymentId: string;
        nativeIncumbentSource?: DeploymentChildExecutionProofV1['nativeIncumbentSource'] }>): Promise<OwnServerDeploymentReceipt>;
    readBuildHistory?(request: OwnServerDeploymentReadContext & Readonly<{
        targetLinkId: string; environment?: DeploymentEnvironmentDetailV1;
    }>): AsyncIterable<OwnServerDeploymentReceipt>;
    writeTransition(request: OwnServerDeploymentTransition): Promise<OwnServerDeploymentResult>;
    dispatchMember?(request: OwnServerDeploymentMemberRequest): Promise<OwnServerDeploymentResult>;
    dispatchRetention?(request: OwnServerDeploymentRetentionRequest): Promise<OwnServerDeploymentResult>;
    dispatchBuild?(request: OwnServerDeploymentRequest, receiptHeader: DeploymentReceiptHeaderV1): Promise<OwnServerDeploymentResult>;
    reviewMember?(request: OwnServerDeploymentMemberReviewRequest): Promise<OwnServerDeploymentReview>;
    readMemberVersions?(request: OwnServerDeploymentReadContext & Readonly<{ targetLinkId: string }>): Promise<readonly DeploymentMachineResultV1[]>;
    readStartFirstRoutes?(request: OwnServerDeploymentRequest, input: Readonly<{
        docker: ProjectNativeDockerPort; installationId: string; affectedServices: readonly string[];
        context: MachineNativeEffectContext; signal: AbortSignal;
    }>): Promise<NativeComposeStartFirstRoutes>;
    runtime: OwnServerDeploymentRuntime;
    signal?: AbortSignal;
}>;
export type OwnServerDeploymentTargetForHost = Readonly<{
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
