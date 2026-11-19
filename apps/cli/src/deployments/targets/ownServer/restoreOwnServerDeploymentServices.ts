import { createActionExecuteFailureError, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { EnvironmentServiceRecoveryRow } from '@/plugins/runtime/invocation/services/environmentServiceRecovery';
import type { DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import type { createManagedServicesOwner, EnvironmentProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { configuration } from '@/configuration';
import { authorizePluginExecLaunchForHost, readPluginExecProcessCustodyForHost } from '@/plugins/runtime/invocation/services/exec';
import { produceEnvironmentProjectServices } from '@/daemon/local/services/launch/projectDeclarations';
import { readColdNativeComposeTargetsForHost } from '@/daemon/local/services/launch/nativeComposeDiscovery';
import { readNativeComposeEngine, retainNativeDockerContainerRemoval } from '@/daemon/local/services/launch/nativeComposeEngine';
import { resolveNativeComposeCandidateProjectName } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { createOwnServerNativeRuntime } from './nativeRuntime';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { createOwnServerSourceCustodyReader } from './sourceProvenance';
import { observeRetainedDeploymentSourceForHost } from './exactCommitRelease';
import type { NativeDockerEngineFacts } from '@happier-dev/cli-common/machineSetup';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

export type RestoreOwnServerDeploymentServicesInput = Readonly<{
    serverId: string;
    machineId: string;
    installationId: string;
    receipt: DeploymentReceiptDetailV1;
    owner: Pick<ReturnType<typeof createManagedServicesOwner>, 'superviseProject' | 'resolveEnvironmentService'>;
    signal: AbortSignal;
    isCurrent(): boolean;
    readReceipt?(deploymentId: string): Promise<DeploymentReceiptDetailV1>;
    observeServices?(input: Readonly<{ homeServerIdentityId: string;
        handles: readonly EnvironmentProjectManagedServiceHandle[] }>): void;
    restoreServiceReferences?(input: Readonly<{ docker: ProjectNativeDockerPort; engine: NativeDockerEngineFacts;
        onFailure(failure: ActionExecuteFailure | null): void }>): Promise<Readonly<{ close(): Promise<void> }>>;
}>;

/** Restore observations only. The receipt supplies definition/source custody;
 * the same cold native read as logs supplies surviving container identities. */
export async function restoreOwnServerDeploymentServices(input: RestoreOwnServerDeploymentServicesInput): Promise<readonly EnvironmentServiceRecoveryRow[]> {
    const { receipt } = input;
    const basis = receipt.content.ownServer?.approvedInputBasis;
    if (!basis) throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_source_unavailable', error: 'Retained runtime definition is unavailable' });
    const projection = basis.runtimeProjections?.find(value => value.machineId === input.machineId
        && value.installationId === input.installationId) ?? (basis.runtimeProjections ? undefined : basis);
    if (!projection || !basis.members.some(value => value.machineId === input.machineId
        && value.installationId === input.installationId)) {
        throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_source_unavailable', error: 'Retained runtime definition is unavailable' });
    }
    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
        serverId: input.serverId, environmentId: receipt.deployment.environmentId });
    const serviceIdentity = (composeService: string) => ({ kind: 'deployment' as const, machineId: input.machineId,
        environmentId: identity.environmentId, environmentInstanceId: identity.environmentInstanceId, composeService,
        serviceId: `${identity.environmentInstanceId}/${composeService}` });
    const existingHandles = projection.services.map(service => input.owner.resolveEnvironmentService(identity.homeServerIdentityId,
        serviceIdentity(service)));
    if (existingHandles.every(handle => handle?.deploymentId === receipt.deployment.id)) return [];
    const assertCurrent = async () => {
        input.signal.throwIfAborted();
        if (!input.isCurrent()) throw createActionExecuteFailureError({ ok: false, errorCode: 'service_unavailable', error: 'Service observation is unavailable' });
    };
    await assertCurrent();
    const custody = createOwnServerSourceCustodyReader({ ...identity, machineId: input.machineId,
        installationId: input.installationId, assertCurrent,
        history: (async function* () { yield receipt; })(),
        ...(input.readReceipt ? { readIncumbentReceipt: fact => input.readReceipt!(fact.restorationForDeploymentId ?? fact.sourceDeploymentId) } : {}) });
    const runtime = createOwnServerNativeRuntime({ cwd: configuration.happyHomeDir, signal: input.signal,
        isCurrent: input.isCurrent });
    let launch: Awaited<ReturnType<typeof authorizePluginExecLaunchForHost>> | undefined;
    let serviceReferences: Readonly<{ close(): Promise<void> }> | undefined;
    const consumers: Awaited<ReturnType<typeof produceEnvironmentProjectServices>>[number][] = [];
    const failures: EnvironmentServiceRecoveryRow[] = [];
    const unavailable = (services: readonly string[], error: unknown) => {
        input.signal.throwIfAborted();
        const failureCause = projectActionFailureCauseV1(error, 'service.restoration');
        for (const composeService of services) {
            const service = serviceIdentity(composeService);
            failures.push({ identity: service, serviceId: service.serviceId, name: composeService,
                authority: 'project', lifecyclePurpose: 'deployment', environmentId: identity.environmentId,
                generation: null, state: 'unknown', unavailableReason: 'unavailable', failureCause,
                deployment: { deploymentId: receipt.deployment.id, installationId: input.installationId, service },
                health: { status: 'unknown', observedAtMs: null, freshness: 'unavailable',
                    ...(failureCause.errorCode ? { reason: failureCause.errorCode } : {}) },
                capabilities: { exec: false, start: false, stop: false, restart: false, logs: false, accounting: false } });
        }
    };
    let referenceFailure: ActionExecuteFailure | undefined;
    let references = 1;
    const release = async () => {
        if (--references !== 0) return;
        try { try { await serviceReferences?.close(); } finally { await launch?.release(); await runtime.settleNative(); } }
        finally { await readPluginExecProcessCustodyForHost(runtime.exec).requestStop(); }
    };
    try {
        const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose',
            cwd: configuration.happyHomeDir, signal: input.signal });
        launch = await authorizePluginExecLaunchForHost(runtime.exec, { executable: tool.executable, args: [],
            cwd: configuration.happyHomeDir }, { agentIsolation: null, signal: input.signal });
        const tuple = launch;
        const run = (args: readonly string[]) => runtime.nativeIo.run({ command: tuple.command,
            args: [...tuple.args, ...args], cwd: tuple.cwd!, env: tuple.env, signal: input.signal });
        const engine = await readNativeComposeEngine({ io: runtime.nativeIo, command: tuple.command, prefix: tuple.args,
            cwd: tuple.cwd!, env: tuple.env, signal: input.signal });
        const generations = [];
        for (const projectName of new Set([projection.physicalProjectName,
            resolveNativeComposeCandidateProjectName(projection.physicalProjectName, receipt.deployment.id)])) {
            // Compose can serve this receipt with a container retained from an
            // earlier release. Native source identity comes from its working
            // directory; custody below resolves that exact source receipt.
            const targets = await readColdNativeComposeTargetsForHost({ ...identity, projectName,
                composeServices: projection.services, run });
            if (!targets) throw createActionExecuteFailureError({ ok: false, errorCode: 'service_unavailable', error: 'Native service inventory is unavailable' });
            if (targets.some(Boolean)) generations.push({ projectName, targets });
        }
        if (generations.length > 1) throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_conflict', error: 'Native service generation is ambiguous' });
        const generation = generations[0];
        // A removed generation has no native resources to observe. Retained
        // source alone never manufactures an executable service generation.
        if (!generation) return [];
        serviceReferences = await input.restoreServiceReferences?.({ engine,
            onFailure(failure) { referenceFailure = failure ?? undefined; for (const consumer of consumers) consumer.reportDependencyFailure?.(failure); },
            docker: { engineId: engine.id,
                removeOwnedContainer: retainNativeDockerContainerRemoval({ command: tuple.command, prefix: tuple.args,
                    cwd: tuple.cwd!, env: tuple.env }),
                async run(args) { const result = await run(args); return { ...result, exitCode: result.exitCode ?? -1 }; } } });
        const { projectName, targets } = generation;
        // Compose may retain an unchanged service from an earlier source while
        // creating another service from the current one. Each source is proven
        // by the same retained-receipt custody owner before it is observed.
        const servicesBySource = new Map<string, string[]>();
        for (const [index, service] of projection.services.entries()) {
            const target = targets[index];
            if (!target) continue;
            const services = servicesBySource.get(target.sourcePath) ?? [];
            services.push(service);
            servicesBySource.set(target.sourcePath, services);
        }
        for (const [sourcePath, services] of servicesBySource) {
            try {
                const source = await custody(sourcePath);
                if (!source) throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_source_unavailable', error: 'Retained source is unavailable' });
                const releaseSource = observeRetainedDeploymentSourceForHost({ environmentId: identity.environmentId,
                    environmentInstanceId: identity.environmentInstanceId, deploymentId: receipt.deployment.id,
                    machineId: input.machineId, installationId: input.installationId, rootPath: source.rootPath,
                    manifestFingerprint: projection.manifestFingerprint, manifest: source.manifest,
                    async assertCurrent() {
                        await assertCurrent();
                        if (!await custody(sourcePath)) throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_source_unavailable', error: 'Retained source is unavailable' });
                    } });
                const composeArgs = ['compose', '--project-name', projectName];
                const handles = await produceEnvironmentProjectServices({ owner: input.owner, serverId: identity.homeServerIdentityId,
                    appliedServiceExports: basis.ownServer?.serviceExports,
                    release: releaseSource, specIdentity: receipt.deployment.id, signal: input.signal, isCurrent: input.isCurrent,
                    recovery: true,
                    nativeEffects: { keys: [{ kind: 'composeProject', dockerEndpoint: engine.id, projectName }], settleNative: runtime.settleNative },
                    io: runtime.nativeIo, project: { composeArgs,
                        services,
                        nativeIdsForService: service => targets[projection.services.indexOf(service)]?.containerIds ?? [],
                        // Retain structural facts from the exact cold native read,
                        // without reconstructing the secret-bearing activation render.
                        nativeFactsForService(service) {
                            const configuration = targets[projection.services.indexOf(service)]?.configuration;
                            return configuration ? { configuration, containerImages: [] } : undefined;
                        },
                        authorizeServiceObserver() {
                            references += 1;
                            let released = false;
                            return { ...tuple, args: [...tuple.args, ...composeArgs], async release() {
                                if (released) return;
                                released = true;
                                await release();
                            } };
                        } } });
                consumers.push(...handles);
                if (referenceFailure) for (const handle of handles) handle.reportDependencyFailure?.(referenceFailure);
            } catch (error) { unavailable(services, error); }
        }
    } catch (error) {
        unavailable(projection.services.filter(service => !consumers.some(handle => handle.composeService === service)
            && !failures.some(row => row.identity?.kind === 'deployment' && row.identity.composeService === service)), error);
    } finally { await release(); }
    const restored = consumers.filter(handle => !existingHandles.includes(handle));
    if (restored.length) input.observeServices?.({ homeServerIdentityId: identity.homeServerIdentityId, handles: restored });
    return failures;
}
