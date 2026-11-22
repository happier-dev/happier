import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { readDeploymentDatabaseRuntimeNameV1 } from '@happier-dev/deployments';
import type { DeploymentEnvironmentContentV1, DeploymentEnvironmentDetailV1, EnvironmentSecretBindingV1 } from '@happier-dev/deployments/contracts/v1';
import { configuration } from '@/configuration';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { assertOwnServerDataQuerySupportedEngine } from './dataRoleGuard';

const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };

function refuseUnconfirmedNativeDataService(observation: 'service' | 'container'): never {
    const code = 'service_unavailable';
    const reason = observation === 'service' ? 'mounted_service_unconfirmed' : 'native_container_unconfirmed';
    throw new PluginError({
        code,
        details: projectDeploymentFailureRecoveryV1({ reason }, code),
        failureCause: { phase: `deployment.data.${observation}`, errorClass: 'Error', errorCode: code, httpStatus: null },
    });
}

/** Template provenance supplies the logical data identity; the runtime owner below
 * proves that this exact declaration is the current admitted native service. */
export function resolveOwnServerDataServiceDeclarationForHost(content: DeploymentEnvironmentContentV1, service: string) {
    const template = content.template;
    const candidates = template?.data?.filter(row => row.service === service) ?? [];
    if (!template?.services.includes(service) || candidates.length !== 1) return refuse('target_mismatch');
    const data = candidates[0]!;
    const engine = data.engine === 'postgres' ? 'postgresql' as const : data.engine;
    if (engine !== 'postgresql' && engine !== 'mysql' && engine !== 'mariadb') return refuse('unsupported_action');
    assertOwnServerDataQuerySupportedEngine(engine);
    return { engine, data };
}

export function resolveOwnServerDataQueryDefinitionForHost(content: DeploymentEnvironmentContentV1, service: string,
    runtimeBindings: readonly EnvironmentSecretBindingV1[] = content.bindings) {
    const { engine, data } = resolveOwnServerDataServiceDeclarationForHost(content, service);
    const database = readDeploymentDatabaseRuntimeNameV1(data, runtimeBindings);
    if (database === null) return refuse('deployment_invalid');
    return { engine, database, service, ...(data.port ? { port: data.port } : {}) };
}

export type OwnServerDataServiceHost = Pick<OwnServerDeploymentTargetHostInput,
    'serverId' | 'machineId' | 'readEnvironment' | 'readReceipt'> & Readonly<{
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    ensureServiceObservations?: import('@/plugins/runtime/invocation/services/environmentServiceRecovery').EnsureEnvironmentServices;
}>;
export type OwnServerDataServiceSelector = Readonly<{
    environmentId: string; expectedRevision: number; targetLinkId: string; deploymentId: string;
    machineId: string; installationId: string; service: string;
    /** The data-role binding to acquire: the reader (default) or the bounded writer (P3 R14). */
    role?: 'readOnlyPassword' | 'write';
}>;

type DataEnvironment = Pick<DeploymentEnvironmentDetailV1, 'environment' | 'content'> & Readonly<{
    targetLinks: readonly Pick<DeploymentEnvironmentDetailV1['targetLinks'][number], 'targetLink'>[];
}>;

/** Discovery and execution consume the same active deployment identity. */
export async function readOwnServerDataServiceDeploymentForHost(host: OwnServerDataServiceHost,
    selector: Omit<OwnServerDataServiceSelector, 'expectedRevision' | 'service'>,
    context: ActionExecutorContext, environment: DataEnvironment) {
    const link = environment.targetLinks.find(item => item.targetLink.id === selector.targetLinkId)?.targetLink;
    if (environment.environment.id !== selector.environmentId
        || environment.environment.runtimeTargetLinkId !== selector.targetLinkId || !link || link.targetKind !== 'ownServer'
        || link.activeDeploymentId !== selector.deploymentId
        || !link.members.some(member => member.machineId === selector.machineId && member.installationId === selector.installationId)) return refuse('target_mismatch');
    const receipt = await host.readReceipt({ environmentId: selector.environmentId, deploymentId: selector.deploymentId, context });
    const basis = receipt.content.ownServer?.approvedInputBasis;
    if (receipt.deployment.id !== selector.deploymentId || receipt.deployment.environmentId !== selector.environmentId
        || receipt.deployment.targetLinkId !== selector.targetLinkId || !basis
        || !basis.members.some(member => member.machineId === selector.machineId && member.installationId === selector.installationId)) return refuse('target_mismatch');
    return { receipt, basis };
}

/** Exact indexed mounted-service acquisition, shared by reviewed role bootstrap
 * and query. Native labels and neighboring services never supply authority. */
export async function acquireOwnServerDataServiceForHost(host: OwnServerDataServiceHost,
    selector: OwnServerDataServiceSelector, context: ActionExecutorContext,
    preparedEnvironment?: DataEnvironment) {
    const environment = preparedEnvironment ?? await host.readEnvironment({ environmentId: selector.environmentId,
        targetLinkId: selector.targetLinkId, context });
    if (environment.environment.revision !== selector.expectedRevision) return refuse('target_mismatch');
    const { basis } = await readOwnServerDataServiceDeploymentForHost(host, selector, context, environment);
    if (!basis.services.includes(selector.service)) return refuse('target_mismatch');
    const definition = resolveOwnServerDataQueryDefinitionForHost(environment.content, selector.service, basis.bindings);
    const role = selector.role ?? 'readOnlyPassword';
    const use = environment.content.bindings.find(binding => binding.purpose === 'dataRole'
        && 'service' in binding && binding.service === selector.service && binding.role === role);
    if (!use || use.purpose !== 'dataRole') return refuse(role === 'write' ? 'write_role_setup_required' : 'read_role_setup_required');
    await host.ensureServiceObservations?.({ environmentId: selector.environmentId, composeService: selector.service });
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
            || handle.readNativeRuntimeFacts?.().freshness !== 'current') return refuseUnconfirmedNativeDataService('service');
        await handle.release.assertCurrent();
        const containers = handle.readNativeContainers?.();
        // The current mounted owner proves native identity after cold restore too.
        // Its optional activation comparison is not a data-operation prerequisite.
        if (containers?.length !== 1 || containers[0]!.service !== selector.service
            || containers[0]!.composeProject !== projection.physicalProjectName) return refuseUnconfirmedNativeDataService('container');
        context.signal?.throwIfAborted();
        return { environment, definition, use, handle, containerId: containers[0]!.id, dispose: () => lease!.release() };
    } catch (error) { await lease?.release(); throw error; }
}
