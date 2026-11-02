import type { DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { configuration } from '@/configuration';
import { authorizePluginExecLaunchForHost, readPluginExecProcessCustodyForHost } from '@/plugins/runtime/invocation/services/exec';
import { produceEnvironmentProjectServices } from '@/daemon/local/services/launch/projectDeclarations';
import { readColdNativeComposeTargetsForHost } from '@/daemon/local/services/launch/nativeComposeDiscovery';
import { readNativeComposeEngine } from '@/daemon/local/services/launch/nativeComposeEngine';
import { resolveNativeComposeCandidateProjectName } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { createOwnServerNativeRuntime } from './nativeRuntime';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { createOwnServerSourceCustodyReader } from './sourceProvenance';
import { observeRetainedDeploymentSourceForHost } from './exactCommitRelease';

export type RestoreOwnServerDeploymentServicesInput = Readonly<{
    serverId: string;
    machineId: string;
    installationId: string;
    receipt: DeploymentReceiptDetailV1;
    owner: Pick<ReturnType<typeof createManagedServicesOwner>, 'superviseProject' | 'resolveEnvironmentService'>;
    signal: AbortSignal;
    isCurrent(): boolean;
    readReceipt?(deploymentId: string): Promise<DeploymentReceiptDetailV1>;
}>;

/** Restore observations only. The receipt supplies definition/source custody;
 * the same cold native read as logs supplies surviving container identities. */
export async function restoreOwnServerDeploymentServices(input: RestoreOwnServerDeploymentServicesInput): Promise<void> {
    const { receipt } = input;
    const basis = receipt.content.ownServer?.approvedInputBasis;
    if (!basis) throw Object.assign(new Error('Retained runtime definition is unavailable'), { code: 'deployment_source_unavailable' });
    const projection = basis.runtimeProjections?.find(value => value.machineId === input.machineId
        && value.installationId === input.installationId) ?? (basis.runtimeProjections ? undefined : basis);
    if (!projection || !basis.members.some(value => value.machineId === input.machineId
        && value.installationId === input.installationId)) {
        throw Object.assign(new Error('Retained runtime definition is unavailable'), { code: 'deployment_source_unavailable' });
    }
    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
        serverId: input.serverId, environmentId: receipt.deployment.environmentId });
    const serviceIdentity = (composeService: string) => ({ kind: 'deployment' as const, machineId: input.machineId,
        environmentId: identity.environmentId, environmentInstanceId: identity.environmentInstanceId, composeService,
        serviceId: `${identity.environmentInstanceId}/${composeService}` });
    if (projection.services.every(service => input.owner.resolveEnvironmentService(identity.homeServerIdentityId,
        serviceIdentity(service))?.deploymentId === receipt.deployment.id)) return;
    const assertCurrent = async () => {
        input.signal.throwIfAborted();
        if (!input.isCurrent()) throw Object.assign(new Error('Service observation is unavailable'), { code: 'service_unavailable' });
    };
    await assertCurrent();
    const custody = createOwnServerSourceCustodyReader({ ...identity, machineId: input.machineId,
        installationId: input.installationId, assertCurrent,
        history: (async function* () { yield receipt; })(),
        ...(input.readReceipt ? { readIncumbentReceipt: fact => input.readReceipt!(fact.restorationForDeploymentId ?? fact.sourceDeploymentId) } : {}) });
    const runtime = createOwnServerNativeRuntime({ cwd: configuration.happyHomeDir, signal: input.signal,
        isCurrent: input.isCurrent });
    let launch: Awaited<ReturnType<typeof authorizePluginExecLaunchForHost>> | undefined;
    let references = 1;
    const release = async () => {
        if (--references !== 0) return;
        try { await launch?.release(); await runtime.settleNative(); }
        finally { await readPluginExecProcessCustodyForHost(runtime.exec).requestStop(); }
    };
    try {
        const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose',
            cwd: configuration.happyHomeDir, signal: input.signal });
        launch = await authorizePluginExecLaunchForHost(runtime.exec, { executable: tool.executable, args: [],
            cwd: configuration.happyHomeDir }, { signal: input.signal });
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
            if (!targets) throw Object.assign(new Error('Native service inventory is unavailable'), { code: 'service_unavailable' });
            if (targets.some(Boolean)) generations.push({ projectName, targets });
        }
        if (generations.length > 1) throw Object.assign(new Error('Native service generation is ambiguous'), { code: 'deployment_conflict' });
        const generation = generations[0];
        // A removed generation has no native resources to observe. Retained
        // source alone never manufactures an executable service generation.
        if (!generation) return;
        const { projectName, targets } = generation;
        const target = targets.find(value => value !== null);
        if (targets.some(value => value && (value.sourcePath !== target?.sourcePath || value.project !== target?.project))) {
            throw Object.assign(new Error('Native service generation is ambiguous'), { code: 'deployment_conflict' });
        }
        const sourcePath = target!.sourcePath;
        const source = await custody(sourcePath);
        if (!source) throw Object.assign(new Error('Retained source is unavailable'), { code: 'deployment_source_unavailable' });
        const releaseSource = observeRetainedDeploymentSourceForHost({ environmentId: identity.environmentId,
            environmentInstanceId: identity.environmentInstanceId, deploymentId: receipt.deployment.id,
            machineId: input.machineId, installationId: input.installationId, rootPath: source.rootPath,
            manifestFingerprint: projection.manifestFingerprint, manifest: source.manifest,
            async assertCurrent() {
                await assertCurrent();
                if (!await custody(sourcePath)) throw Object.assign(new Error('Retained source is unavailable'), { code: 'deployment_source_unavailable' });
            } });
        const composeArgs = ['compose', '--project-name', projectName];
        await produceEnvironmentProjectServices({ owner: input.owner, serverId: identity.homeServerIdentityId,
            release: releaseSource, specIdentity: receipt.deployment.id, signal: input.signal, isCurrent: input.isCurrent,
            nativeEffects: { keys: [{ kind: 'composeProject', dockerEndpoint: engine.id, projectName }], settleNative: runtime.settleNative },
            io: runtime.nativeIo, project: { composeArgs,
                services: projection.services.filter((_, index) => targets[index] !== null),
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
    } finally { await release(); }
}
