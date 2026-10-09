import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { projectNativeJsonValueForTransport, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { DaemonLocalServiceLauncherStartRequestV1, RuntimeActionExecuteArgs } from '@happier-dev/protocol';
import type { ProjectCommandSourceV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readProjectFiniteIngressRefusal, type ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { resolveProjectSetupAcceptedWorkspace } from '@/workspaces/projectSetup/projectSetupAcceptedWorkspace';
import { prepareProjectSetup, type PreparedProjectSetupCommand, type PreparedProjectSetupPlan, type ProjectSetupPreparationInput } from '@/workspaces/projectSetup/projectSetupPreparation';
import { authorizePreparedProjectCommand, createProjectNativeInvocationCustody, executeProjectSetup, publishProjectFiniteAdmission, type ProjectSetupExecutionInput, type ProjectSetupExecutionOutcome, type ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { resolveProjectNativeCommand } from '@/workspaces/projectSetup/projectNativeResolution';
import { readProjectDefinitionFileBytes } from '@/workspaces/projectSetup/nativeDefinitionFiles';
import { resolveProjectServiceStartChoice } from '@/workspaces/execution/projectServicePlacement';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import type { ProjectManagedServiceSupervisionInput, createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { MANAGED_SERVICE_NUMERIC_CONTRACT } from '@/plugins/runtime/invocation/services/managedServiceSpecNormalization';
import { discoverLocalServiceRunTargets } from './runTargets';
import type { LocalServiceLauncherStartExecutionOutcome, LocalServiceLauncherStartResolution } from './start';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { stopProjectManagedService, type RestartProjectManagedService } from '../actions/executor';
import { createProjectServiceDeclarationTargetIdV1, type ProjectServiceDeclarationRefV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { ProjectManifestFileSnapshot } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import type { WorkspaceSyncWorkerTargetBasis } from '@/workspaces/sync/workspaceSyncPreparation';
import type { ProjectServiceStartChoice } from '@/workspaces/execution/projectServicePlacement';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { assertProjectReceivingPlacement } from '@/workspaces/execution/projectReceivingPlacement';
import { isProjectNativeProcessUncertain, preserveUnconfirmedNativeProcess, type ProjectNativeAdapterLeaseV1, type ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { ProjectNativeEnvironmentUncertainError } from '@/workspaces/environment/produceProjectNativeEnvironment';
import type { ProjectNativeEffectCaptureForHost } from '@/plugins/runtime/invocation/services/exec';

type ActionContext = RuntimeActionExecuteArgs['context'];
type CanonicalPoolRead = RuntimeActionExecuteArgs['executeCanonicalAction'];
type SupportedServiceCommand = PreparedProjectSetupCommand;
type SelectedDeclaration = Readonly<{ targetId: string; reviewedEffectDigest: string }>;
type PluginRuntimeLease = Readonly<{
    registry: Readonly<{ projectManagedServices: Pick<ReturnType<typeof createManagedServicesOwner>, 'superviseProject'> }>;
    release(): Promise<void>;
}>;
export type ProjectServiceDeclarationStarterInput = Readonly<{
    /** The already mounted finite owner supplies its actual PTY and operation ports. */
    resolveRuntime(ingress: RpcHandlerContext): Promise<ProjectFiniteActionRuntime | null>;
    acquirePluginRuntime(): Promise<PluginRuntimeLease>;
}>;

type Review = Readonly<{
    kind: 'target';
    runtime: ProjectFiniteActionRuntime;
    preparation: ProjectSetupPreparationInput;
    plan: PreparedProjectSetupPlan;
    setupNotRequired: boolean;
    setupReview?: Readonly<{ code: 'project_setup_consent_required' | 'project_setup_effect_changed'; reviewedEffect: JsonValue; reviewedEffectDigest: string }>;
    declaration: ProjectServiceDeclarationRefV1;
    serviceId: string;
    command: SupportedServiceCommand;
    processMode: ProjectManagedServiceSupervisionInput['processSpec']['mode'];
    nativeLifecycleLease?: ProjectNativeAdapterLeaseV1;
    reviewedEffect: JsonValue;
    reviewedEffectDigest: string;
}>;
type SourceReview = Readonly<{
    kind: 'source';
    runtime: ProjectFiniteActionRuntime;
    basis: WorkspaceSyncWorkerTargetBasis;
    snapshot: ProjectManifestFileSnapshot;
    manifest: ProjectManifestV1;
    choice: Extract<ProjectServiceStartChoice, { status: 'resolved' }>['choice'];
    placementEffectDigest: string;
    serviceEffectDigest: string;
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
const refusal = (error: unknown): Extract<LocalServiceLauncherStartResolution<SelectedDeclaration>, { ok: false }> => ({
    ok: false, reasonCode: codeOf(error), ...(error instanceof ServiceStartRefusal && error.review ? error.review : {}),
});
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
    async function readChoice(runtime: ProjectFiniteActionRuntime, request: DaemonLocalServiceLauncherStartRequestV1,
        ingress: RpcHandlerContext, context: ActionContext, workspaceRefId: string,
        service: NonNullable<ProjectManifestV1['services']>[string] | undefined, assertCurrent: () => Promise<void>) {
        const config = await runtime.resolveWorkspaceExecutionConfig(context, ingress, 'localServices.launcher.start');
        await assertCurrent();
        if (!config?.getService || !request.declaration) throw new ServiceStartRefusal('project_service_placement_unavailable');
        const selection = request.declaration.selection;
        const placement = await config.getService({ workspace: { serverId: runtime.serverId, refId: workspaceRefId },
            serviceName: selection.kind === 'manifest' ? selection.name : request.targetId });
        await assertCurrent();
        if (placement.status !== 'ready') throw new ServiceStartRefusal(`project_service_placement_${placement.status}`);
        const resolved = resolveProjectServiceStartChoice({ execution: service?.execution ?? 'primary', placement, invocation: request.choice });
        if (resolved.status === 'refused') throw new ServiceStartRefusal(resolved.reason);
        return { placement, choice: resolved.choice };
    }
    async function review(nativeInvocations: Set<ProjectNativeEffectCaptureForHost>, request: DaemonLocalServiceLauncherStartRequestV1, ingress?: RpcHandlerContext, context?: ActionContext,
        afterCopy = false, executeCanonicalAction?: CanonicalPoolRead,
        nativeCustody?: Pick<ReturnType<typeof createProjectNativeInvocationCustody>, 'retain'>): Promise<Review | SourceReview> {
        if (!ingress?.machineAdmission || !ingress.verifyMachineAdmissionCurrent) throw new ServiceStartRefusal('machine_admission_required');
        if (!context) throw new ServiceStartRefusal('project_service_action_context_unavailable');
        if (!request.workspace || !request.declaration) throw new ServiceStartRefusal('launcher_start_declaration_unavailable');
        const constrained = readProjectFiniteIngressRefusal(ingress);
        if (constrained) throw new ServiceStartRefusal(constrained.errorCode);
        const runtime = await input.resolveRuntime(ingress);
        if (!runtime) throw new ServiceStartRefusal('project_service_runtime_unavailable');
        const admission = ingress.machineAdmission;
        if (admission.machineId !== runtime.machineId || request.machineId !== runtime.machineId
            || request.workspace.serverId !== runtime.serverId
            || context.serverId && context.serverId !== runtime.serverId) throw new ServiceStartRefusal('target_mismatch');
        if (admission.actorAccountId !== runtime.accountId || admission.custodianAccountId !== runtime.accountId) throw new ServiceStartRefusal('project_requester_credentials_unavailable');
        const signal = context.signal ? AbortSignal.any([ingress.signal, context.signal]) : ingress.signal;
        const assertCurrent = async () => {
            if (signal.aborted) throw new ServiceStartRefusal('cancelled');
            if (!runtime.isCurrent || !await runtime.isCurrent()) throw new ServiceStartRefusal('project_requester_credentials_unavailable');
            if (!await ingress.verifyMachineAdmissionCurrent!()) throw new ServiceStartRefusal('machine_admission_changed');
            const eligibility = await runtime.workerAdmission.observeServiceEligibility();
            if (!eligibility.eligible) throw new ServiceStartRefusal(eligibility.reason ?? 'project_service_admission_unavailable');
            if (!await runtime.isCurrent()) throw new ServiceStartRefusal('project_requester_credentials_unavailable');
            if (signal.aborted) throw new ServiceStartRefusal('cancelled');
        };
        await assertCurrent();
        let association = await resolveProjectSetupAcceptedWorkspace({ address: request.workspace, ...projectRuntimeAccountRowsInput(runtime, 'localServices.launcher.start'),
            serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
        await assertCurrent();
        if (request.declaration.workspaceRefId !== association.workspace.id || request.workspaceId && request.workspaceId !== association.workspace.id) throw new ServiceStartRefusal('wrong_workspace');
        const sourceAssociation = association;
        const assertPlacement = async (choice: Extract<ProjectServiceStartChoice, { status: 'resolved' }>['choice']) => {
            await assertProjectReceivingPlacement({ choice, sourceMachineId: sourceAssociation.workspace.machineId,
                receivingMachineId: runtime.machineId, ...(executeCanonicalAction ? { readPool: async poolId => {
                    await assertCurrent();
                    const result = await executeCanonicalAction('machines.pools.get', { poolId });
                    await assertCurrent();
                    return result;
                } } : {}) });
        };
        let worker: SourceReview | undefined;
        if (association.workspace.machineId !== runtime.machineId) {
            if (!runtime.inspectSourceProjectManifest) throw new ServiceStartRefusal('project_source_declaration_unavailable');
            const snapshot = await runtime.inspectSourceProjectManifest({ source: association.workspace, signal });
            await assertCurrent();
            if (snapshot.document?.status === 'invalid') throw new ServiceStartRefusal('invalid_manifest');
            const manifest = snapshot.document?.manifest;
            const selection = request.declaration.selection;
            const service = selection.kind === 'manifest' ? manifest?.services?.[selection.name] : undefined;
            if (selection.kind === 'manifest' && !service) throw new ServiceStartRefusal('project_service_not_found');
            const { placement, choice } = await readChoice(runtime, request, ingress, context, association.workspace.id, service, assertCurrent);
            await assertPlacement(choice);
            if (request.targetId !== createProjectServiceDeclarationTargetIdV1(association.workspace, selection)) throw new ServiceStartRefusal('launcher_target_unknown');
            // Installed source inspection proves manifest commands. Target-native file effects need their own producer/review.
            if (!manifest || !service || service.source.kind !== 'command' || manifest.environment && manifest.environment.kind !== 'host') throw new ServiceStartRefusal('project_service_worker_effect_unavailable');
            const eligibility = await runtime.workerAdmission.observeServiceEligibility(manifest?.workspace?.memoryDemand);
            if (!eligibility.eligible) throw new ServiceStartRefusal(eligibility.reason ?? 'project_service_admission_unavailable');
            await assertCurrent();
            if (!runtime.resolveWorkerTarget || !runtime.prepareDequeue) throw new ServiceStartRefusal('workspace_sync_source_unavailable');
            const basis = await runtime.resolveWorkerTarget({ source: association.workspace, signal });
            await assertCurrent();
            if (basis.target.machineId !== runtime.machineId || digest(workspaceAddressFromRefV1(basis.source)) !== digest(workspaceAddressFromRefV1(association.workspace))
                || basis.source.projectKey !== association.workspace.projectKey
                || basis.target.projectKey !== association.workspace.projectKey) throw new ServiceStartRefusal('project_workspace_changed');
            const serviceEffect = { command: literalServiceCommand(service.source, basis.target.rootPath, platformFor(runtime).os),
                environment: { kind: 'host' }, configEnvironment: runtime.configEnvironment ?? {}, platform: platformFor(runtime) };
            const reviewedEffect = projectNativeJsonValueForTransport({ v: 1, purpose: 'service', declaration: request.declaration,
                source: { ...workspaceAddressFromRefV1(association.workspace), projectKey: association.workspace.projectKey },
                target: { ...workspaceAddressFromRefV1(basis.target), projectKey: basis.target.projectKey }, manifest, fileBasis: snapshot.basis, serviceEffect,
                route: basis.relationships.map(({ relationshipId, controllerMachineId, alphaWorkspaceRefId, betaWorkspaceRefId }) => ({ relationshipId, controllerMachineId, alphaWorkspaceRefId, betaWorkspaceRefId })),
                placement: placement.placement, choice, configEnvironment: runtime.configEnvironment ?? {}, platform: platformFor(runtime) });
            worker = { kind: 'source', runtime, basis, snapshot, manifest, choice, signal, reviewedEffect, reviewedEffectDigest: digest(reviewedEffect),
                placementEffectDigest: digest({ placement: placement.placement, choice }), serviceEffectDigest: digest(serviceEffect) };
            if (!afterCopy) return worker;
            association = await resolveProjectSetupAcceptedWorkspace({ address: { serverId: basis.target.serverId, machineId: basis.target.machineId,
                workspaceId: basis.target.id, rootPath: basis.target.rootPath }, ...projectRuntimeAccountRowsInput(runtime, 'localServices.launcher.start'),
                serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
            await assertCurrent();
        } else {
            const currentTargets = await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [association.workspace] });
            await assertCurrent();
            if (!currentTargets.some(target => 'declaration' in target && target.id === request.targetId && digest(target.declaration) === digest(request.declaration))) throw new ServiceStartRefusal('launcher_target_unknown');
        }
        const preparation: ProjectSetupPreparationInput = { workspace: association.workspace, projectAssociation: association,
            requester: { ...projectRuntimeAccountRowsInput(runtime, 'localServices.launcher.start'), serverHttpBaseUrl: runtime.serverHttpBaseUrl }, purpose: 'setup',
            platform: platformFor(runtime),
            nativeIo: runtime.nativeIo, signal,
            retainNativeInvocation: production => nativeCustody ? nativeCustody.retain(production) : nativeInvocations.add(production),
            ...(runtime.successHomeDir ? { successHomeDir: runtime.successHomeDir } : {}),
            ...(runtime.secretEnvironment ? { secretEnvironment: runtime.secretEnvironment } : {}),
            ...(runtime.configEnvironment ? { configEnvironment: runtime.configEnvironment } : {}),
            ...(runtime.plugins ? { plugins: runtime.plugins } : {}),
        };
        const prepared = await prepareProjectSetup(preparation);
        await assertCurrent();
        if (prepared.kind === 'refused') throw new ServiceStartRefusal(prepared.code);
        const plan = prepared.plan;
        const eligibility = await runtime.workerAdmission.observeServiceEligibility(plan.manifest?.workspace?.memoryDemand);
        if (!eligibility.eligible) throw new ServiceStartRefusal(eligibility.reason ?? 'project_service_admission_unavailable');
        await assertCurrent();
        if (worker && (digest(plan.fileBasis) !== digest(worker.snapshot.basis) || digest(plan.manifest) !== digest(worker.manifest))) throw new ServiceStartRefusal('project_service_effect_changed');
        const selection = request.declaration.selection;
        const service = selection.kind === 'manifest' ? plan.manifest?.services?.[selection.name] : undefined;
        const source: ProjectCommandSourceV1 | undefined = selection.kind === 'native' ? selection.source : service?.source;
        if (!source) throw new ServiceStartRefusal('project_service_not_found');
        const { placement, choice } = await readChoice(runtime, request, ingress, context, sourceAssociation.workspace.id, service, assertCurrent);
        if (worker && digest({ placement: placement.placement, choice }) !== worker.placementEffectDigest) throw new ServiceStartRefusal('project_service_effect_changed');
        await assertPlacement(choice);
        if (prepared.kind === 'pendingApproval' && !worker) throw new ServiceStartRefusal(prepared.code, {
            reviewedEffect: projectNativeJsonValueForTransport(prepared.plan.reviewedEffect), reviewedEffectDigest: prepared.plan.reviewedEffectDigest,
        });
        let command: SupportedServiceCommand;
        let nativeLifecycleLease: ProjectNativeAdapterLeaseV1 | undefined;
        let processMode: Review['processMode'] = service?.port
            ? { kind: 'managedSpawn', endpointDetection: { kind: 'detectAfterLaunch', minimumConfidence: 'high' } }
            : { kind: 'managedSpawn', endpointNone: true };
        if (source.kind === 'command') {
            command = literalServiceCommand(source, association.workspace.rootPath, preparation.platform.os);
        } else {
            let production: ProjectNativeAdapterProductionV1 | undefined;
            if (source.kind === 'pluginNative') {
                if (!runtime.plugins) throw new ServiceStartRefusal('native_service_instance_unavailable');
                const selected = await runtime.plugins.resolveProjectNativeAdapter(source.adapter, 'resolveCommand');
                if (selected.kind === 'refused') throw new ServiceStartRefusal(selected.code);
                nativeLifecycleLease = selected.lease;
                const acquired = selected.lease.acquireProduction({ root: association.workspace.rootPath,
                    environment: preparation.configEnvironment, signal });
                if (acquired.kind !== 'ready') throw new ServiceStartRefusal(acquired.code);
                production = acquired.production;
                preparation.retainNativeInvocation!(production);
            } else if (source.tool === 'compose' || source.tool === 'flox') {
                // A detached builtin needs a characterized resource codec, not an owned-child fallback.
                throw new ServiceStartRefusal('native_service_lifecycle_unsupported');
            }
            const resolved = await resolveProjectNativeCommand({ root: association.workspace.rootPath, source, usage: 'service', io: runtime.nativeIo, signal,
                ...(production ? { plugin: { lease: production } } : {}) });
            await assertCurrent();
            if (resolved.kind === 'refused') throw new ServiceStartRefusal(resolved.code);
            if (source.kind === 'native' && resolved.kind === 'resolved') command = { kind: 'native', source, resolution: resolved };
            else if (source.kind === 'pluginNative' && resolved.kind === 'pluginResolved' && production && nativeLifecycleLease) {
                const instance = resolved.command.nativeInstance;
                if (!instance) throw new ServiceStartRefusal('native_service_instance_unavailable');
                const captured = nativeLifecycleLease.captureNativeServiceLifecycle(instance);
                if (captured.kind !== 'ready') throw new ServiceStartRefusal(captured.code);
                const admittedLease = nativeLifecycleLease;
                const plugins = runtime.plugins;
                const resolveCurrentLifecycle = async () => {
                    if (admittedLease.isCurrent()) return captured.lifecycle;
                    if (!plugins) throw new ServiceStartRefusal('native_adapter_retired');
                    const current = await plugins.resolveProjectNativeAdapter(instance.adapter, 'nativeServiceLifecycle');
                    if (current.kind !== 'ready') throw new ServiceStartRefusal(current.code);
                    const recovery = current.lease.captureNativeServiceLifecycle(instance);
                    if (recovery.kind !== 'ready') throw new ServiceStartRefusal(recovery.code);
                    return recovery.lifecycle;
                };
                processMode = { kind: 'native', instance, lifecycle: {
                    async inspect(candidate, options) {
                        return (await resolveCurrentLifecycle()).inspect(candidate, options);
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
                            const observation = await current.inspect(candidate, options);
                            if (observation.phase === 'stopped') return { status: 'stopped' };
                            if (observation.phase !== 'running') return { status: 'termination_incomplete' };
                        } catch { return { status: 'termination_incomplete' }; }
                        return current.stop(candidate, options);
                    },
                } };
                command = { kind: 'pluginNative', source, resolution: resolved.command, lease: production };
            } else throw new ServiceStartRefusal('native_adapter_result_invalid');
        }
        if (worker && digest({ command, environment: plan.environment, configEnvironment: preparation.configEnvironment ?? {},
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
                const read = await readProjectDefinitionFileBytes(association.workspace.rootPath, file);
                await assertCurrent();
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
                nativeCommandEnvironment: command.resolution.environmentApplied }
            : { source: command.source, executable: portablePath(command.resolution.command),
                args: command.resolution.args.map(portablePath), cwd: portablePath(command.resolution.cwd),
                toolchain: command.resolution.toolchain, environmentOverlay: command.resolution.environmentOverlay,
                nativeCommandEnvironment: command.resolution.nativeCommandEnvironment };
        const reviewedEffect = projectNativeJsonValueForTransport({ v: 1, purpose: 'service', declaration: request.declaration,
            service, command: resolvedCommand, files: files.sort((a, b) => a.file.localeCompare(b.file)), setupEffectDigest: plan.reviewedEffectDigest,
            placement: placement.placement, choice, configEnvironment: plan.configEnvironment, platform: preparation.platform });
        const declaration = { ...request.declaration, workspaceRefId: association.workspace.id };
        return { kind: 'target', runtime, preparation, plan, declaration,
            serviceId: createProjectServiceDeclarationTargetIdV1(association.workspace, declaration.selection),
            setupNotRequired: prepared.kind === 'notRequired', ...(prepared.kind === 'pendingApproval' ? { setupReview: {
                code: prepared.code, reviewedEffect: projectNativeJsonValueForTransport(plan.reviewedEffect), reviewedEffectDigest: plan.reviewedEffectDigest } } : {}),
            command, processMode, ...(nativeLifecycleLease ? { nativeLifecycleLease } : {}), reviewedEffect: worker?.reviewedEffect ?? reviewedEffect,
            reviewedEffectDigest: worker?.reviewedEffectDigest ?? digest(reviewedEffect) };
    }

    async function reviewTarget(nativeInvocations: Set<ProjectNativeEffectCaptureForHost>, request: DaemonLocalServiceLauncherStartRequestV1, ingress?: RpcHandlerContext, context?: ActionContext, executeCanonicalAction?: CanonicalPoolRead,
        nativeCustody?: Pick<ReturnType<typeof createProjectNativeInvocationCustody>, 'retain'>): Promise<Review> {
        const result = await review(nativeInvocations, request, ingress, context, true, executeCanonicalAction, nativeCustody);
        if (result.kind !== 'target') throw new ServiceStartRefusal('project_service_effect_changed');
        return result;
    }

    async function resolveStartTarget(request: DaemonLocalServiceLauncherStartRequestV1, ingress?: RpcHandlerContext, context?: ActionContext, executeCanonicalAction?: CanonicalPoolRead): Promise<LocalServiceLauncherStartResolution<SelectedDeclaration>> {
        const nativeInvocations = new Set<ProjectNativeEffectCaptureForHost>();
        let uncertain = false;
        try {
            const current = await review(nativeInvocations, request, ingress, context, false, executeCanonicalAction);
            if (!request.expectedEffectDigest || request.expectedEffectDigest !== current.reviewedEffectDigest) return {
                ok: false, reasonCode: request.expectedEffectDigest ? 'project_service_effect_changed' : 'project_service_effect_review_required',
                reviewedEffect: current.reviewedEffect, reviewedEffectDigest: current.reviewedEffectDigest,
            };
            return { ok: true, declaration: { targetId: request.targetId, reviewedEffectDigest: current.reviewedEffectDigest } };
        } catch (error) {
            uncertain = isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeEnvironmentUncertainError;
            if (uncertain) throw error;
            return refusal(error);
        } finally { if (!uncertain) await Promise.all([...nativeInvocations].map(production => production.release())); }
    }

    async function startManagedDeclaration(selected: SelectedDeclaration, request: DaemonLocalServiceLauncherStartRequestV1, ingress?: RpcHandlerContext, context?: ActionContext, executeCanonicalAction?: CanonicalPoolRead): Promise<LocalServiceLauncherStartExecutionOutcome> {
        let lease: PluginRuntimeLease | undefined;
        const nativeInvocations = new Set<ProjectNativeEffectCaptureForHost>();
        let uncertain = false;
        try {
            if (selected.targetId !== request.targetId || selected.reviewedEffectDigest !== request.expectedEffectDigest) throw new ServiceStartRefusal('project_service_effect_changed');
            const initial = await review(nativeInvocations, request, ingress, context, false, executeCanonicalAction);
            const unchanged = (fresh: Pick<Review, 'reviewedEffect' | 'reviewedEffectDigest'>) => {
                if (fresh.reviewedEffectDigest !== selected.reviewedEffectDigest) throw new ServiceStartRefusal('project_service_effect_changed', fresh);
            };
            unchanged(initial);
            if (!ingress || !context || !request.declaration) throw new ServiceStartRefusal('machine_admission_required');
            const prepareCopy = async (signal: AbortSignal) => {
                if (initial.kind !== 'source') return;
                const eligibility = await initial.runtime.workerAdmission.observeServiceEligibility(initial.manifest.workspace?.memoryDemand);
                if (!eligibility.eligible) throw new ServiceStartRefusal(eligibility.reason ?? 'project_service_admission_unavailable');
                await initial.runtime.prepareDequeue!({ workspace: initial.basis.source, choice: initial.choice, basis: initial.basis, signal });
            };
            await prepareCopy(initial.kind === 'source' ? initial.signal : initial.preparation.signal!);
            let current = initial.kind === 'source' ? await reviewTarget(nativeInvocations, request, ingress, context, executeCanonicalAction) : initial;
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
                        ...(initial.kind === 'source' ? { relatedWorkspaces: initial.basis.relationships.flatMap(relationship => [
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
                                current = await reviewTarget(nativeInvocations, request, ingress, context, executeCanonicalAction);
                                unchanged(current);
                                while (current.setupReview) {
                                    if (!operation.operationReview) throw new ServiceStartRefusal(current.setupReview.code, current.setupReview);
                                    reservation.phase('setup');
                                    await operation.operationReview.waitForResume({ kind: 'pendingApproval', ...current.setupReview });
                                    // Resume the SAME accepted setup, under the original exact Sync basis and current source effect.
                                    const fresh = await review(nativeInvocations, request, ingress, context, false, executeCanonicalAction);
                                    unchanged(fresh);
                                    await prepareCopy(operationSignal);
                                    current = await reviewTarget(nativeInvocations, request, ingress, context, executeCanonicalAction);
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
            current = await reviewTarget(nativeInvocations, request, ingress, context, executeCanonicalAction);
            unchanged(current);
            if (current.setupReview) throw new ServiceStartRefusal(current.setupReview.code, current.setupReview);
            lease = await input.acquirePluginRuntime();
            const registry = lease.registry;
            // Project custody belongs to the stable daemon owner, not the registry projection
            // which supplied its port. Exact selected environment leases retain their own lifetime;
            // requester access loss is retired by the same owner's D19 cleanup.
            const isCurrent = () => (!current.plan.environmentAdapterLease || current.plan.environmentAdapterLease.isCurrent())
                && (!current.nativeLifecycleLease || current.nativeLifecycleLease.isCurrent());
            if (!isCurrent()) throw new ServiceStartRefusal('native_adapter_retired');
            const handle = await registry.projectManagedServices.superviseProject({ workspace: current.plan.workspace, declaration: current.declaration,
                cwd: current.command.kind === 'literal' ? current.command.cwd : current.command.resolution.cwd,
                requester: { serverId: current.runtime.serverId, accountId: ingress.machineAdmission!.actorAccountId,
                    machineId: ingress.machineAdmission!.machineId, installationId: ingress.machineAdmission!.installationId },
                serviceId: current.serviceId, specIdentity: selected.reviewedEffectDigest, signal: current.preparation.signal, isCurrent,
                processSpec: { mode: current.processMode, startupTimeoutMs: MANAGED_SERVICE_NUMERIC_CONTRACT.startupTimeoutMs.defaultValue },
                authorizeLaunch: async ({ signal }) => {
                    const launchInvocations = new Set<ProjectNativeEffectCaptureForHost>();
                    const nativeCustody = createProjectNativeInvocationCustody({ signal }, launchInvocations);
                    let launchUncertain = false;
                    let retained = false;
                    try {
                    current = await reviewTarget(launchInvocations, request, ingress, context, executeCanonicalAction, nativeCustody);
                    unchanged(current);
                    if (current.setupReview) throw new ServiceStartRefusal(current.setupReview.code, current.setupReview);
                    if (!isCurrent()) throw new ServiceStartRefusal('native_adapter_retired');
                    const launch = await authorizePreparedProjectCommand({ ...setupInput!, preparation: current.preparation }, current.plan, current.command, signal);
                    try {
                        const fresh = await reviewTarget(launchInvocations, request, ingress, context, executeCanonicalAction, nativeCustody);
                        unchanged(fresh);
                        if (fresh.setupReview) throw new ServiceStartRefusal(fresh.setupReview.code, fresh.setupReview);
                        if (!isCurrent() || signal.aborted) throw new ServiceStartRefusal('cancelled');
                        // The Project supervisor retains this final capture until
                        // its existing cleanup proves the owned process tree settled.
                        retained = true;
                        return { ...launch, async release() {
                            try { await launch.release(); }
                            finally { await nativeCustody.release({ waitForSettlement: false }); nativeCustody.dispose(); }
                        } };
                    } catch (error) {
                        if (!isProjectNativeProcessUncertain(error) && !(error instanceof ProjectNativeEnvironmentUncertainError)) await launch.release();
                        throw error;
                    }
                    } catch (error) {
                        launchUncertain = isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeEnvironmentUncertainError;
                        if (launchUncertain) uncertain = true;
                        throw error;
                    } finally { if (!launchUncertain && !retained) {
                        await nativeCustody.release();
                        nativeCustody.dispose();
                    } }
                },
            });
            return { status: 'succeeded', currentTarget: { kind: 'managed_service', managedServiceId: handle.instanceId,
                machineId: handle.workspace.machineId, workspaceId: handle.workspace.id, cwd: handle.cwd, declaration: handle.declaration } };
        } catch (error) { uncertain ||= isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeEnvironmentUncertainError;
            if (isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeEnvironmentUncertainError) throw error;
            const denied = refusal(error); return { status: 'denied', reasonCode: denied.reasonCode,
            ...(denied.reviewedEffect !== undefined ? { reviewedEffect: denied.reviewedEffect } : {}),
            ...(denied.reviewedEffectDigest ? { reviewedEffectDigest: denied.reviewedEffectDigest } : {}) }; }
        finally { if (!uncertain) await Promise.all([...nativeInvocations].map(production => production.release())); await lease?.release(); }
    }
    const restartManagedService: RestartProjectManagedService = async (request, handle, execution) => {
        if (!execution.prepareStartAction) return { status: 'denied', reasonCode: 'managed_service_restart_admission_required' };
        const start: DaemonLocalServiceLauncherStartRequestV1 = {
            machineId: handle.workspace.machineId, targetId: handle.serviceId,
            workspace: { serverId: handle.workspace.serverId, machineId: handle.workspace.machineId,
                workspaceId: handle.workspace.id, rootPath: handle.workspace.rootPath },
            declaration: handle.declaration,
            ...(request.expectedEffectDigest ? { expectedEffectDigest: request.expectedEffectDigest } : {}),
            ...(request.choice ? { choice: request.choice } : {}),
        };
        // Fresh source/effect/placement review precedes disruption. Stop never authorizes replacement.
        const selected = await resolveStartTarget(start, execution.ingress, execution.actionContext);
        if (!selected.ok) return { status: 'denied', reasonCode: selected.reasonCode,
            ...(selected.reviewedEffect !== undefined ? { reviewedEffect: selected.reviewedEffect } : {}),
            ...(selected.reviewedEffectDigest ? { reviewedEffectDigest: selected.reviewedEffectDigest } : {}) };
        // Start's required-result Action preparation completes its independent approval before
        // disruption. Its one-shot invocation still revalidates current admission when run.
        const prepared = await execution.prepareStartAction(start, execution.actionContext);
        if (prepared.kind === 'ready') {
            const signals = [execution.ingress?.signal, execution.actionContext.signal].filter((signal): signal is AbortSignal => signal !== undefined);
            const stopped = await stopProjectManagedService(handle, signals.length ? AbortSignal.any(signals) : undefined);
            if (stopped.status !== 'succeeded') return stopped;
        }
        const result = prepared.kind === 'settled' ? prepared.result : await prepared.invocation.run();
        if (!result.ok) return { status: 'denied', reasonCode: result.errorCode };
        const parsed = DaemonLocalServiceLauncherStartResponseV1Schema.safeParse(result.result);
        if (!parsed.success) return { status: 'failed', reasonCode: 'managed_service_restart_result_unavailable' };
        if (parsed.data.status === 'succeeded') return { status: 'succeeded' };
        return { status: parsed.data.status, reasonCode: parsed.data.reasonCode ?? 'managed_service_restart_failed',
            ...(parsed.data.reviewedEffect !== undefined ? { reviewedEffect: parsed.data.reviewedEffect } : {}),
            ...(parsed.data.reviewedEffectDigest ? { reviewedEffectDigest: parsed.data.reviewedEffectDigest } : {}) };
    };
    return { resolveStartTarget, startManagedDeclaration, restartManagedService };
}
