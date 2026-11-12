import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { DeploymentEnvironmentContentV1, DeploymentEnvironmentDetailV1, EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { configuration } from '@/configuration';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { assertOwnServerDataQuerySupportedEngine } from './dataQuery';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Template provenance supplies the logical data identity; the runtime owner below
 * proves that this exact declaration is the current admitted native service. */
export function resolveOwnServerDataServiceDeclarationForHost(content: DeploymentEnvironmentContentV1, service: string) {
    const template = content.template;
    const candidates = template?.data?.filter(row => row.service === service) ?? [];
    if (!template?.services.includes(service) || candidates.length !== 1) return refuse('target_mismatch');
    const data = candidates[0]!;
    const engine = data.engine === 'postgres' ? 'postgresql' : data.engine;
    if (engine !== 'postgresql' && engine !== 'mysql' && engine !== 'mariadb') return refuse('unsupported_action');
    assertOwnServerDataQuerySupportedEngine(engine);
    return { engine, data };
}

export function resolveOwnServerDataQueryDefinitionForHost(content: DeploymentEnvironmentContentV1, service: string,
    runtimeBindings: readonly EnvironmentSecretBindingV1[] = content.bindings) {
    const { engine, data } = resolveOwnServerDataServiceDeclarationForHost(content, service);
    const key = data.variables?.database ?? data.logicalBackup?.database;
    const binding = key ? runtimeBindings.find(row => row.purpose === 'variable' && row.phase === 'runtime' && row.name === key) : undefined;
    if (binding?.purpose !== 'variable' || binding.source.kind !== 'value' || !binding.source.value) return refuse('deployment_invalid');
    return { engine, database: binding.source.value, service, ...(data.port ? { port: data.port } : {}) };
}

export type OwnServerDataServiceHost = Pick<OwnServerDeploymentTargetHostInput,
    'serverId' | 'machineId' | 'readEnvironment' | 'readReceipt'> & Readonly<{
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    ensureServiceObservations?(): Promise<void>;
}>;
export type OwnServerDataServiceSelector = Readonly<{
    environmentId: string; expectedRevision: number; targetLinkId: string; deploymentId: string;
    machineId: string; installationId: string; service: string;
}>;

/** Exact indexed mounted-service acquisition, shared by reviewed role bootstrap
 * and query. Native labels and neighboring services never supply authority. */
export async function acquireOwnServerDataServiceForHost(host: OwnServerDataServiceHost,
    selector: OwnServerDataServiceSelector, context: ActionExecutorContext,
    preparedEnvironment?: Pick<DeploymentEnvironmentDetailV1, 'environment' | 'content'> & Readonly<{ targetLinks: readonly Pick<DeploymentEnvironmentDetailV1['targetLinks'][number], 'targetLink'>[] }>) {
    const environment = preparedEnvironment ?? await host.readEnvironment({ environmentId: selector.environmentId,
        targetLinkId: selector.targetLinkId, context });
    const link = environment.targetLinks.find(item => item.targetLink.id === selector.targetLinkId)?.targetLink;
    if (environment.environment.id !== selector.environmentId || environment.environment.revision !== selector.expectedRevision
        || environment.environment.runtimeTargetLinkId !== selector.targetLinkId || !link || link.targetKind !== 'ownServer'
        || link.activeDeploymentId !== selector.deploymentId
        || !link.members.some(member => member.machineId === selector.machineId && member.installationId === selector.installationId)) return refuse('target_mismatch');
    const receipt = await host.readReceipt({ environmentId: selector.environmentId, deploymentId: selector.deploymentId, context });
    const basis = receipt.content.ownServer?.approvedInputBasis;
    if (receipt.deployment.id !== selector.deploymentId || receipt.deployment.environmentId !== selector.environmentId
        || receipt.deployment.targetLinkId !== selector.targetLinkId || !basis || !basis.services.includes(selector.service)
        || !basis.members.some(member => member.machineId === selector.machineId && member.installationId === selector.installationId)) return refuse('target_mismatch');
    const definition = resolveOwnServerDataQueryDefinitionForHost(environment.content, selector.service, basis.bindings);
    const use = environment.content.bindings.find(binding => binding.purpose === 'dataRole'
        && 'service' in binding && binding.service === selector.service && binding.role === 'readOnlyPassword');
    if (!use || use.purpose !== 'dataRole') return refuse('read_role_setup_required');
    await host.ensureServiceObservations?.();
    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
        serverId: host.serverId, environmentId: selector.environmentId });
    const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
    try {
        const handle = lease?.registry.projectManagedServices.resolveEnvironmentService(identity.homeServerIdentityId, {
            kind: 'deployment', machineId: selector.machineId, environmentId: selector.environmentId,
            environmentInstanceId: identity.environmentInstanceId, composeService: selector.service,
            serviceId: `${identity.environmentInstanceId}/${selector.service}`,
        });
        const projection = basis.runtimeProjections?.find(row => row.machineId === selector.machineId
            && row.installationId === selector.installationId) ?? basis;
        if (!handle || !handle.isCurrent() || handle.retirementSignal.aborted || handle.deploymentId !== selector.deploymentId
            || handle.release.deploymentId !== selector.deploymentId || handle.release.environmentId !== selector.environmentId
            || handle.release.manifestFingerprint !== projection.manifestFingerprint
            || handle.readNativeRuntimeFacts?.().freshness !== 'current') return refuse('service_unavailable');
        await handle.release.assertCurrent();
        const containers = handle.readNativeContainers?.();
        if (containers?.length !== 1 || containers[0]!.service !== selector.service
            || containers[0]!.composeProject !== projection.physicalProjectName || containers[0]!.configurationMatches !== true) return refuse('service_unavailable');
        context.signal?.throwIfAborted();
        return { environment, definition, use, handle, containerId: containers[0]!.id, dispose: () => lease!.release() };
    } catch (error) { await lease?.release(); throw error; }
}
