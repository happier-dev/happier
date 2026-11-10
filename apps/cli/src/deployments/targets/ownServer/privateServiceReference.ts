import { isIP } from 'node:net';
import { MachineServicesListResultV1Schema, RPC_METHODS, type MachineServiceRowV1 } from '@happier-dev/protocol';
import { accessProviderRefsEqualV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { TcpTunnelServiceExportBindingV1Schema, type TcpTunnelServiceExportBindingV1 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import type { DeploymentServiceExportV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { OwnServerDeploymentRuntimeHostInput } from './ownServerDeploymentHostRuntime';
import type { OwnServerDeploymentRuntimeAcquisition, OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';
import { privateServiceForwardAcquisitionError } from '../../deploymentFailure';

type ResolveInput = Parameters<NonNullable<OwnServerDeploymentRuntimeAcquisition['secrets']['resolveNonSecret']>>[0];
const unavailable = (): never => { throw Object.assign(new Error('reference_unavailable'), { code: 'reference_unavailable' }); };

/** Resolves only declared service exports, from the retained service owner and
 * P21's current network observations. A scalar endpoint is never a private fact. */
export type PrivateServiceReferenceHostInput = Readonly<{
    source: Extract<ResolveInput, { kind: 'reference' }>;
    environment: Awaited<ReturnType<OwnServerDeploymentTargetHostInput['readEnvironment']>>;
    readEnvironment?: OwnServerDeploymentTargetHostInput['readEnvironment'];
    host: OwnServerDeploymentRuntimeHostInput;
    context: Parameters<OwnServerDeploymentTargetHostInput['readEnvironment']>[0]['context'];
    actionId: string; signal: AbortSignal;
    owner: OwnServerDeploymentRuntimeAcquisition['projectManagedServices'];
    homeServerIdentityId: string; installationId: string; privateKey: Uint8Array;
    /** Exact destination selector used by B's local admission adapter. */
    targetMachineId?: string;
}>;

export type PrivateServiceExportAdmissionForHost =
    | Readonly<{ kind: 'compose' | 'privateNetwork'; url: string }>
    | Readonly<{ kind: 'iroh'; machineId: string; scheme: string; serviceExport: TcpTunnelServiceExportBindingV1 }>;

export type PrivateServiceAppliedExportHostInput = Readonly<{
    kind: 'applied'; exportKey: string; machineId: string; installationId: string;
    exports: readonly DeploymentServiceExportV1[]; row: MachineServiceRowV1; signal: AbortSignal;
}>;

/** The same occurrence selector consumes A's authored declaration or B's applied declaration. */
function selectIrohExport(exported: DeploymentServiceExportV1 | undefined, row: MachineServiceRowV1,
    expected: Readonly<{ environmentId: string; machineId: string; installationId: string }>):
    Extract<PrivateServiceExportAdmissionForHost, { kind: 'iroh' }> | null {
    if (!exported || exported.transport?.kind !== 'iroh' || exported.exposure !== 'loopback' || exported.privateNetwork !== undefined
        || row.environmentId !== expected.environmentId || row.deployment?.installationId !== expected.installationId
        || row.deployment.service.machineId !== expected.machineId || row.deployment.service.environmentId !== expected.environmentId
        || row.deployment.service.composeService !== exported.service || row.health?.freshness !== 'current'
        || row.health.status === 'down' || row.native?.phase !== 'running') return null;
    const ports = (row.configuration?.ports ?? []).filter(port => Number(port.target) === exported.containerPort && port.protocol === 'tcp');
    if (ports.length !== 1) return null;
    const port = ports[0]!;
    const binding = TcpTunnelServiceExportBindingV1Schema.safeParse({
        exportKey: exported.key, ...row.deployment, generation: row.generation,
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
    const { source, host, signal } = input;
    const sameEnvironment = source.environmentId === input.environment.environment.id;
    const environment = sameEnvironment ? input.environment : input.readEnvironment
        ? await input.readEnvironment({ environmentId: source.environmentId, context: input.context }) : unavailable();
    const exported = environment.content.ownServer?.serviceExports?.find(item => item.key === source.export);
    if (!exported) return unavailable();
    // Compose owns service DNS within this Environment's native project.
    if (sameEnvironment && source.via === 'auto') return { kind: 'compose', url: `${exported.scheme}://${exported.service}:${exported.containerPort}` };
    const iroh = exported.transport?.kind === 'iroh';
    if (source.via === 'public' || (iroh ? exported.exposure !== 'loopback' || exported.privateNetwork !== undefined
        : exported.exposure !== 'privateNetwork' || !exported.privateNetwork)) return unavailable();
    const link = environment.targetLinks.find(item => item.targetLink.id === environment.environment.runtimeTargetLinkId)?.targetLink;
    if (!link) return unavailable();
    const authorization = input.context.externalActionExecutionAuthorization;
    const readMachine = (machineId: string) => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => authorization
        ? ApiClient.getRequesterMachine(machineId, { authorization, signal, effectActionId: input.actionId })
        : ApiClient.create(host.credentials).then(api => api.getMachine(machineId, { signal })));
    const consumer = await readMachine(host.machineId);
    const observerNetworks = consumer?.daemonState?.reachability?.privateNetworks ?? [];
    const urls = new Set<string>();
    const forwards: Extract<PrivateServiceExportAdmissionForHost, { kind: 'iroh' }>[] = [];
    for (const member of link.members) {
        if (member.state !== 'active' || input.targetMachineId && member.machineId !== input.targetMachineId) continue;
        const machine = member.machineId === host.machineId ? consumer : await readMachine(member.machineId);
        if (machine?.installationId !== member.installationId) continue;
        const networks = machine.daemonState?.reachability?.privateNetworks ?? [];
        let rows: readonly MachineServiceRowV1[];
        if (member.machineId === host.machineId) {
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
            const result = MachineServicesListResultV1Schema.parse(await callExactMachineRpc({ credentials,
                serverUrl: host.serverHttpBaseUrl, machineId: member.machineId, method: RPC_METHODS.MACHINES_SERVICE_LIST,
                request: { serverId: host.serverId, machineId: member.machineId, environmentId: source.environmentId }, signal, requireCurrentMachine: true,
                ...(authorization ? { externalAction: { context: input.context, effectActionId: 'machines.services.list',
                    installationId: input.installationId, privateKey: input.privateKey } } : {}) }));
            rows = result.kind === 'snapshot' ? result.services : [];
        }
        for (const row of rows) {
            if (iroh) {
                const admitted = selectIrohExport(exported, row, { environmentId: source.environmentId,
                    machineId: member.machineId, installationId: member.installationId });
                if (admitted) forwards.push(admitted);
                continue;
            }
            if (row.environmentId !== source.environmentId || row.deployment?.installationId !== member.installationId
                || row.deployment.service.composeService !== exported.service
                || row.health?.freshness !== 'current' || row.health.status === 'down'
                || row.native?.phase !== 'running') continue;
            for (const network of networks) {
                if (network.state !== 'ready' || network.networkIdentity !== exported.privateNetwork
                    || !observerNetworks.some(observer => observer.state === 'ready' && observer.networkIdentity === network.networkIdentity
                        && accessProviderRefsEqualV1(observer.provider, network.provider))) continue;
                for (const address of network.addresses) {
                    const family = isIP(address);
                    if (!family || address === '::1' || address.startsWith('127.') || address === '0.0.0.0' || address === '::') continue;
                    for (const port of row.configuration?.ports ?? []) {
                        const published = typeof port.published === 'number' ? port.published : Number(port.published);
                        if (Number(port.target) !== exported.containerPort || port.protocol !== 'tcp'
                            || !Number.isInteger(published) || published < 1 || published > 65535
                            || port.bindAddress !== address) continue;
                        urls.add(`${exported.scheme}://${family === 6 ? `[${address}]` : address}:${published}`);
                    }
                }
            }
        }
    }
    if (iroh) return forwards.length === 1 ? forwards[0]! : unavailable();
    if (urls.size !== 1) return unavailable();
    return { kind: 'privateNetwork', url: [...urls][0]! };
}

export async function resolvePrivateServiceReferenceForHost(input: PrivateServiceReferenceHostInput): Promise<string> {
    const material = await resolvePrivateServiceReferenceMaterialForHost(input);
    return typeof material === 'string' ? material : material.value;
}

/** The existing Environment materializer receives the address and its actual route together. */
export async function resolvePrivateServiceReferenceMaterialForHost(input: PrivateServiceReferenceHostInput & Readonly<{
    acquireForward?: (admission: Extract<PrivateServiceExportAdmissionForHost, { kind: 'iroh' }>) =>
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
    if (admission.kind !== 'iroh') return project(admission.url);
    if (!input.acquireForward) return unavailable();
    const forward = await input.acquireForward(admission).catch(error => { throw privateServiceForwardAcquisitionError(error); });
    const address = input.materializeForwardAddress ? await input.materializeForwardAddress(forward) : forward;
    return { value: project(`${admission.scheme}://${address.host}:${address.port}`),
        route: { kind: 'iroh', observedPath: forward.observedPath,
            ...('networkId' in address && address.networkId ? { containerNetworkId: address.networkId } : {}) } };
}
