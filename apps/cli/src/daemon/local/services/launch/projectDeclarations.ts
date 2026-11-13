import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { projectNativeJsonValueForTransport, sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { DaemonLocalServiceLauncherStartRequestV1, RuntimeActionExecuteArgs } from '@happier-dev/protocol';
import type { ProjectCommandSourceV1, ProjectExecutionInputV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readProjectFiniteIngressRefusal, readProjectRuntimeAdmissionRefusal, type ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { resolveProjectRequesterSecretInputs } from '@/workspaces/projectSetup/projectSetupRequesterInputs';
import { readProjectManifest } from '@/workspaces/projectSetup/projectManifestFile';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { resolveProjectSetupAcceptedWorkspace } from '@/workspaces/projectSetup/projectSetupAcceptedWorkspace';
import { prepareProjectSetup, type PreparedProjectSetupCommand, type PreparedProjectSetupPlan, type ProjectSetupPreparationInput } from '@/workspaces/projectSetup/projectSetupPreparation';
import { authorizePreparedProjectCommand, createProjectNativeInvocationCustody, executeProjectSetup, projectBaseEnvironment, publishProjectFiniteAdmission, type ProjectSetupExecutionInput, type ProjectSetupExecutionOutcome, type ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { readProjectExecutionInputs, resolveProjectNativeCommand } from '@/workspaces/projectSetup/projectNativeResolution';
import { readProjectDefinitionFileBytes } from '@/workspaces/projectSetup/nativeDefinitionFiles';
import { resolveProjectServiceStartChoice } from '@/workspaces/execution/projectServicePlacement';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import { buildProjectManagedServiceStartRequest, type ProjectManagedServiceSupervisionInput, type ProjectManagedServiceHandle, type EnvironmentProjectManagedServiceHandle, type createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk';
import type { DeploymentServiceExportV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { Disposable } from '@happier-dev/plugin-sdk';
import type { ManagedServiceNativeLogReadV1, ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import type { ManagedServiceNativeInstanceV1, ManagedServiceNativeLogWatchV1 } from '@happier-dev/plugin-sdk/managed-services';
import type { HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import type { MachineNativeEffectKey } from './machineNativeEffectAdmission';
import { discoverLocalServiceRunTargets } from './runTargets';
import type { LocalServiceLauncherStartExecutionOutcome, LocalServiceLauncherStartResolution } from './start';
import { DaemonLocalServiceLauncherStartResponseV1Schema, LocalServiceNativePrerequisiteV1Schema, LocalServiceEstablishmentFailureV1Schema,
    LocalServiceStartApprovalReviewV1Schema, type LocalServiceStartApprovalReviewV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { PROJECT_SERVICE_RESTART_START_ROLE, stopProjectManagedService, type PrepareRestartProjectManagedService, type RestartProjectManagedService } from '../actions/executor';
import { createProjectServiceDeclarationTargetIdV1, LocalServiceManagedServiceActionTargetV1Schema, type ProjectServiceDeclarationRefV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { WorkspaceSyncWorkerTargetBasis } from '@/workspaces/sync/workspaceSyncPreparation';
import type { ProjectServiceStartChoice } from '@/workspaces/execution/projectServicePlacement';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { assertProjectReceivingPlacement } from '@/workspaces/execution/projectReceivingPlacement';
import { isProjectNativeProcessUncertain, preserveUnconfirmedNativeProcess, type ProjectNativeAdapterLeaseV1, type ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { ProjectNativeToolchainUncertainError } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import type { ProjectNativeEffectCaptureForHost } from '@/plugins/runtime/invocation/services/exec';
import { assertNativeComposeAvailable, createNativeComposeLifecycle, NativeComposePrerequisiteError, type NativeComposeObservationIo, type NativeComposeActivatedProject } from './nativeComposeLifecycle';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { logger } from '@/ui/logger';

type ActionContext = RuntimeActionExecuteArgs['context'];
type CanonicalPoolRead = RuntimeActionExecuteArgs['executeCanonicalAction'];
type AdmittedReview = Readonly<{
    runtime: ProjectFiniteActionRuntime;
    request: DaemonLocalServiceLauncherStartRequestV1 & Required<Pick<DaemonLocalServiceLauncherStartRequestV1, 'workspace' | 'declaration'>>;
    ingress: RpcHandlerContext & Required<Pick<RpcHandlerContext, 'machineAdmission' | 'verifyMachineAdmissionCurrent'>>;
    context: NonNullable<ActionContext>;
}>;
type SupportedServiceCommand = Exclude<PreparedProjectSetupCommand, { kind: 'pluginNativeReference' }>;
type SelectedDeclaration = Readonly<{
    targetId: string;
    reviewedEffectDigest: string;
    workspace: NonNullable<DaemonLocalServiceLauncherStartRequestV1['workspace']>;
    declaration: ProjectServiceDeclarationRefV1;
    runtime: ProjectFiniteActionRuntime;
    source?: SourceReview;
}>;
type PluginRuntimeLease = Readonly<{
    registry: Readonly<{ projectManagedServices: Pick<ReturnType<typeof createManagedServicesOwner>, 'superviseProject'> }>;
    release(): Promise<void>;
}>;
export type ProjectServiceDeclarationStarterInput = Readonly<{
    /** The already mounted finite owner supplies its actual PTY and operation ports. */
    resolveRuntime(ingress: RpcHandlerContext): Promise<ProjectFiniteActionRuntime | null>;
    acquirePluginRuntime(): Promise<PluginRuntimeLease>;
}>;

/** One already-activated project produces N observations, never N native starts. */
export async function produceEnvironmentProjectServices(input: Readonly<{
    owner: Pick<ReturnType<typeof createManagedServicesOwner>, 'superviseProject'>;
    serverId: string;
    release: DeploymentSourceMaterializationV1;
    appliedServiceExports?: readonly DeploymentServiceExportV1[];
    specIdentity: string;
    signal?: AbortSignal;
    isCurrent(): boolean;
    nativeEffects: Readonly<{ keys: readonly MachineNativeEffectKey[]; settleNative?: () => Promise<void> }>;
    io: NativeComposeObservationIo;
    project: Pick<NativeComposeActivatedProject, 'composeArgs' | 'services' | 'nativeIdsForService' | 'authorizeServiceObserver'> & Readonly<{
        /** Cold observation cannot reconstruct the secret-bearing activation render. */
        nativeFactsForService(composeService: string): ReturnType<NativeComposeActivatedProject['nativeFactsForService']> | undefined;
    }>;
}>): Promise<readonly EnvironmentProjectManagedServiceHandle[]> {
    const handles: EnvironmentProjectManagedServiceHandle[] = [];
    const nativeProject = input.nativeEffects.keys.find(key => key.kind === 'composeProject');
    for (const composeService of input.project.services) {
        input.signal?.throwIfAborted();
        await input.release.assertCurrent();
        const native = createNativeComposeLifecycle({ args: input.project.composeArgs, io: input.io,
            retainLaunch: () => input.project.authorizeServiceObserver(),
            engineId: nativeProject?.dockerEndpoint,
            environment: { composeService, containerIds: input.project.nativeIdsForService(composeService), facts: input.project.nativeFactsForService(composeService) } });
        const launch = input.project.authorizeServiceObserver();
        let released: Promise<void> | undefined;
        const releaseObservation = () => released ??= Promise.resolve().then(() => launch.release());
        let transferred = false;
        try {
            native.bindLaunch(launch);
            const handle = await input.owner.superviseProject({ kind: 'environment', serverId: input.serverId,
                machineId: input.release.machineId, environmentId: input.release.environmentId,
                environmentInstanceId: input.release.environmentInstanceId, deploymentId: input.release.deploymentId,
                release: input.release, composeService, serviceId: `${input.release.environmentInstanceId}/${composeService}`,
                appliedServiceExports: input.appliedServiceExports,
                specIdentity: input.specIdentity, signal: input.signal, isCurrent: input.isCurrent,
                nativeEffects: input.nativeEffects, releaseObservation,
                processSpec: { mode: { kind: 'native', builtinLifecycle: native.lifecycle } },
            });
            if (handle.kind !== 'environment') throw new Error('environment_service_witness_mismatch');
            transferred = true;
            handles.push(handle);
        } finally { if (!transferred) await releaseObservation(); }
    }
    return handles;
}

type Review = Readonly<{
    kind: 'target';
    source?: SourceReview;
    runtime: ProjectFiniteActionRuntime;
    preparation: ProjectSetupPreparationInput;
    plan: PreparedProjectSetupPlan;
    setupNotRequired: boolean;
    setupReview?: Readonly<{ code: 'project_setup_consent_required' | 'project_setup_effect_changed'; reviewedEffect: JsonValue; reviewedEffectDigest: string }>;
    declaration: ProjectServiceDeclarationRefV1;
    serviceId: string;
    execution: 'primary' | 'portable';
    command: SupportedServiceCommand;
    processMode: ProjectManagedServiceSupervisionInput['processSpec']['mode'];
    nativeLifecycleLease?: ProjectNativeAdapterLeaseV1;
    builtinNative?: ReturnType<typeof createNativeComposeLifecycle>;
    releaseNativeLifecycle?: () => Promise<void>;
    reviewedEffect: JsonValue;
    reviewedEffectDigest: string;
}>;
type SourceReview = Readonly<{
    kind: 'source';
    runtime: ProjectFiniteActionRuntime;
    basis: WorkspaceSyncWorkerTargetBasis;
    snapshot: Awaited<ReturnType<NonNullable<ProjectFiniteActionRuntime['inspectSourceProjectManifest']>>>;
    manifest: ProjectManifestV1;
    choice: Extract<ProjectServiceStartChoice, { status: 'resolved' }>['choice'];
    placementEffectDigest: string;
    /** Literal host commands can be reviewed before transfer; native effects use target facts after clean preparation. */
    serviceEffectDigest?: string;
    executionInputs: readonly ProjectExecutionInputV1[];
    signal: AbortSignal;
    reviewedEffect: JsonValue;
    reviewedEffectDigest: string;
}>;
class ServiceStartRefusal extends Error {
    constructor(readonly code: string, readonly review?: Readonly<{ reviewedEffect: JsonValue; reviewedEffectDigest: string }>) { super(code); }
}
const digest = (value: unknown) => createHash('sha256').update(createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(value))).digest('hex');
const codeOf = (error: unknown) => error instanceof ServiceStartRefusal ? error.code
    : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_service_start_unavailable';
const refusal = (error: unknown): Extract<LocalServiceLauncherStartResolution<SelectedDeclaration>, { ok: false }> => {
    const details = isPluginError(error) && error.details && typeof error.details === 'object'
        && !Array.isArray(error.details) ? error.details : undefined;
    const prerequisite = LocalServiceNativePrerequisiteV1Schema.safeParse(isPluginError(error) && error.code === 'native_tool_unavailable'
        && details && 'prerequisite' in details ? details.prerequisite : undefined);
    const failure = LocalServiceEstablishmentFailureV1Schema.safeParse(isPluginError(error)
        && error.code === 'plugin_managed_service_establishment_failed'
        && details && 'establishmentFailure' in details ? details.establishmentFailure : undefined);
    return { ok: false, reasonCode: codeOf(error), ...(error instanceof ServiceStartRefusal && error.review ? error.review : {}),
        ...(failure.success ? { establishmentFailure: failure.data } : {}),
        ...(prerequisite.success ? { prerequisite: prerequisite.data } : {}) };
};
function literalServiceCommand(source: Extract<ProjectCommandSourceV1, { kind: 'command' }>, root: string, os: string): Extract<SupportedServiceCommand, { kind: 'literal' }> {
    if (source.platforms && !source.platforms.some(platform => platform === os)) throw new ServiceStartRefusal('project_service_platform_unsupported');
    if (source.command.includes('\0')) throw new ServiceStartRefusal('project_command_invalid');
    const cwd = validatePath((source.cwd ?? '.').replaceAll('\\', '/'), root);
    if (!cwd.valid || !cwd.resolvedPath) throw new ServiceStartRefusal('outside_root');
    return { kind: 'literal', source, cwd: cwd.resolvedPath };
}

/** Effect dependency of the canonical, approved launcher Action; not an alternate dispatcher. */
export function createProjectServiceDeclarationStarter(input: ProjectServiceDeclarationStarterInput) {
    const platformFor = (runtime: ProjectFiniteActionRuntime) => ({ os: (runtime.platform ?? process.platform) === 'win32' ? 'windows' : runtime.platform ?? process.platform, arch: runtime.arch ?? process.arch });
    async function readPlacement(runtime: ProjectFiniteActionRuntime, request: DaemonLocalServiceLauncherStartRequestV1,
        ingress: RpcHandlerContext, context: ActionContext, workspaceRefId: string,
        assertNotCancelled: () => void,
        phase: <T>(name: string, read: () => T | Promise<T>) => Promise<T>) {
        const config = await phase('placement_context', () => runtime.resolveWorkspaceExecutionConfig(context, ingress, 'localServices.launcher.start'));
        assertNotCancelled();
        if (!config?.getService || !request.declaration) throw new ServiceStartRefusal('project_service_placement_unavailable');
        const selection = request.declaration.selection;
        const placement = await phase('placement_read', () => config.getService!({ workspace: { serverId: runtime.serverId, refId: workspaceRefId },
            serviceName: selection.kind === 'manifest' ? selection.name : request.targetId }));
        assertNotCancelled();
        if (placement.status !== 'ready') throw new ServiceStartRefusal(`project_service_placement_${placement.status}`);
        return placement;
    }
    function readChoice(placement: Awaited<ReturnType<typeof readPlacement>>, request: DaemonLocalServiceLauncherStartRequestV1,
        service: NonNullable<ProjectManifestV1['services']>[string] | undefined) {
        const resolved = resolveProjectServiceStartChoice({ execution: service?.execution ?? 'primary', placement, invocation: request.choice });
        if (resolved.status === 'refused') throw new ServiceStartRefusal(resolved.reason);
        return { placement, choice: resolved.choice };
    }
    async function admitRequest(request: DaemonLocalServiceLauncherStartRequestV1, ingress?: RpcHandlerContext, context?: ActionContext): Promise<AdmittedReview> {
        if (!ingress?.machineAdmission || !ingress.verifyMachineAdmissionCurrent) throw new ServiceStartRefusal('machine_admission_required');
        if (!context) throw new ServiceStartRefusal('project_service_action_context_unavailable');
        if (!request.workspace || !request.declaration) throw new ServiceStartRefusal('launcher_start_declaration_unavailable');
        const constrained = readProjectFiniteIngressRefusal(ingress);
        if (constrained) throw new ServiceStartRefusal(constrained.errorCode);
        const runtime = await input.resolveRuntime(ingress);
        if (!runtime) throw new ServiceStartRefusal('project_service_runtime_unavailable');
        const admission = ingress.machineAdmission;
        if (admission.machineId !== runtime.machineId || request.machineId !== runtime.machineId
            || !await isServerProfileHomeIdentity(runtime.serverId, request.workspace.serverId)
            || context.serverId && context.serverId !== runtime.serverId
                && context.serverId !== request.workspace.serverId) throw new ServiceStartRefusal('target_mismatch');
        const signal = context.signal ? AbortSignal.any([ingress.signal, context.signal]) : ingress.signal;
        if (!runtime.isCurrent) throw new ServiceStartRefusal('project_requester_credentials_unavailable');
        const refusal = await readProjectRuntimeAdmissionRefusal(runtime, { ...ingress, signal });
        if (refusal) throw new ServiceStartRefusal(refusal.errorCode);
        return { runtime, request: { ...request, workspace: request.workspace, declaration: request.declaration },
            ingress: { ...ingress, machineAdmission: admission, verifyMachineAdmissionCurrent: ingress.verifyMachineAdmissionCurrent }, context };
    }
    async function review(nativeInvocations: Set<ProjectNativeEffectCaptureForHost>, { runtime: authorityRuntime, request, ingress, context }: AdmittedReview,
        afterCopy = false, executeCanonicalAction?: CanonicalPoolRead,
        nativeCustody?: Pick<ReturnType<typeof createProjectNativeInvocationCustody>, 'retain'>,
        approvalPreparation = false, copiedSource?: SourceReview): Promise<Review | SourceReview> {
        const phase = async <T>(name: string, read: () => T | Promise<T>): Promise<T> => {
            const startedAt = performance.now();
            let status: 'completed' | 'failed' = 'failed';
            try { const result = await read(); status = 'completed'; return result; }
            finally { logger.debug('[ProjectService] launch phase', { phase: name, status,
                requestId: context?.actionRequestId, machineId: request.machineId, targetId: request.targetId,
                afterCopy, approvalPreparation, durationMs: Math.round(performance.now() - startedAt) }); }
        };
        const approval = context.nativeServiceStartApproval;
        if (approval && !sameStrictJsonValue(approval.request, request)) throw new ServiceStartRefusal('project_service_effect_changed');
        const runtime = { ...authorityRuntime, serverId: request.workspace.serverId };
        const admission = ingress.machineAdmission;
        const signal = context.signal ? AbortSignal.any([ingress.signal, context.signal]) : ingress.signal;
        const assertNotCancelled = () => {
            if (signal.aborted) throw new ServiceStartRefusal('cancelled');
        };
        // Admission belongs to the request. Effect reviews retain local cancellation;
        // each Home call and the native resource owner enforce their own boundary.
        assertNotCancelled();
        let association = await phase('source_workspace', () => resolveProjectSetupAcceptedWorkspace({ address: request.workspace!, ...projectRuntimeAccountRowsInput(runtime),
            serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal }));
        assertNotCancelled();
        if (request.declaration.workspaceRefId !== association.workspace.id || request.workspaceId && request.workspaceId !== association.workspace.id) throw new ServiceStartRefusal('wrong_workspace');
        const sourceAssociation = association;
        const assertPlacement = async (choice: Extract<ProjectServiceStartChoice, { status: 'resolved' }>['choice']) => {
            await assertProjectReceivingPlacement({ choice, sourceMachineId: sourceAssociation.workspace.machineId,
                receivingMachineId: runtime.machineId, ...(executeCanonicalAction ? { readPool: async poolId => {
                    assertNotCancelled();
                    const result = await executeCanonicalAction('machines.pools.get', { poolId });
                    assertNotCancelled();
                    return result;
                } } : {}) });
        };
        let worker: SourceReview | undefined;
        if (association.workspace.machineId !== runtime.machineId) {
            if (!runtime.inspectSourceProjectManifest) throw new ServiceStartRefusal('project_source_declaration_unavailable');
            // These are independent passive reads. Placement stays current;
            // portability comes from SOURCE, never destination-authored policy.
            const [snapshot, sourcePlacement] = await Promise.all([
                // Retain this request's one SOURCE review. TARGET bytes after
                // copy must match that basis; a later SOURCE read cannot prove
                // the bytes that the destination will actually execute.
                copiedSource ? copiedSource.snapshot
                    : phase('source_manifest', () => runtime.inspectSourceProjectManifest!({ source: sourceAssociation.workspace, signal,
                        ...(request.declaration!.selection.kind === 'manifest'
                            ? { command: { usage: 'service', name: request.declaration!.selection.name } } : {}) })),
                phase('source_placement', () => readPlacement(runtime, request, ingress, context, sourceAssociation.workspace.id, assertNotCancelled, phase)),
            ]);
            assertNotCancelled();
            if (snapshot.document?.status === 'invalid') throw new ServiceStartRefusal('invalid_manifest');
            const manifest = snapshot.document?.manifest;
            const selection = request.declaration.selection;
            const service = selection.kind === 'manifest' ? manifest?.services?.[selection.name] : undefined;
            if (selection.kind === 'manifest' && !service) throw new ServiceStartRefusal('project_service_not_found');
            const { placement, choice } = readChoice(sourcePlacement, request, service);
            await phase('source_receiving_placement', () => assertPlacement(choice));
            if (request.targetId !== createProjectServiceDeclarationTargetIdV1(association.workspace, selection)) throw new ServiceStartRefusal('launcher_target_unknown');
            if (!manifest || !service) throw new ServiceStartRefusal('project_service_not_found');
            const eligibility = await phase('source_memory_eligibility', () => runtime.workerAdmission.observeServiceEligibility(manifest?.workspace?.memoryDemand, { includeLoad: false }));
            if (!eligibility.eligible) throw new ServiceStartRefusal(eligibility.reason ?? 'project_service_admission_unavailable');
            assertNotCancelled();
            if (!runtime.resolveWorkerTarget || !runtime.prepareDequeue) throw new ServiceStartRefusal('workspace_sync_source_unavailable');
            const basis = await phase('worker_target', () => runtime.resolveWorkerTarget!({ source: association.workspace, signal }));
            assertNotCancelled();
            if (basis.target.machineId !== runtime.machineId || digest(workspaceAddressFromRefV1(basis.source)) !== digest(workspaceAddressFromRefV1(association.workspace))
                || basis.source.projectKey !== association.workspace.projectKey
                || basis.target.projectKey !== association.workspace.projectKey) throw new ServiceStartRefusal('project_workspace_changed');
            const literalHost = service.source.kind === 'command' && (!manifest.toolchain || manifest.toolchain.kind === 'host');
            const executionFiles = new Map<string, string>();
            if (service.source.kind !== 'command') {
                const command = snapshot.commands?.find(entry => entry.usage === 'service'
                    && selection.kind === 'manifest' && entry.name === selection.name && digest(entry.source) === digest(service.source));
                if (!command?.executionInputs?.length) throw new ServiceStartRefusal('project_source_declaration_unavailable');
                for (const fact of command.executionInputs) executionFiles.set(fact.file, fact.hash);
            }
            if (manifest.toolchain && manifest.toolchain.kind !== 'host') {
                if (!snapshot.toolchainExecutionInputs?.length) throw new ServiceStartRefusal('project_source_declaration_unavailable');
                for (const fact of snapshot.toolchainExecutionInputs) executionFiles.set(fact.file, fact.hash);
            }
            const executionInputs = [...executionFiles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, hash]) => ({ file, hash }));
            const serviceEffect = literalHost && service.source.kind === 'command'
                ? { command: literalServiceCommand(service.source, basis.target.rootPath, platformFor(runtime).os),
                    toolchain: { kind: 'host' }, configEnvironment: runtime.configEnvironment ?? {}, platform: platformFor(runtime) }
                : undefined;
            const reviewedEffect = projectNativeJsonValueForTransport({ v: 1, purpose: 'service', declaration: request.declaration,
                source: { ...workspaceAddressFromRefV1(association.workspace), projectKey: association.workspace.projectKey },
                target: { ...workspaceAddressFromRefV1(basis.target), projectKey: basis.target.projectKey }, manifest, fileBasis: snapshot.basis, serviceEffect,
                ...(!literalHost ? { executionInputs } : {}),
                route: basis.relationships.map(({ relationshipId, controllerMachineId, alphaWorkspaceRefId, betaWorkspaceRefId }) => ({ relationshipId, controllerMachineId, alphaWorkspaceRefId, betaWorkspaceRefId })),
                placement: placement.placement, choice, configEnvironment: runtime.configEnvironment ?? {}, platform: platformFor(runtime) });
            worker = { kind: 'source', runtime, basis, snapshot, manifest, choice, signal, reviewedEffect, reviewedEffectDigest: digest(reviewedEffect),
                placementEffectDigest: digest({ placement: placement.placement, choice }), executionInputs,
                ...(serviceEffect ? { serviceEffectDigest: digest(serviceEffect) } : {}) };
            // The ordinary launcher can review a literal SOURCE effect before transfer.
            // Durable approval additionally requires the actual target's preparation facts.
            if (!afterCopy && literalHost && !approval) {
                assertNotCancelled();
                return worker;
            }
            // Native command/toolchain review needs the actual destination's installed
            // tools and current copied files. Sync remains the sole transfer owner;
            // neither native evaluation nor Service launch happens during this review.
            if (!afterCopy && !approval) {
                await phase('clean_preparation', () => runtime.prepareDequeue!({ workspace: basis.source, choice, basis, signal }));
                assertNotCancelled();
            }
            association = await phase('target_workspace', () => resolveProjectSetupAcceptedWorkspace({ address: { serverId: basis.target.serverId, machineId: basis.target.machineId,
                workspaceId: basis.target.id, rootPath: basis.target.rootPath }, ...projectRuntimeAccountRowsInput(runtime),
                serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal }));
            assertNotCancelled();
            const copiedInputs = await phase('copied_inputs', () => readProjectExecutionInputs(association.workspace.rootPath, executionInputs.map(fact => fact.file)));
            assertNotCancelled();
            if (!copiedInputs || digest(copiedInputs) !== digest(executionInputs)) throw new ServiceStartRefusal('project_service_effect_changed');
        } else {
            const currentTargets = await phase('local_declarations', () => discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [association.workspace] }));
            assertNotCancelled();
            if (!currentTargets.some(target => 'declaration' in target && target.id === request.targetId && digest(target.declaration) === digest(request.declaration))) throw new ServiceStartRefusal('launcher_target_unknown');
        }
        const manifest = worker?.manifest ?? (await phase('local_manifest', () => readProjectManifest({ root: association.workspace.rootPath }))).document?.manifest;
        const { environmentBindings, secretEnvironment } = await phase('requester_environment', () => resolveProjectRequesterSecretInputs(runtime, {
            project: sourceAssociation.project, requirements: manifest?.environmentVariables ?? [],
        }, signal));
        if (approval && !sameStrictJsonValue(approval.target, workspaceAddressFromRefV1(association.workspace))) {
            throw new ServiceStartRefusal('project_service_effect_changed');
        }
        const preparation: ProjectSetupPreparationInput = { workspace: association.workspace, projectAssociation: association,
            requesterIdentity: runtime.requesterIdentity,
            approvalContext: context,
            requester: { ...projectRuntimeAccountRowsInput(runtime), serverHttpBaseUrl: runtime.serverHttpBaseUrl }, purpose: 'setup',
            platform: platformFor(runtime),
            nativeIo: runtime.nativeIo, signal,
            ...(approval?.setup?.required ? { effectDecision: { authority: 'present_user' as const,
                project: approval.setup.project, reviewedEffectDigest: approval.setup.reviewedEffectDigest } } : {}),
            retainNativeInvocation: production => nativeCustody ? nativeCustody.retain(production) : nativeInvocations.add(production),
            ...(runtime.successHomeDir ? { successHomeDir: runtime.successHomeDir } : {}),
            ...(environmentBindings ? { environmentBindings } : {}),
            ...(secretEnvironment ? { secretEnvironment } : {}),
            ...(runtime.configEnvironment ? { configEnvironment: runtime.configEnvironment } : {}),
            ...(runtime.plugins ? { plugins: runtime.plugins } : {}),
        };
        assertNotCancelled();
        const prepared = await phase('setup_review', () => prepareProjectSetup(preparation));
        assertNotCancelled();
        if (prepared.kind === 'refused') throw new ServiceStartRefusal(prepared.code);
        const plan = prepared.plan;
        if (approval?.setup && (approval.setup.reviewedEffectDigest !== plan.reviewedEffectDigest
            || !sameStrictJsonValue(approval.setup.project, plan.project))) {
            throw new ServiceStartRefusal('project_service_effect_changed');
        }
        const eligibility = await phase('target_memory_eligibility', () => runtime.workerAdmission.observeServiceEligibility(plan.manifest?.workspace?.memoryDemand, { includeLoad: false }));
        if (!eligibility.eligible) throw new ServiceStartRefusal(eligibility.reason ?? 'project_service_admission_unavailable');
        assertNotCancelled();
        if (worker && (digest(plan.fileBasis) !== digest(worker.snapshot.basis) || digest(plan.manifest) !== digest(worker.manifest))) throw new ServiceStartRefusal('project_service_effect_changed');
        const selection = request.declaration.selection;
        const service = selection.kind === 'manifest' ? plan.manifest?.services?.[selection.name] : undefined;
        const source: ProjectCommandSourceV1 | undefined = selection.kind === 'native' ? selection.source : service?.source;
        if (!source) throw new ServiceStartRefusal('project_service_not_found');
        const { placement, choice } = await phase('target_placement', async () => readChoice(
            await readPlacement(runtime, request, ingress, context, sourceAssociation.workspace.id, assertNotCancelled, phase), request, service));
        if (worker && digest({ placement: placement.placement, choice }) !== worker.placementEffectDigest) throw new ServiceStartRefusal('project_service_effect_changed');
        await phase('target_receiving_placement', () => assertPlacement(choice));
        if (prepared.kind === 'pendingApproval' && !approvalPreparation && (!worker || !worker.serviceEffectDigest)) {
            assertNotCancelled();
            throw new ServiceStartRefusal(prepared.code, {
                reviewedEffect: projectNativeJsonValueForTransport(prepared.plan.reviewedEffect), reviewedEffectDigest: prepared.plan.reviewedEffectDigest,
            });
        }
        let command: SupportedServiceCommand;
        let nativeLifecycleLease: ProjectNativeAdapterLeaseV1 | undefined;
        let builtinNative: Review['builtinNative'];
        let releaseNativeLifecycle: Review['releaseNativeLifecycle'];
        let processMode: Review['processMode'] = service?.port
            ? { kind: 'managedSpawn', port: service.port, endpointDetection: { kind: 'detectAfterLaunch', minimumConfidence: 'high' } }
            : { kind: 'managedSpawn', endpointNone: true,
                endpointDetection: { kind: 'detectAfterLaunch', minimumConfidence: 'high' } };
        if (source.kind === 'command') {
            command = literalServiceCommand(source, association.workspace.rootPath, preparation.platform.os);
        } else {
            assertNotCancelled();
            let production: ProjectNativeAdapterProductionV1 | undefined;
            if (source.kind === 'pluginNative') {
                if (!runtime.plugins) throw new ServiceStartRefusal('native_service_instance_unavailable');
                const selected = await phase('native_adapter', () => runtime.plugins!.resolveProjectNativeAdapter(source.adapter, 'resolveCommand'));
                if (selected.kind === 'refused') throw new ServiceStartRefusal(selected.code);
                nativeLifecycleLease = selected.lease;
                const acquired = selected.lease.acquireProduction({ root: association.workspace.rootPath,
                    environment: preparation.configEnvironment, signal });
                if (acquired.kind !== 'ready') throw new ServiceStartRefusal(acquired.code);
                production = acquired.production;
                preparation.retainNativeInvocation!(production);
            }
            const resolved = await phase('native_command', () => resolveProjectNativeCommand({ root: association.workspace.rootPath, source, usage: 'service', io: runtime.nativeIo, signal,
                serviceScope: digest({ serverId: runtime.serverId, accountId: admission.actorAccountId }),
                ...(production ? { plugin: { lease: production } } : {}) }));
            assertNotCancelled();
            if (resolved.kind === 'refused') {
                if (source.kind === 'native' && source.tool === 'compose' && resolved.code === 'native_tool_unavailable') {
                    throw new NativeComposePrerequisiteError('not_installed');
                }
                throw new ServiceStartRefusal(resolved.code);
            }
            if (source.kind === 'native' && resolved.kind === 'resolved') {
                command = { kind: 'native', source, resolution: resolved };
                if (source.tool === 'compose') {
                    // A toolchain may select a different Docker endpoint. Its
                    // engine prerequisite belongs to the final produced environment.
                    if (plan.toolchain.kind === 'host'
                        && !plan.manifest?.environmentVariables?.some(requirement => requirement.kind !== 'config')) {
                        await phase('native_prerequisite', () => assertNativeComposeAvailable({ io: runtime.environmentIo, command: resolved.command,
                            prefix: resolved.args.slice(0, resolved.args.length - resolved.reviewInvocation.args.length), cwd: resolved.cwd,
                            env: { ...projectBaseEnvironment({ hostEnvironment: runtime.hostEnvironment }, plan), ...resolved.environmentOverlay }, signal }));
                        assertNotCancelled();
                    }
                    builtinNative = createNativeComposeLifecycle({ args: resolved.reviewInvocation.args, io: runtime.environmentIo });
                    processMode = { kind: 'native', builtinLifecycle: builtinNative.lifecycle };
                } else if (source.tool === 'flox') {
                    // The activation, including its native selected-service wait,
                    // is the owned process lifetime, not a detached native resource.
                    processMode = { kind: 'managedSpawn', endpointNone: true,
                        endpointDetection: { kind: 'detectAfterLaunch', minimumConfidence: 'high' } };
                }
            }
            else if (source.kind === 'pluginNative' && resolved.kind === 'pluginResolved' && production && nativeLifecycleLease) {
                command = { kind: 'pluginNative', source, resolution: resolved.command, lease: production };
                const instance = resolved.command.nativeInstance;
                if (instance) {
                const lifecycleInput = { root: association.workspace.rootPath, environment: preparation.configEnvironment };
                const captured = nativeLifecycleLease.captureNativeServiceLifecycle(instance, lifecycleInput);
                if (captured.kind !== 'ready') throw new ServiceStartRefusal(captured.code);
                releaseNativeLifecycle = captured.release;
                const admittedLease = nativeLifecycleLease;
                const plugins = runtime.plugins;
                const resolveCurrentLifecycle = async () => {
                    if (admittedLease.isCurrent()) return { lifecycle: captured.lifecycle, release: async () => {} };
                    if (!plugins) throw new ServiceStartRefusal('native_adapter_retired');
                    const current = await plugins.resolveProjectNativeAdapter(instance.adapter, 'nativeServiceLifecycle');
                    if (current.kind !== 'ready') throw new ServiceStartRefusal(current.code);
                    const recovery = current.lease.captureNativeServiceLifecycle(instance, lifecycleInput);
                    if (recovery.kind !== 'ready') throw new ServiceStartRefusal(recovery.code);
                    return recovery;
                };
                function logs(candidate: ManagedServiceNativeInstanceV1, options: ManagedServiceNativeLogReadV1): Promise<ManagedServiceNativeLogResultV1>;
                function logs(candidate: ManagedServiceNativeInstanceV1, options: ManagedServiceNativeLogWatchV1): Promise<Disposable>;
                async function logs(candidate: ManagedServiceNativeInstanceV1,
                    options: ManagedServiceNativeLogReadV1 | ManagedServiceNativeLogWatchV1): Promise<ManagedServiceNativeLogResultV1 | Disposable> {
                    const current = await resolveCurrentLifecycle();
                    if (options.kind === 'read' || !current.lifecycle.logs) {
                        try {
                            if (options.kind === 'read') return await current.lifecycle.logs?.(candidate, options)
                                ?? { kind: 'unavailable', reason: 'unsupported' };
                            options.emit({ kind: 'unavailable', reason: 'unsupported' });
                            return { dispose() {} };
                        } finally { await current.release(); }
                    }
                    try {
                        const subscription = await current.lifecycle.logs(candidate, options);
                        return { async dispose() {
                            try { await subscription.dispose(); }
                            finally { await current.release(); }
                        } };
                    } catch (error) { await current.release(); throw error; }
                }
                processMode = { kind: 'native', instance, lifecycle: {
                    logs,
                    async inspect(candidate, options) {
                        const current = await resolveCurrentLifecycle();
                        try { return await current.lifecycle.inspect(candidate, options); }
                        finally { await current.release(); }
                    },
                    async stop(candidate, options) {
                        if (admittedLease.isCurrent()) return captured.lifecycle.stop(candidate, options);
                        let current: Awaited<ReturnType<typeof resolveCurrentLifecycle>>;
                        try { current = await resolveCurrentLifecycle(); }
                        catch {
                            // The retired capture retains only exact-resource Stop, never inspection.
                            return captured.lifecycle.stop(candidate, options);
                        }
                        // Recovery observes the incumbent resource before replacement/control retry.
                        try {
                            const observation = await current.lifecycle.inspect(candidate, options);
                            if (observation.phase === 'stopped') return { status: 'stopped' };
                            if (observation.phase !== 'running') return { status: 'termination_incomplete' };
                            return await current.lifecycle.stop(candidate, options);
                        } catch { return { status: 'termination_incomplete' }; }
                        finally { await current.release(); }
                    },
                } };
                }
            } else throw new ServiceStartRefusal('native_adapter_result_invalid');
        }
        if (worker?.serviceEffectDigest && digest({ command, toolchain: plan.toolchain, configEnvironment: preparation.configEnvironment ?? {},
            platform: preparation.platform }) !== worker.serviceEffectDigest) throw new ServiceStartRefusal('project_service_effect_changed');
        const files: Array<{ file: string; digest: string }> = [];
        if (command.kind !== 'literal') {
            const nativeFiles = new Set([command.source.file, ...command.resolution.reviewInputs.map(fact => fact.file)]);
            if (command.kind === 'native') {
                const executableWithinRoot = relative(association.workspace.rootPath, command.resolution.command);
                if (executableWithinRoot !== '..' && !executableWithinRoot.startsWith('../') && !executableWithinRoot.startsWith('..\\') && !isAbsolute(executableWithinRoot)) {
                    nativeFiles.add(executableWithinRoot.replaceAll('\\', '/'));
                }
            }
            for (const file of nativeFiles) {
                const read = await phase('native_definition', () => readProjectDefinitionFileBytes(association.workspace.rootPath, file));
                assertNotCancelled();
                if (read.kind !== 'read') throw new ServiceStartRefusal(read.kind === 'refused' ? read.code : 'native_configuration_missing');
                if (command.resolution.reviewInputs.some(fact => fact.file === file && fact.content !== read.bytes.toString('utf8'))) throw new ServiceStartRefusal('project_service_effect_changed');
                files.push({ file, digest: createHash('sha256').update(read.bytes).digest('hex') });
            }
        }
        const portablePath = (value: string) => {
            const local = relative(association.workspace.rootPath, value);
            return isAbsolute(value) && local !== '..' && !local.startsWith('../') && !local.startsWith('..\\') && !isAbsolute(local) ? local.replaceAll('\\', '/') || '.' : value;
        };
        const resolvedCommand = command.kind === 'literal' ? { source: command.source, cwd: portablePath(command.cwd) }
            : command.kind === 'pluginNative' ? { source: command.source, executable: command.resolution.executable,
                args: command.resolution.args.map(portablePath), cwd: portablePath(command.resolution.cwd),
                adapterVersion: command.lease.pluginVersion, nativeInstance: command.resolution.nativeInstance,
                nativeCommandToolchain: command.resolution.toolchainApplied }
            : { source: command.source, executable: portablePath(command.resolution.command),
                args: command.resolution.args.map(portablePath), cwd: portablePath(command.resolution.cwd),
                toolchain: command.resolution.toolchain, environmentOverlay: command.resolution.environmentOverlay,
                nativeCommandToolchain: command.resolution.nativeCommandToolchain };
        const reviewedEffect = projectNativeJsonValueForTransport({ v: 1, purpose: 'service', declaration: request.declaration,
            service, command: resolvedCommand, files: files.sort((a, b) => a.file.localeCompare(b.file)), setupEffectDigest: plan.reviewedEffectDigest,
            placement: placement.placement, choice, configEnvironment: plan.configEnvironment, platform: preparation.platform,
            ...(worker && !worker.serviceEffectDigest ? { sourceReview: worker.reviewedEffect } : {}) });
        const declaration = { ...request.declaration, workspaceRefId: association.workspace.id };
        assertNotCancelled();
        return { kind: 'target', runtime, preparation, plan, declaration,
            ...(worker ? { source: worker } : {}),
            serviceId: createProjectServiceDeclarationTargetIdV1(association.workspace, declaration.selection),
            execution: service?.execution ?? 'primary',
            setupNotRequired: prepared.kind === 'notRequired', ...(prepared.kind === 'pendingApproval' ? { setupReview: {
                code: prepared.code, reviewedEffect: projectNativeJsonValueForTransport(plan.reviewedEffect), reviewedEffectDigest: plan.reviewedEffectDigest } } : {}),
            command, processMode, ...(nativeLifecycleLease ? { nativeLifecycleLease } : {}), ...(builtinNative ? { builtinNative } : {}), ...(releaseNativeLifecycle ? { releaseNativeLifecycle } : {}),
            reviewedEffect: worker?.serviceEffectDigest ? worker.reviewedEffect : reviewedEffect,
            reviewedEffectDigest: worker?.serviceEffectDigest ? worker.reviewedEffectDigest : digest(reviewedEffect) };
    }

    async function reviewTarget(nativeInvocations: Set<ProjectNativeEffectCaptureForHost>, reviewInputs: AdmittedReview, executeCanonicalAction?: CanonicalPoolRead,
        nativeCustody?: Pick<ReturnType<typeof createProjectNativeInvocationCustody>, 'retain'>, copiedSource?: SourceReview): Promise<Review> {
        const result = await review(nativeInvocations, reviewInputs, true, executeCanonicalAction, nativeCustody, false, copiedSource);
        if (result.kind !== 'target') throw new ServiceStartRefusal('project_service_effect_changed');
        return result;
    }

    async function resolveStartTarget(request: DaemonLocalServiceLauncherStartRequestV1, ingress?: RpcHandlerContext, context?: ActionContext, executeCanonicalAction?: CanonicalPoolRead): Promise<LocalServiceLauncherStartResolution<SelectedDeclaration>> {
        const nativeInvocations = new Set<ProjectNativeEffectCaptureForHost>();
        let uncertain = false;
        try {
            const reviewInputs = await admitRequest(request, ingress, context);
            const { runtime } = reviewInputs;
            const current = await review(nativeInvocations, reviewInputs, false, executeCanonicalAction);
            const expectedEffectDigest = context?.nativeServiceStartApproval?.reviewedEffectDigest ?? request.expectedEffectDigest;
            if (expectedEffectDigest !== undefined && expectedEffectDigest !== current.reviewedEffectDigest) return {
                ok: false, reasonCode: 'project_service_effect_changed',
                reviewedEffect: current.reviewedEffect, reviewedEffectDigest: current.reviewedEffectDigest,
            };
            const destination = current.kind === 'target' ? current.plan.workspace : current.basis.target;
            return { ok: true, declaration: { targetId: request.targetId, reviewedEffectDigest: current.reviewedEffectDigest, runtime,
                ...(current.kind === 'source' ? { source: current } : current.source ? { source: current.source } : {}),
                workspace: workspaceAddressFromRefV1(destination),
                declaration: current.kind === 'target' ? current.declaration : { ...request.declaration!, workspaceRefId: destination.id } } };
        } catch (error) {
            uncertain = isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError;
            if (uncertain) throw error;
            return refusal(error);
        } finally { if (!uncertain) await Promise.all([...nativeInvocations].map(production => production.release())); }
    }

    async function prepareStartApproval(request: DaemonLocalServiceLauncherStartRequestV1, ingress?: RpcHandlerContext,
        context?: ActionContext, executeCanonicalAction?: CanonicalPoolRead): Promise<LocalServiceStartApprovalReviewV1 | ActionExecuteFailure> {
        const nativeInvocations = new Set<ProjectNativeEffectCaptureForHost>();
        let uncertain = false;
        try {
            const reviewInputs = await admitRequest(request, ingress, context);
            const current = await review(nativeInvocations, reviewInputs, true, executeCanonicalAction, undefined, true);
            if (current.kind !== 'target') throw new ServiceStartRefusal('project_service_effect_review_required');
            if (request.expectedEffectDigest && request.expectedEffectDigest !== current.reviewedEffectDigest) {
                throw new ServiceStartRefusal('project_service_effect_changed', current);
            }
            return LocalServiceStartApprovalReviewV1Schema.parse({ request,
                target: workspaceAddressFromRefV1(current.plan.workspace),
                reviewedEffect: current.reviewedEffect, reviewedEffectDigest: current.reviewedEffectDigest,
                setup: { required: !current.setupNotRequired, project: current.plan.project,
                    reviewedEffect: projectNativeJsonValueForTransport(current.plan.reviewedEffect),
                    reviewedEffectDigest: current.plan.reviewedEffectDigest } });
        } catch (error) {
            uncertain = isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError;
            if (uncertain) throw error;
            const denied = refusal(error);
            return { ok: false, errorCode: denied.reasonCode, error: denied.reasonCode,
                ...(denied.reviewedEffect !== undefined || denied.reviewedEffectDigest ? { details: {
                    ...(denied.reviewedEffect !== undefined ? { reviewedEffect: denied.reviewedEffect } : {}),
                    ...(denied.reviewedEffectDigest ? { reviewedEffectDigest: denied.reviewedEffectDigest } : {}),
                } } : {}) };
        } finally { if (!uncertain) await Promise.all([...nativeInvocations].map(production => production.release())); }
    }

    async function startManagedDeclaration(selected: SelectedDeclaration, request: DaemonLocalServiceLauncherStartRequestV1, ingress?: RpcHandlerContext, context?: ActionContext, executeCanonicalAction?: CanonicalPoolRead): Promise<LocalServiceLauncherStartExecutionOutcome> {
        const { workspace, declaration } = request;
        if (!ingress || !context || !workspace || !declaration) {
            return executeManagedDeclaration(selected, request, ingress, context, executeCanonicalAction);
        }
        const runtime = selected.runtime;
        if (ingress.signal.aborted || context.signal?.aborted) return { status: 'denied', reasonCode: 'cancelled' };
        let outcome: LocalServiceLauncherStartExecutionOutcome | undefined;
        let uncertainError: unknown;
        // The native receiver owns Start observation for UI, approved CLI and Move.
        // Finite setup keeps its own review/output custody beneath this Service operation.
        const execute: Parameters<typeof runtime.operationRuntime.observeExecution>[0]['execute'] = async operation => {
            // Once admitted, the operation owns preparation and launch. A lost
            // browser ACK ends observation, not the user's accepted Service.
            // Keep the operation's cancellation and an enclosing Move's cancellation.
            const parentSignal = context.operationCancellation
                || ingress.callerInputAuthorization?.binding.actionId === 'projects.service.relocate'
                ? context.signal ?? ingress.signal : undefined;
            const acceptedSignal = parentSignal ? AbortSignal.any([operation.signal, parentSignal]) : operation.signal;
            const acceptedIngress: RpcHandlerContext = { ...ingress, signal: acceptedSignal };
            operation.operationOwnerUpdate.update({ state: 'running', domainRef: { kind: 'projectService', purpose: 'start',
                sourceWorkspace: { serverId: workspace.serverId, refId: workspace.workspaceId },
                workspace: selected.workspace, declaration: selected.declaration } });
            operation.operationProgress.update({ phase: 'preparing', label: 'Preparing service' });
            try {
                outcome = await executeManagedDeclaration(selected, request, acceptedIngress, { ...context, ...operation,
                    signal: acceptedSignal, verifyMachineAdmissionCurrent: acceptedIngress.verifyMachineAdmissionCurrent }, executeCanonicalAction);
                return outcome.status === 'succeeded' ? { ok: true, result: outcome }
                    : { ok: false, errorCode: outcome.reasonCode, error: outcome.reasonCode };
            } catch (error) {
                if (isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError) {
                    uncertainError = error;
                    return { ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' };
                }
                throw error;
            }
        };
        // The same request owner may already have admitted this installed
        // invocation before confirmation policy. Its acceptance and sibling
        // lifecycle ports come from that owner, not from serialized input.
        const observed = context.operationAcceptance?.actionId === 'localServices.launcher.start'
            ? await execute({ ...context, actionRequestId: context.actionRequestId ?? undefined, resumeActionRequest: context.resumeActionRequest === true ? true : undefined, signal: context.signal ?? ingress.signal,
                operationProgress: context.operationProgress!, operationOwnerUpdate: context.operationOwnerUpdate! })
            : await runtime.operationRuntime.observeExecution({ actionId: 'localServices.launcher.start', input: request,
                rpcContext: ingress, ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}), execute });
        if (uncertainError) throw uncertainError;
        if (outcome) return outcome;
        if (!observed.ok) return { status: 'failed', reasonCode: observed.errorCode };
        const target = LocalServiceManagedServiceActionTargetV1Schema.safeParse(observed.result && typeof observed.result === 'object'
            && 'currentTarget' in observed.result ? observed.result.currentTarget : undefined);
        return { status: 'succeeded', ...(target.success ? { currentTarget: target.data } : {}) };
    }

    async function executeManagedDeclaration(selected: SelectedDeclaration, request: DaemonLocalServiceLauncherStartRequestV1, ingress?: RpcHandlerContext, context?: ActionContext, executeCanonicalAction?: CanonicalPoolRead): Promise<LocalServiceLauncherStartExecutionOutcome> {
        let lease: PluginRuntimeLease | undefined;
        const nativeInvocations = new Set<ProjectNativeEffectCaptureForHost>();
        let uncertain = false;
        try {
            if (selected.targetId !== request.targetId || request.expectedEffectDigest !== undefined
                && selected.reviewedEffectDigest !== request.expectedEffectDigest) throw new ServiceStartRefusal('project_service_effect_changed');
            if (!ingress?.machineAdmission || !ingress.verifyMachineAdmissionCurrent) throw new ServiceStartRefusal('machine_admission_required');
            if (!context) throw new ServiceStartRefusal('project_service_action_context_unavailable');
            if (!request.workspace || !request.declaration) throw new ServiceStartRefusal('launcher_start_declaration_unavailable');
            const reviewInputs: AdmittedReview = { runtime: selected.runtime,
                request: { ...request, workspace: request.workspace, declaration: request.declaration },
                ingress: { ...ingress, machineAdmission: ingress.machineAdmission, verifyMachineAdmissionCurrent: ingress.verifyMachineAdmissionCurrent }, context };
            const initial = await review(nativeInvocations, reviewInputs, false, executeCanonicalAction, undefined, false, selected.source);
            const initialSource = initial.kind === 'source' ? initial : initial.source;
            // Without durable approval, a native TARGET review has already made
            // its causal copy to inspect native facts. Retain that SOURCE basis
            // for later checks, without copying a second time at this boundary.
            const needsCopy = initial.kind === 'source' || Boolean(initial.source && context?.nativeServiceStartApproval);
            const unchanged = (fresh: Pick<Review, 'reviewedEffect' | 'reviewedEffectDigest'>) => {
                if (fresh.reviewedEffectDigest !== selected.reviewedEffectDigest) throw new ServiceStartRefusal('project_service_effect_changed', fresh);
            };
            unchanged(initial);
            const prepareCopy = async (signal: AbortSignal) => {
                const source = initialSource;
                if (!source) return;
                const eligibility = await source.runtime.workerAdmission.observeServiceEligibility(source.manifest.workspace?.memoryDemand, { includeLoad: false });
                if (!eligibility.eligible) throw new ServiceStartRefusal(eligibility.reason ?? 'project_service_admission_unavailable');
                context.operationProgress?.update({ phase: 'copying', label: 'Copying current files' });
                await source.runtime.prepareDequeue!({ workspace: source.basis.source, choice: source.choice, basis: source.basis, signal });
            };
            if (needsCopy) await prepareCopy(initial.kind === 'source' ? initial.signal : initial.preparation.signal!);
            context.operationProgress?.update({ phase: 'preparing', label: 'Preparing service' });
            let current = initial.kind === 'source' || needsCopy ? await reviewTarget(nativeInvocations, reviewInputs, executeCanonicalAction, undefined, initialSource) : initial;
            unchanged(current);
            let setupInput: ProjectSetupExecutionInput | undefined;
            let finishSetup!: (outcome: ProjectSetupExecutionOutcome) => void;
            const settled = new Promise<ProjectSetupExecutionOutcome>(resolve => { finishSetup = resolve; });
            const setup = await current.runtime.operationRuntime.observeExecution({ actionId: 'projects.prepare',
                input: { workspace: request.workspace, phase: 'setup' }, rpcContext: ingress,
                ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
                execute: async (operation: ProjectSetupOperationContext) => {
                    const operationSignal = AbortSignal.any([current.preparation.signal!, operation.signal]);
                    const buildSetupInput = (): ProjectSetupExecutionInput => ({ preparation: { ...current.preparation, signal: operationSignal }, requesterAccountId: current.runtime.accountId,
                        operation, terminalSessions: current.runtime.terminalSessions, environmentIo: current.runtime.environmentIo,
                        terminalCustody: { serverId: current.runtime.serverId, requesterAccountId: current.runtime.accountId,
                            machineId: current.runtime.machineId, installationId: ingress.machineAdmission!.installationId,
                            workspaceRefId: current.plan.workspace.id, projectKey: current.plan.workspace.projectKey!, rootPath: current.plan.workspace.rootPath },
                        ...(current.runtime.platform ? { platform: current.runtime.platform } : {}),
                        ...(current.runtime.hostEnvironment ? { hostEnvironment: current.runtime.hostEnvironment } : {}),
                    });
                    // The setup owner has proved there is no finite prerequisite. Keep
                    // the real operation context for final native admission without a
                    // reservation, queue, or finite-policy dependency for this service.
                    if (current.setupNotRequired) {
                        setupInput = buildSetupInput();
                        const result = { ok: true as const, result: { kind: 'notRequired', reviewedEffectDigest: current.plan.reviewedEffectDigest } };
                        finishSetup({ kind: 'no_launch', result });
                        return result;
                    }
                    if (!operation.operationAcceptance) {
                        const result = { ok: false as const, errorCode: 'project_setup_operation_unavailable', error: 'project_setup_operation_unavailable' };
                        finishSetup({ kind: 'no_launch', result });
                        return result;
                    }
                    const admitted = await current.runtime.workerAdmission.execute({ operationId: operation.operationAcceptance.operationId,
                        workspaceRefId: current.plan.workspace.id, requesterAccountId: current.runtime.accountId,
                        memoryDemand: current.plan.manifest?.workspace?.memoryDemand, signal: operationSignal,
                        ...(initialSource ? { relatedWorkspaces: initialSource.basis.relationships.flatMap(relationship => [
                            { workspaceRefId: relationship.alphaWorkspaceRefId, relationshipId: relationship.relationshipId },
                            { workspaceRefId: relationship.betaWorkspaceRefId, relationshipId: relationship.relationshipId },
                        ]) } : {}),
                        accept(handle) {
                            publishProjectFiniteAdmission({ workspace: current.plan.workspace, purpose: 'setup', requesterAccountId: current.runtime.accountId, operation });
                            operation.operationAcceptance!.accept(handle);
                        },
                        onQueue: ahead => operation.operationProgress.update({ phase: 'queued', current: ahead, total: ahead + 1 }),
                        onUnknown: error => operation.operationOwnerUpdate.update({ observation: { kind: 'outcome_uncertain', code: codeOf(error) } }),
                        run: async reservation => {
                            try {
                                current = await reviewTarget(nativeInvocations, reviewInputs, executeCanonicalAction, undefined, initialSource);
                                unchanged(current);
                                while (current.setupReview) {
                                    if (!operation.operationReview) throw new ServiceStartRefusal(current.setupReview.code, current.setupReview);
                                    reservation.phase('setup');
                                    await operation.operationReview.waitForResume({ kind: 'pendingApproval', ...current.setupReview });
                                    // Resume the SAME accepted setup, under the original exact Sync basis and current source effect.
                                    const fresh = await review(nativeInvocations, reviewInputs, false, executeCanonicalAction);
                                    unchanged(fresh);
                                    if (needsCopy) await prepareCopy(operationSignal);
                                    current = await reviewTarget(nativeInvocations, reviewInputs, executeCanonicalAction, undefined, initialSource);
                                    unchanged(current);
                                }
                            } catch (error) {
                                preserveUnconfirmedNativeProcess(error);
                                const outcome = { kind: 'no_launch' as const, result: { ok: false as const, errorCode: codeOf(error), error: codeOf(error) } };
                                finishSetup(outcome);
                                return outcome;
                            }
                            reservation.phase('setup');
                            setupInput = buildSetupInput();
                            const outcome = await executeProjectSetup(setupInput);
                            finishSetup(outcome);
                            return outcome;
                        },
                    });
                    if (!setupInput) finishSetup({ kind: 'no_launch', result: admitted.ok
                        ? { ok: false, errorCode: 'project_setup_not_accepted', error: 'project_setup_not_accepted' } : admitted });
                    return admitted;
                } });
            if (!setup.ok) throw new ServiceStartRefusal(setup.errorCode);
            const outcome = await settled;
            if (outcome.kind === 'outcome_uncertain') { uncertain = true; throw new ServiceStartRefusal('outcome_uncertain'); }
            if (!outcome.result.ok) throw new ServiceStartRefusal(outcome.result.errorCode);
            if (!setupInput) throw new ServiceStartRefusal('project_setup_operation_unavailable');
            current = await reviewTarget(nativeInvocations, reviewInputs, executeCanonicalAction, undefined, initialSource);
            unchanged(current);
            if (current.setupReview) throw new ServiceStartRefusal(current.setupReview.code, current.setupReview);
            lease = await input.acquirePluginRuntime();
            const registry = lease.registry;
            // Project custody belongs to the stable daemon owner, not the registry projection
            // which supplied its port. Exact selected environment leases retain their own lifetime;
            // admitted requester work keeps that custody until its natural boundary.
            const isCurrent = () => (!current.plan.toolchainAdapterLease || current.plan.toolchainAdapterLease.isCurrent())
                && (!current.nativeLifecycleLease || current.nativeLifecycleLease.isCurrent());
            if (!isCurrent()) throw new ServiceStartRefusal('native_adapter_retired');
            const builtinNative = current.builtinNative;
            const releaseNativeLifecycle = current.releaseNativeLifecycle;
            context.operationProgress?.update({ phase: 'starting', label: 'Starting service' });
            const handle = await registry.projectManagedServices.superviseProject({ kind: 'workspace', workspace: current.plan.workspace, declaration: current.declaration,
                ...(current.command.kind === 'native' ? { nativeTool: current.command.source.tool } : {}),
                cwd: current.command.kind === 'literal' ? current.command.cwd : current.command.resolution.cwd,
                requester: { serverId: current.runtime.serverId, accountId: ingress.machineAdmission!.actorAccountId,
                    machineId: ingress.machineAdmission!.machineId, installationId: ingress.machineAdmission!.installationId },
                serviceId: current.serviceId, execution: current.execution,
                specIdentity: selected.reviewedEffectDigest, signal: current.preparation.signal, isCurrent,
                processSpec: { mode: current.processMode },
                authorizeLaunch: async ({ signal }) => {
                    const launchInvocations = new Set<ProjectNativeEffectCaptureForHost>();
                    const nativeCustody = createProjectNativeInvocationCustody({ signal }, launchInvocations);
                    let launchUncertain = false;
                    let retained = false;
                    try {
                    current = await reviewTarget(launchInvocations, reviewInputs, executeCanonicalAction, nativeCustody, initialSource);
                    unchanged(current);
                    if (current.setupReview) throw new ServiceStartRefusal(current.setupReview.code, current.setupReview);
                    if (!isCurrent()) throw new ServiceStartRefusal('native_adapter_retired');
                    const launch = await authorizePreparedProjectCommand({ ...setupInput!, preparation: current.preparation }, current.plan, current.command, signal);
                    try {
                        if (!isCurrent() || signal.aborted) throw new ServiceStartRefusal('cancelled');
                        builtinNative?.bindLaunch(launch);
                        await builtinNative?.assertAvailable(signal);
                        // The Project supervisor retains this final capture until
                        // its existing cleanup proves the owned process tree settled.
                        retained = true;
                        return { ...launch,
                            ...(current.command.kind === 'native' && current.command.source.tool === 'flox'
                                ? { waitForGracefulRootExitBeforeTreeStop: true as const } : {}),
                            async release() {
                            try { await launch.release(); }
                            finally { try { await releaseNativeLifecycle?.(); }
                                finally { await nativeCustody.release({ waitForSettlement: false }); nativeCustody.dispose(); } }
                        } };
                    } catch (error) {
                        if (!isProjectNativeProcessUncertain(error) && !(error instanceof ProjectNativeToolchainUncertainError)) await launch.release();
                        throw error;
                    }
                    } catch (error) {
                        launchUncertain = isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError;
                        if (launchUncertain) uncertain = true;
                        throw error;
                    } finally { if (!launchUncertain && !retained) {
                        await nativeCustody.release();
                        nativeCustody.dispose();
                    } }
                },
            });
            const currentTarget = { kind: 'managed_service' as const, managedServiceId: handle.instanceId,
                machineId: handle.workspace.machineId, workspaceId: handle.workspace.id, cwd: handle.cwd, declaration: handle.declaration };
            context.operationOwnerUpdate?.update({ domainRef: { kind: 'projectService', purpose: 'start',
                sourceWorkspace: { serverId: request.workspace!.serverId, refId: request.workspace!.workspaceId },
                workspace: workspaceAddressFromRefV1(handle.workspace), declaration: handle.declaration, currentTarget } });
            return { status: 'succeeded', currentTarget };
        } catch (error) { uncertain ||= isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError;
            if (isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError) throw error;
            const denied = refusal(error); return { status: 'denied', reasonCode: denied.reasonCode,
            ...(denied.establishmentFailure ? { establishmentFailure: denied.establishmentFailure } : {}),
            ...(denied.prerequisite ? { prerequisite: denied.prerequisite } : {}),
            ...(denied.reviewedEffect !== undefined ? { reviewedEffect: denied.reviewedEffect } : {}),
            ...(denied.reviewedEffectDigest ? { reviewedEffectDigest: denied.reviewedEffectDigest } : {}) }; }
        finally { if (!uncertain) await Promise.all([...nativeInvocations].map(production => production.release())); await lease?.release(); }
    }
    const prepareRestartManagedService: PrepareRestartProjectManagedService = async (request, handle, execution) => {
        if (handle.kind !== 'workspace') return { status: 'denied', reasonCode: 'workspace_service_required' };
        const start: DaemonLocalServiceLauncherStartRequestV1 = {
            ...buildProjectManagedServiceStartRequest(handle),
            ...(request.expectedEffectDigest ? { expectedEffectDigest: request.expectedEffectDigest } : {}),
            ...(request.choice ? { choice: request.choice } : {}),
        };
        // Fresh source/effect/placement review precedes disruption. Stop never authorizes replacement.
        const preparedReview = await prepareStartApproval(start, execution.ingress, execution.actionContext);
        if ('ok' in preparedReview) {
            const details = preparedReview.details && typeof preparedReview.details === 'object' ? preparedReview.details : undefined;
            return { status: 'denied', reasonCode: preparedReview.errorCode,
                ...(details && 'reviewedEffect' in details ? { reviewedEffect: projectNativeJsonValueForTransport(details.reviewedEffect) } : {}),
                ...(details && 'reviewedEffectDigest' in details && typeof details.reviewedEffectDigest === 'string'
                    ? { reviewedEffectDigest: details.reviewedEffectDigest } : {}) };
        }
        const childInput = { ...start, expectedEffectDigest: preparedReview.reviewedEffectDigest };
        const review = { ...preparedReview, request: childInput };
        return { children: [{ action: 'localServices.launcher.start', role: PROJECT_SERVICE_RESTART_START_ROLE,
            input: projectNativeJsonValueForTransport(childInput) }],
            approvalPreview: projectNativeJsonValueForTransport({ serviceStartReview: review }),
            prepareExecutionContext: async context => ({ ...context, nativeServiceStartApproval: review }) };
    };
    const restartManagedService: RestartProjectManagedService = async (_request, handle, execution) => {
        if (handle.kind !== 'workspace') return { status: 'denied', reasonCode: 'workspace_service_required' };
        const child = execution.actionContext.hostReviewedChild;
        const review = execution.actionContext.nativeServiceStartApproval;
        if (!child || !review) return { status: 'denied', reasonCode: 'managed_service_restart_admission_required' };
        const signals = [execution.ingress?.signal, execution.actionContext.signal].filter((signal): signal is AbortSignal => signal !== undefined);
        const stopped = await stopProjectManagedService(handle, signals.length ? AbortSignal.any(signals) : undefined);
        if (stopped.status !== 'succeeded') return stopped;
        const result = await child.invoke({ action: 'localServices.launcher.start', role: PROJECT_SERVICE_RESTART_START_ROLE,
            input: projectNativeJsonValueForTransport(review.request) });
        if (!result.ok) return { status: 'denied', reasonCode: result.errorCode };
        const parsed = DaemonLocalServiceLauncherStartResponseV1Schema.safeParse(result.result);
        if (!parsed.success) return { status: 'failed', reasonCode: 'managed_service_restart_result_unavailable' };
        if (parsed.data.status === 'succeeded') return { status: 'succeeded' };
        return { status: parsed.data.status, reasonCode: parsed.data.reasonCode ?? 'managed_service_restart_failed',
            ...(parsed.data.reviewedEffect !== undefined ? { reviewedEffect: parsed.data.reviewedEffect } : {}),
            ...(parsed.data.reviewedEffectDigest ? { reviewedEffectDigest: parsed.data.reviewedEffectDigest } : {}) };
    };
    return { resolveStartTarget, startManagedDeclaration, prepareRestartManagedService, restartManagedService, prepareStartApproval };
}
