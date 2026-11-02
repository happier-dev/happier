import { isIP } from 'node:net';
import { MachineServicesListResultV1Schema, RPC_METHODS, type MachineServiceRowV1 } from '@happier-dev/protocol';
import { accessProviderRefsEqualV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { OwnServerDeploymentRuntimeHostInput } from './ownServerDeploymentHostRuntime';
import type { OwnServerDeploymentRuntimeAcquisition, OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';

type ResolveInput = Parameters<NonNullable<OwnServerDeploymentRuntimeAcquisition['secrets']['resolveNonSecret']>>[0];
const unavailable = (): never => { throw Object.assign(new Error('reference_unavailable'), { code: 'reference_unavailable' }); };

/** Resolves only declared service exports, from the retained service owner and
 * P21's current network observations. A scalar endpoint is never a private fact. */
export async function resolvePrivateServiceReferenceForHost(input: Readonly<{
    source: Extract<ResolveInput, { kind: 'reference' }>;
    environment: Awaited<ReturnType<OwnServerDeploymentTargetHostInput['readEnvironment']>>;
    readEnvironment?: OwnServerDeploymentTargetHostInput['readEnvironment'];
    host: OwnServerDeploymentRuntimeHostInput;
    context: Parameters<OwnServerDeploymentTargetHostInput['readEnvironment']>[0]['context'];
    actionId: string; signal: AbortSignal;
    owner: OwnServerDeploymentRuntimeAcquisition['projectManagedServices'];
    homeServerIdentityId: string; installationId: string; privateKey: Uint8Array;
}>): Promise<string> {
    const { source, host, signal } = input;
    signal.throwIfAborted();
    const sameEnvironment = source.environmentId === input.environment.environment.id;
    const environment = sameEnvironment ? input.environment : input.readEnvironment
        ? await input.readEnvironment({ environmentId: source.environmentId, context: input.context }) : unavailable();
    const exported = environment.content.ownServer?.serviceExports?.find(item => item.key === source.export);
    if (!exported) return unavailable();
    // Compose owns service DNS within this Environment's native project.
    if (sameEnvironment && source.via === 'auto') return `${exported.scheme}://${exported.service}:${exported.containerPort}`;
    if (source.via === 'public' || exported.exposure !== 'privateNetwork' || !exported.privateNetwork) return unavailable();
    const link = environment.targetLinks.find(item => item.targetLink.id === environment.environment.runtimeTargetLinkId)?.targetLink;
    if (!link?.activeDeploymentId) return unavailable();
    const authorization = input.context.externalActionExecutionAuthorization;
    const readMachine = (machineId: string) => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => authorization
        ? ApiClient.getRequesterMachine(machineId, { authorization, signal, effectActionId: input.actionId })
        : ApiClient.create(host.credentials).then(api => api.getMachine(machineId, { signal })));
    const consumer = await readMachine(host.machineId);
    const observerNetworks = consumer?.daemonState?.reachability?.privateNetworks ?? [];
    const urls = new Set<string>();
    for (const member of link.members) {
        if (member.state !== 'active') continue;
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
            if (row.environmentId !== source.environmentId || row.deployment?.deploymentId !== link.activeDeploymentId
                || row.deployment.installationId !== member.installationId || row.deployment.service.composeService !== exported.service
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
    if (urls.size !== 1) return unavailable();
    return [...urls][0]!;
}
