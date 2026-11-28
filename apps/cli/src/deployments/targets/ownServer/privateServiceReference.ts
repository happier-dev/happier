import { isIPv6 } from 'node:net';
import { createActionExecuteFailureError, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope, readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import type { ServiceExportMachineForward } from '@/daemon/peer/iroh/serviceExportMachineForward';
import { MachineServicesListResultV1Schema, type MachineServiceRowV1 } from '@happier-dev/protocol/actions/specs/machine/services';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readSharedPrivateNetworkAddresses } from '@/machines/reachability/sharedPrivateNetworkAddresses';
import { TcpTunnelServiceExportBindingV1Schema, type TcpTunnelServiceExportBindingV1 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import type { DeploymentServiceExportV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, DEPLOYMENT_REFERENCE_READ_CHILD_ROLE_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { OwnServerDeploymentRuntimeHostInput } from './ownServerDeploymentHostRuntime';
import type { OwnServerDeploymentRuntimeAcquisition, OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';
import { privateServiceForwardAcquisitionError } from '../../deploymentFailure';

type ResolveInput = Parameters<NonNullable<OwnServerDeploymentRuntimeAcquisition['secrets']['resolveNonSecret']>>[0];
const unavailable = (): never => { throw Object.assign(createActionExecuteFailureError({ ok: false, errorCode: 'reference_unavailable', error: 'reference_unavailable' }), { failureCause: projectActionFailureCauseV1({ code: 'service_export_unavailable' }, 'deployment.reference.resolve') }); };

/** Resolves only declared service exports, from the retained service owner and
 * P21's current network observations. A scalar endpoint is never a private fact. */
export type PrivateServiceReferenceHostInput = Readonly<{
    source: Extract<ResolveInput, { kind: 'reference' }>;
    environment: Awaited<ReturnType<OwnServerDeploymentTargetHostInput['readEnvironment']>>;
    readEnvironment?: OwnServerDeploymentTargetHostInput['readEnvironment'];
    host: Pick<OwnServerDeploymentRuntimeHostInput, 'credentials' | 'machineId' | 'serverHttpBaseUrl' | 'serverId' | 'acquireServiceExportForward' | 'ensureServiceObservations'>;
    context: Parameters<OwnServerDeploymentTargetHostInput['readEnvironment']>[0]['context'];
    actionId: string; signal: AbortSignal;
    owner: OwnServerDeploymentRuntimeAcquisition['projectManagedServices'];
    homeServerIdentityId: string; installationId: string; privateKey: Uint8Array;
    /** Exact destination selector used by B's local admission adapter. */
    targetMachineId?: string;
    /** Cold recovery restores the transport already embedded in the consumer. */
    retainedRoute?: 'iroh' | 'local';
}>;

export type PrivateServiceExportAdmissionForHost =
    | Readonly<{ kind: 'compose'; url: string }>
    | Readonly<{ kind: 'privateNetwork'; url: string; networkIdentity: string }>
    | Readonly<{ kind: 'iroh'; machineId: string; scheme: string; serviceExport: TcpTunnelServiceExportBindingV1 }>
    | Readonly<{ kind: 'local'; machineId: string; scheme: string; containerPort: number;
        serviceExport: Omit<TcpTunnelServiceExportBindingV1, 'destination'> & Readonly<{ destination: Readonly<{ host: string; port: number }> }> }>;

export type PrivateServiceAppliedExportHostInput = Readonly<{
    kind: 'applied'; exportKey: string; machineId: string; installationId: string;
    exports: readonly DeploymentServiceExportV1[]; row: MachineServiceRowV1; signal: AbortSignal;
}>;

/** The same occurrence selector consumes A's authored declaration or B's applied declaration. */
function selectIrohExport(exported: DeploymentServiceExportV1 | undefined, row: MachineServiceRowV1,
    expected: Readonly<{ environmentId: string; machineId: string; installationId: string }>):
    Extract<PrivateServiceExportAdmissionForHost, { kind: 'iroh' }> | null {
    if (!exported || exported.transport?.kind !== 'iroh' || (exported.exposure !== 'loopback' && exported.exposure !== 'privateNetwork')
        || row.environmentId !== expected.environmentId || row.deployment?.installationId !== expected.installationId
        || row.deployment.service.machineId !== expected.machineId || row.deployment.service.environmentId !== expected.environmentId
        || row.deployment.service.composeService !== exported.service || row.health?.freshness !== 'current'
        || row.health.status === 'down' || row.native?.phase !== 'running') return null;
    const ports = (row.configuration?.ports ?? []).filter(port => Number(port.target) === exported.containerPort && port.protocol === 'tcp'
        && TcpTunnelServiceExportBindingV1Schema.shape.destination.shape.host.safeParse(port.bindAddress).success);
    if (ports.length !== 1) return null;
    const port = ports[0]!;
    const binding = TcpTunnelServiceExportBindingV1Schema.safeParse({
        exportKey: exported.key, ...row.deployment, generation: row.serviceExportGeneration,
        destination: { host: port.bindAddress, port: Number(port.published) },
    });
    return binding.success ? { kind: 'iroh', machineId: expected.machineId, scheme: exported.scheme, serviceExport: binding.data } : null;
}

/** Select the export and its actual current managed occurrence once, for both
 * forward acquisition and the destination daemon's signed-binding verifier. */
export async function resolvePrivateServiceExportAdmissionForHost(input: PrivateServiceReferenceHostInput | PrivateServiceAppliedExportHostInput): Promise<PrivateServiceExportAdmissionForHost> {
    input.signal.throwIfAborted();
    if ('kind' in input) {
        return selectIrohExport(input.exports.find(exported => exported.key === input.exportKey), input.row,
            { environmentId: input.row.environmentId ?? '', machineId: input.machineId, installationId: input.installationId }) ?? unavailable();
    }
    const binding = input.context.externalActionExecutionAuthorization?.binding;
    if (!binding || input.source.environmentId === input.environment.environment.id) return readPrivateServiceExportAdmissionForHost(input);
    // The decrypted saved binding selects the operand. The existing private
    // child issuer carries it through metadata, content and Machine codec reads.
    const action = DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1;
    const role = DEPLOYMENT_REFERENCE_READ_CHILD_ROLE_V1;
    const result = await invokeHostReviewedChildV1({
        parent: { actionId: binding.actionId, input: { serverId: input.homeServerIdentityId, environmentId: input.environment.environment.id } },
        context: input.context,
        child: { action, role, input: { serverId: input.homeServerIdentityId, environmentId: input.source.environmentId } },
        admittedReview: { action, role, surface: input.context.surface ?? 'cli' }, environmentId: input.source.environmentId,
        execute: async (_childInput, context) => readPrivateServiceExportAdmissionForHost({ ...input, context }),
    });
    if ('ok' in result) throw Object.assign(createActionExecuteFailureError({ ok: false, errorCode: result.errorCode, error: result.errorCode }), { cause: result });
    return result;
}

async function readPrivateServiceExportAdmissionForHost(input: PrivateServiceReferenceHostInput): Promise<PrivateServiceExportAdmissionForHost> {
    const { source, host, signal } = input;
    const sameEnvironment = source.environmentId === input.environment.environment.id;
    const environment = sameEnvironment ? input.environment : input.readEnvironment
        ? await input.readEnvironment({ environmentId: source.environmentId, context: input.context }) : unavailable();
    const exported = environment.content.ownServer?.serviceExports?.find(item => item.key === source.export);
    if (!exported) return unavailable();
    // Compose owns service DNS within this Environment's native project.
    if (sameEnvironment && source.via === 'auto') return { kind: 'compose', url: `${exported.scheme}://${exported.service}:${exported.containerPort}` };
    const iroh = exported.transport?.kind === 'iroh';
    const network = exported.exposure === 'privateNetwork' && exported.privateNetwork !== undefined;
    if (source.via === 'public' || (!iroh && !network)) return unavailable();
    const link = environment.targetLinks.find(item => item.targetLink.id === environment.environment.runtimeTargetLinkId)?.targetLink;
    if (!link) return unavailable();
    const authorization = input.context.externalActionExecutionAuthorization;
    const api = authorization ? undefined : await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => ApiClient.create(host.credentials));
    const readMachine = (machineId: string) => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => authorization
        ? ApiClient.getRequesterMachine(machineId, { authorization, signal, effectActionId: input.actionId })
        : api!.getMachine(machineId, { signal }));
    const consumer = readMachine(host.machineId);
    const selectedMembers = link.members.filter(member => member.state === 'active'
        && (!input.targetMachineId || member.machineId === input.targetMachineId));
    const [observer, memberRows] = await Promise.all([consumer, Promise.all(selectedMembers.map(async member => {
        const machine = await (member.machineId === host.machineId ? consumer : readMachine(member.machineId));
        if (machine?.installationId !== member.installationId) return null;
        const networks = machine.daemonState?.reachability?.privateNetworks ?? [];
        let rows: readonly MachineServiceRowV1[];
        if (member.machineId === host.machineId) {
            await host.ensureServiceObservations?.({ environmentId: source.environmentId, composeService: exported.service });
            const environmentInstanceId = resolveOwnServerDeploymentEnvironmentInstanceIdForHost(input.homeServerIdentityId, source.environmentId);
            const handle = input.owner.resolveEnvironmentService(input.homeServerIdentityId, { kind: 'deployment', machineId: member.machineId,
                environmentId: source.environmentId, environmentInstanceId, composeService: exported.service,
                serviceId: `${environmentInstanceId}/${exported.service}` });
            rows = handle ? [input.owner.machineServiceRows.read(handle)] : [];
        } else {
            // Preserve the original requester and signed Action carrier. Never
            // fall back to daemon Account authority for an external invocation.
            const credentials = authorization ? readRequesterAccountActionContext(authorization)?.credentials : host.credentials;
            if (!credentials) return unavailable();
            const reply = readMachineActionRpcResult(await callExactMachineRpc({ credentials,
                serverUrl: host.serverHttpBaseUrl, machineId: member.machineId, method: RPC_METHODS.MACHINES_SERVICE_LIST,
                request: { serverId: input.homeServerIdentityId, machineId: member.machineId, environmentId: source.environmentId }, signal, requireCurrentMachine: true,
                ...(authorization ? { externalAction: { context: input.context, effectActionId: RPC_METHODS.MACHINES_SERVICE_LIST,
                    installationId: input.installationId, privateKey: input.privateKey } } : {}) }));
            const failure = readActionFailureEnvelope(reply);
            if (failure) throw createActionExecuteFailureError(failure);
            const result = MachineServicesListResultV1Schema.parse(reply);
            rows = result.kind === 'snapshot' ? result.services : [];
        }
        return { member, networks, rows };
    }))]);
    const observerNetworks = observer?.daemonState?.reachability?.privateNetworks ?? [];
    const networkAdmissions = new Map<string, Extract<PrivateServiceExportAdmissionForHost, { kind: 'local' | 'privateNetwork' }>>();
    const forwards: Extract<PrivateServiceExportAdmissionForHost, { kind: 'iroh' | 'local' }>[] = [];
    for (const result of memberRows) {
        if (!result) continue;
        const { member, networks, rows } = result;
        for (const row of rows) {
            if (iroh) {
                const admitted = selectIrohExport(exported, row, { environmentId: source.environmentId,
                    machineId: member.machineId, installationId: member.installationId });
                if (admitted) forwards.push(member.machineId === host.machineId
                    ? { ...admitted, kind: 'local', containerPort: exported.containerPort } : admitted);
            }
            if (!network || input.retainedRoute !== undefined) continue;
            if (row.environmentId !== source.environmentId || row.deployment?.installationId !== member.installationId
                || row.deployment.service.composeService !== exported.service
                || row.health?.freshness !== 'current' || row.health.status === 'down'
                || row.native?.phase !== 'running') continue;
            for (const { address, family } of readSharedPrivateNetworkAddresses({ observer: observerNetworks,
                target: networks, networkIdentity: exported.privateNetwork })) {
                for (const port of row.configuration?.ports ?? []) {
                    const published = typeof port.published === 'number' ? port.published : Number(port.published);
                    if (Number(port.target) !== exported.containerPort || port.protocol !== 'tcp'
                        || !Number.isInteger(published) || published < 1 || published > 65535
                        || port.bindAddress !== address) continue;
                    const url = `${exported.scheme}://${family === 6 ? `[${address}]` : address}:${published}`;
                    networkAdmissions.set(url, member.machineId === host.machineId ? { kind: 'local',
                        machineId: member.machineId, scheme: exported.scheme, containerPort: exported.containerPort, serviceExport: {
                            ...row.deployment, exportKey: exported.key, generation: row.generation,
                            destination: { host: address, port: published },
                        } } : { kind: 'privateNetwork', url, networkIdentity: exported.privateNetwork! });
                }
            }
        }
    }
    if (input.retainedRoute === undefined && network && networkAdmissions.size === 1)
        return networkAdmissions.values().next().value!;
    // Explicit network references keep exact-network semantics. Loopback-only
    // Iroh exports retain their existing privateNetwork reference syntax.
    if (iroh && (source.via === 'auto' || !network || input.retainedRoute !== undefined))
        return forwards.length === 1 ? forwards[0]! : unavailable();
    return unavailable();
}

export async function resolvePrivateServiceReferenceForHost(input: PrivateServiceReferenceHostInput): Promise<string> {
    const material = await resolvePrivateServiceReferenceMaterialForHost(input);
    return typeof material === 'string' ? material : material.value;
}

/** The existing Environment materializer receives the address and its actual route together. */
export async function resolvePrivateServiceReferenceMaterialForHost(input: PrivateServiceReferenceHostInput & Readonly<{
    acquireForward?: (admission: Extract<PrivateServiceExportAdmissionForHost, { kind: 'iroh' | 'local' }>) =>
        Promise<import('@/daemon/peer/iroh/serviceExportMachineForward').ServiceExportMachineForward>;
    materializeForwardAddress?: (forward: import('@/daemon/peer/iroh/serviceExportMachineForward').ServiceExportMachineForward) =>
        Promise<Readonly<{ host: string; port: number; networkId?: string }>>;
}>): Promise<string | Readonly<{ value: string; route: NonNullable<import('@happier-dev/protocol/deployments/deploymentReadsV1').DeploymentReferenceAddressV1['route']> }>> {
    const admission = await resolvePrivateServiceExportAdmissionForHost(input);
    const project = (url: string) => {
        if (!input.source.component) return url;
        // Exports carry explicit ports. A neutral URL scheme preserves ports
        // that HTTP's URL normalization would otherwise omit (such as 80).
        const address = new URL(url.replace(/^[^:]+:/, 'tcp:'));
        return input.source.component === 'host' ? address.hostname : address.port;
    };
    if (admission.kind === 'compose') return project(admission.url);
    if (admission.kind === 'privateNetwork') return { value: project(admission.url),
        route: { kind: 'privateNetwork', networkIdentity: admission.networkIdentity } };
    const forward = await (input.acquireForward ? input.acquireForward(admission)
        : acquirePrivateServiceReferenceForwardForHost(admission, async () => unavailable())).catch(error => { throw privateServiceForwardAcquisitionError(error); });
    const address = input.materializeForwardAddress ? await input.materializeForwardAddress(forward) : forward;
    return { value: project(`${admission.scheme}://${isIPv6(address.host) ? `[${address.host}]` : address.host}:${address.port}`),
        route: { ...(admission.kind === 'local' ? { kind: 'local' as const } : { kind: 'iroh' as const, observedPath: forward.observedPath }),
            ...('networkId' in address && address.networkId ? { containerNetworkId: address.networkId } : {}) } };
}

/** Local selection borrows the native publication; only remote selections acquire a carrier. */
export async function acquirePrivateServiceReferenceForwardForHost(
    admission: Extract<PrivateServiceExportAdmissionForHost, { kind: 'iroh' | 'local' }>,
    acquireRemote: (admission: Extract<PrivateServiceExportAdmissionForHost, { kind: 'iroh' }>) => Promise<ServiceExportMachineForward>,
): Promise<ServiceExportMachineForward> {
    if (admission.kind === 'local') return { host: admission.serviceExport.destination.host,
        port: admission.serviceExport.destination.port, observedPath: 'direct', async close() {} };
    return acquireRemote(admission);
}
