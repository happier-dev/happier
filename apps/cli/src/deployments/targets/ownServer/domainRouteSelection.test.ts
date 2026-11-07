import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { Server as TcpServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { isRecord } from '@happier-dev/protocol/common/records';
import { checkMachineSetupEffectPlan, nativeCaddyImage, observeNativeCaddyContainer, type MachineSetupNativeCommandResult,
    type NativeCaddyObservationResult } from '@happier-dev/cli-common/machineSetup';
import type { MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { ExternalActionDaemonDispatcher } from '../../../../../server/sources/app/api/socket/externalActionDispatcher';
import { DeploymentDomainHeaderV1Schema, DeploymentDomainListResultV1Schema,
    type NativeCaddyRoutePlacement } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDomainTopologyV1Schema, DeploymentDomainAddAdmissionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentActionInputSchemasV1, DeploymentDomainChildRpcV1Schema, DeploymentDomainMachineTopologyV1Schema,
    DeploymentEnvironmentGetResultV1Schema, DeploymentChildRpcV1Schema, createActionExecutor, getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentDomainContentV1Schema, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import * as installationStore from '@/daemon/identity/store';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import type { ClientToServerEvents } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import type { DeploymentArtifactDocumentV1, DeploymentDomainContentV1 } from '@happier-dev/deployment-protocol';
import { createNativeCaddyRoutes, createNativeCaddyAdminExchange } from '@/machines/reachability/nativeCaddyRoutes';
import { materializeCaddyDomainRouteV1, type CaddyDomainRouteInput } from './caddyRouteMaterialization';
import { selectEdgeCaddyDomainRoute, selectPrivateCaddyOriginNetwork, selectDomainCaddyPlacements,
    readDomainCaddyStartFirstLegs } from './domainRouteSelection';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createDeploymentSourceMaterializationPort } from './exactCommitRelease';
import { createScmBackendRegistry } from '@/scm/registry';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { resolveInstalledMachineEffectCli } from '@/machines/adminAccess/runElevatedEffect';
import { settleMachineCaddyFirewallForHost } from '@/machines/reachability/machineReachabilityHost';
import { MachineEffectInternalRequestSchema, MachineEffectInternalRecordSchema } from '@/machines/setup/effectInternalProtocol';
import type { MachineElevationSpawn } from '@/machines/adminAccess/runElevatedEffect';
import { MachineReachabilityPostureV1Schema } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { observeOwnDaemonReachability } from '@/machines/reachability/observeOwnDaemonReachability';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { projectSettledApprovalExecution } from '@happier-dev/protocol/actions/executor/approvalResults';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';

const roots: string[] = [], servers: Server[] = [];
const nativeDocker = new Map<string, ProjectNativeDockerPort>();
const unavailableAdmin = new Set<string>();
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    nativeDocker.clear();
    unavailableAdmin.clear();
});
const network = (address: string): MachinePrivateNetworkObservationV1 => ({ provider: { kind: 'builtin', id: 'tailscale' },
    networkIdentity: 'tailnet-a', interfaceName: 'tailscale0', addresses: [address], sourceRanges: ['100.64.0.0/10'],
    displayName: null, dnsName: null, magicDnsEnabled: false, state: 'ready' });
const ok = (stdout: string): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });

/** Docker is the system boundary; mounted seed and live Unix HTTP are real. */
async function observed(address: string, port: number, edge = false,
    installed: readonly CaddyDomainRouteInput[] = [], containerNetwork: Readonly<{
        name?: string; address?: string | null; additionalPorts?: readonly number[];
    }> = {}, produced?: ReturnType<NonNullable<ReturnType<typeof createOwnServerDeploymentRuntimeForHost>['prepareDomainCaddy']>>): Promise<NativeCaddyObservationResult> {
    const root = await mkdtemp('/tmp/hde-'); roots.push(root);
    const seed = produced?.status === 'ready' ? JSON.parse(produced.input.initialConfig)
        : { admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' } };
    await writeFile(join(root, 'seed.json'), JSON.stringify(seed));
    const nativeServers: Record<string, { listen: string[]; automatic_https?: { disable: true };
        tls_connection_policies?: unknown[]; routes: unknown[]; errors: { routes: unknown[] } }> = {
        private_app: { listen: [port, ...(containerNetwork.additionalPorts ?? [])].map(port => `:${port}`),
            automatic_https: { disable: true }, routes: [], errors: { routes: [] } },
        ...(edge ? { public_app: { listen: [':443'], tls_connection_policies: [{}], routes: [], errors: { routes: [] } },
            public_app_http: { listen: [':80'], automatic_https: { disable: true as const }, routes: [], errors: { routes: [] } } } : {}),
    };
    const tls = { certificates: { load_pem: [] as unknown[] }, automation: { policies: [] as unknown[] } };
    for (const route of installed) {
        const material = materializeCaddyDomainRouteV1(route);
        const nativeServer = nativeServers[route.listener === 'privateOrigin' ? 'private_app' : 'public_app']!;
        nativeServer.routes.push(material.route);
        if (material.fallbackRoute) nativeServer.errors.routes.push(material.fallbackRoute);
        if (material.tls) {
            nativeServer.tls_connection_policies!.push(material.tls.connectionPolicy);
            nativeServers.public_app_http!.routes.push(material.tls.redirectRoute);
            if (material.tls.certificate) tls.certificates.load_pem.push(material.tls.certificate);
            if (material.tls.automationPolicy) tls.automation.policies.push(material.tls.automationPolicy);
        }
    }
    const config = produced ? seed : { ...seed, apps: { http: { servers: nativeServers }, tls } };
    const server = createServer((request, response) => {
        if (unavailableAdmin.has(join(root, 'admin.sock'))) { response.writeHead(503).end('{}'); return; }
        if (produced && request.method !== 'GET') {
            void (async () => {
                let body = ''; for await (const chunk of request) body += String(chunk);
                const path = request.url!.slice('/config/'.length).split('/').filter(Boolean).map(decodeURIComponent);
                let parent = config;
                for (const key of path.slice(0, -1)) parent = Reflect.get(parent, key);
                const key = path.at(-1)!;
                if (request.method === 'PUT' && Array.isArray(parent)) parent.splice(Number(key), 0, JSON.parse(body));
                else if (request.method === 'PUT') Reflect.set(parent, key, JSON.parse(body));
                else throw new Error(`Unexpected native method ${request.method}`);
                response.end('{}');
            })().catch(error => { response.writeHead(500).end(); throw error; });
            return;
        }
        expect(request.method).toBe('GET');
        let value: unknown = config;
        for (const segment of request.url!.slice('/config/'.length).split('/').filter(Boolean)) {
            value = value && typeof value === 'object' ? Reflect.get(value, decodeURIComponent(segment)) : undefined;
        }
        response.statusCode = value === undefined ? 404 : 200;
        response.setHeader('Content-Type', 'application/json'); response.setHeader('Etag', '"observed-generation"');
        response.end(JSON.stringify(value));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(root, 'admin.sock'), resolve); });
    servers.push(server);
    const container = { Id: `caddy-${address}`, Name: '/owned-caddy',
        Config: { Image: nativeCaddyImage, Cmd: ['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json'],
            Labels: { 'dev.happier.machine-setup.recipe': 'caddy@1' } }, State: { Running: true },
        HostConfig: { NetworkMode: containerNetwork.name ?? 'exact_generation', RestartPolicy: { Name: 'unless-stopped' }, Binds: null, Mounts: [
            { Type: 'bind', Source: root, Target: '/run/happier-caddy' },
            { Type: 'bind', Source: join(root, 'seed.json'), Target: '/etc/caddy/happier.json' },
        ] }, NetworkSettings: { Networks: { [containerNetwork.name ?? 'exact_generation']:
            containerNetwork.address === null ? {} : { IPAddress: containerNetwork.address ?? '172.18.0.2' } }, Ports: {
            [`${port}/tcp`]: [{ HostIp: address, HostPort: String(port + 100) }],
            ...(edge ? { '443/tcp': [{ HostIp: '203.0.113.7', HostPort: '8443' }] } : {}),
        } } };
    if (produced?.status === 'ready') {
        container.NetworkSettings.Ports = Object.fromEntries((produced.input.publicBindings ?? []).map(binding => [
            `${binding.containerPort ?? binding.hostPort}/tcp`, [{ HostIp: binding.hostAddress, HostPort: String(binding.hostPort) }],
        ]));
    }
    nativeDocker.set(join(root, 'admin.sock'), { engineId: 'engine-a', async run(args) {
        if (args.includes('ls')) return { exitCode: 0, stdout: JSON.stringify(container.Id), stderr: '' };
        if (args.includes('inspect')) return { exitCode: 0, stdout: JSON.stringify([container]), stderr: '' };
        throw new Error(`Domain add cannot mutate the healthy workload: ${args.slice(0, 2).join(' ')}`);
    } });
    return observeNativeCaddyContainer({ dockerHost: 'unix:///selected-docker.sock', containerName: 'owned-caddy',
        privateNetworks: [network(address)], privateBinding: { interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'],
            exposure: { requirementId: 'reviewed-origin', exposure: 'privateNetwork', providerId: 'tailscale', networkIdentity: 'tailnet-a',
                hostAddress: address, hostPort: port + 100, containerPort: port, protocol: 'tcp' } } }, { run: async command => {
        expect(command.executable).toBe('docker');
        if (command.args.includes('ls')) return ok(JSON.stringify(container.Id));
        if (command.args.includes('inspect')) return ok(JSON.stringify([container]));
        throw new Error('Discovery cannot mutate Docker');
    } });
}

it.skipIf(process.platform === 'win32')('selects the persisted edge over every active member’s actual private Caddy publication', async () => {
    const [a, b, edge] = await Promise.all([observed('100.70.0.2', 9381), observed('100.70.0.3', 9481), observed('100.70.0.4', 9581, true)]);
    const members = [{ machineId: 'a', state: 'active' as const, caddy: a }, { machineId: 'b', state: 'active' as const, caddy: b },
        { machineId: 'joining', state: 'joining' as const, caddy: { status: 'needs_setup' as const } }];
    const input = { ingress: { kind: 'edgeCaddy' as const, edgeMachineId: 'edge' }, domainId: 'domain',
        domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 3000 }, healthCheck: { path: '/healthz', expectStatus: 200 } },
        edge: { machineId: 'edge', caddy: edge, privateNetworks: [network('100.70.0.4')] }, members,
        publicTls: { kind: 'managed' as const } };
    const selected = selectEdgeCaddyDomainRoute(input);
    expect(selected).toMatchObject({ status: 'ready', machineId: 'edge', nativeServer: 'public_app',
        route: { listener: 'public', privateSourceRanges: [], upstreams: { kind: 'privateOrigins', endpoints: ['100.70.0.2:9481', '100.70.0.3:9581'] } } });
    if (selected.status !== 'ready') throw new Error('Expected observed edge placement');
    expect(JSON.stringify(materializeCaddyDomainRouteV1(selected.route))).toContain('100.70.0.3:9581');
    expect(JSON.stringify(selected.route)).not.toContain('web-1');
    expect(selectEdgeCaddyDomainRoute({ ...input, edge: { ...input.edge, machineId: 'wrong' } })).toMatchObject({ status: 'unavailable' });
    expect(selectEdgeCaddyDomainRoute({ ...input, members: [members[0]!, { machineId: 'b', state: 'active', caddy: { status: 'stopped', containerId: 'b' } }] }))
        .toMatchObject({ status: 'unavailable', machineIds: ['b'] });
    expect(selectEdgeCaddyDomainRoute({ ...input, edge: { ...input.edge,
        privateNetworks: [{ ...network('100.70.0.4'), networkIdentity: 'another-tailnet' }] } }))
        .toMatchObject({ status: 'unavailable', reason: 'private_scope_unenforceable' });
    const peers = selectPrivateCaddyOriginNetwork({ observerNetworks: [network('100.70.0.2')], members: [members[1]!] });
    expect(peers).toMatchObject({ status: 'ready', sourceRanges: ['100.64.0.0/10'], origins: [{ machineId: 'b', endpoints: ['100.70.0.3:9581'] }] });
});

it.skipIf(process.platform === 'win32')('reads the complete Domain inventory into all affected local replica legs, never an edge proxy or a partial list', async () => {
    const content = (id: string, service: string): DeploymentDomainContentV1 => ({ hostname: `${id}.example.test`,
        target: { service, containerPort: service === 'api' ? 4000 : 3000 }, healthCheck: { path: '/healthz', expectStatus: 200 },
        basicAuth: { username: 'reader' } });
    const web = content('web', 'web'), api = content('api', 'api');
    const alias = { ...content('alias', 'web'), tls: { kind: 'custom' as const } };
    const route = (domainId: string, domain: DeploymentDomainContentV1): CaddyDomainRouteInput => ({ domainId, domain,
        listener: 'privateOrigin', upstreams: { kind: 'replicas', containerNames: [`old-${domain.target.service}-1`, `old-${domain.target.service}-2`] },
        privateSourceRanges: ['100.64.0.0/10'], peerOrigins: ['100.70.0.3:9481'],
        basicAuth: [{ username: 'reader', bcryptHash: 'native-only-hash' }] });
    const routes = [route('web', web), route('api', api), route('alias', alias)];
    const edge: CaddyDomainRouteInput = { ...routes[0]!, listener: 'public',
        upstreams: { kind: 'privateOrigins', endpoints: ['100.70.0.2:9481', '100.70.0.3:9581'] },
        privateSourceRanges: [], peerOrigins: [], publicTls: { kind: 'managed' } };
    const aliasPublic: CaddyDomainRouteInput = { ...routes[2]!, listener: 'public', privateSourceRanges: [], peerOrigins: [],
        publicTls: { kind: 'custom', certificatePem: 'native-only-certificate', privateKeyPem: 'native-only-private-key' } };
    const caddy = await observed('100.70.0.2', 9381, true, [...routes, edge, aliasPublic]);
    if (caddy.status !== 'ready') throw new Error('Expected installed native Caddy');
    const native = createNativeCaddyRoutes({ machineId: 'a', installationId: 'installed-a', privateKey: new Uint8Array(64),
        exchange: createNativeCaddyAdminExchange(caddy.adminSocketPath) });
    const placement = (domainId: string, nativeServer = 'private_app'): NativeCaddyRoutePlacement => ({ serverId: 'home', accountId: 'owner',
        environmentId: 'environment', targetLinkId: 'link', domainId, machineId: 'a', installationId: 'installed-a',
        actionOperationId: 'operation', requestId: 'request', nativeServer });
    const artifacts = new Map<string, DeploymentArtifactDocumentV1>(([['web', web], ['api', api], ['alias', alias]] as const).map(([id, domain]) => {
        const artifactId = `${id}-content`;
        return [artifactId, { artifactId, header: { kind: 'deployment-domain.v1', title: id }, body: JSON.stringify(domain),
            revision: { headerVersion: 1, bodyVersion: 1 } }] as const;
    }));
    const header = (id: string) => {
        const reference = { contentArtifactId: `${id}-content`, contentHeaderVersion: 1, contentBodyVersion: 1 };
        return DeploymentDomainHeaderV1Schema.parse({ v: 1, id, environmentId: 'environment', targetLinkId: 'link', revision: 1,
            state: 'active', createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, ...reference,
            placements: [{ placement: placement(id), content: reference, desired: true, listener: 'privateOrigin', dockerEngineId: 'engine-a' },
                ...(id === 'web' || id === 'alias' ? [{ placement: placement(id, 'public_app'), content: reference, desired: true,
                    listener: 'public', dockerEngineId: 'engine-a' }] : [])] });
    };
    const headers = [header('web'), header('api'), header('alias')];
    const opened: string[] = [], cursors: Array<string | undefined> = [];
    const list = async (request: { cursor?: string }) => {
        cursors.push(request.cursor);
        return DeploymentDomainListResultV1Schema.parse({ ok: true, environmentId: 'environment', revision: 1,
            domains: request.cursor ? headers.slice(1) : headers.slice(0, 1), nextCursor: request.cursor ? null : 'page-2' });
    };
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', machineId: 'a', installationId: 'installed-a',
        dockerEngineId: 'engine-a', affectedServices: ['web', 'api'], list,
        open: async (id: string) => { opened.push(id); return artifacts.get(id) ?? null; }, routes: native };
    const selected = await readDomainCaddyStartFirstLegs(input);
    expect(selected).toMatchObject({ kind: 'ready', legs: [
        { placement: placement('web'), route: { domainId: 'web', listener: 'privateOrigin', privateSourceRanges: ['100.64.0.0/10'],
            peerOrigins: ['100.70.0.3:9481'], basicAuth: [{ username: 'reader' }] } },
        { placement: placement('api'), route: { domainId: 'api', listener: 'privateOrigin' } },
        { placement: placement('alias'), route: { domainId: 'alias', listener: 'privateOrigin' } },
        { placement: placement('alias', 'public_app'), route: { domainId: 'alias', listener: 'public', publicTls: { kind: 'custom' },
            basicAuth: [{ username: 'reader' }] } },
    ] });
    expect(cursors).toEqual([undefined, 'page-2']);
    expect(opened).toEqual(['web-content', 'api-content', 'alias-content']);
    expect(JSON.stringify(selected)).not.toContain('native-only-hash');
    expect(JSON.stringify(selected)).not.toContain('native-only-certificate');
    expect(JSON.stringify(selected)).not.toContain('native-only-private-key');
    const single = (domains: typeof headers) => async () => DeploymentDomainListResultV1Schema.parse({ ok: true,
        environmentId: 'environment', revision: 1, domains, nextCursor: null });
    for (const incomplete of [{ ...headers[0]!, placements: undefined },
        { ...headers[0]!, targetLinkId: 'retired-link', placements: undefined }, { ...headers[0]!, state: 'removing' as const },
        { ...headers[0]!, placements: headers[0]!.placements!.map(capture => ({ ...capture, desired: false })) },
        { ...headers[0]!, placements: headers[0]!.placements!.map(capture => ({ ...capture, dockerEngineId: undefined })) },
        { ...headers[0]!, placements: headers[0]!.placements!.map(capture => ({ ...capture, dockerEngineId: 'other-engine' })) },
        { ...headers[0]!, placements: headers[0]!.placements!.map(capture => ({ ...capture,
            placement: { ...capture.placement, targetLinkId: 'retired-link' } })) }]) {
        expect(await readDomainCaddyStartFirstLegs({ ...input, list: single([incomplete]) }))
            .toMatchObject({ kind: 'unavailable', domainIds: ['web'] });
    }
    expect(await readDomainCaddyStartFirstLegs({ ...input, list: async request => request.cursor
        ? { ok: false as const, error: 'deployment_access_denied' as const } : list(request) }))
        .toMatchObject({ kind: 'unavailable', reason: 'deployment_access_denied' });
    expect(await readDomainCaddyStartFirstLegs({ ...input, list: single([headers[0]!]), open: async () => null }))
        .toMatchObject({ kind: 'unavailable', reason: 'deployment_content_unavailable', domainIds: ['web'] });
    const remote = { ...headers[0]!, targetLinkId: 'retired-link', placements: headers[0]!.placements!.map(capture => ({ ...capture,
        desired: false, placement: { ...capture.placement, machineId: 'remote', targetLinkId: 'retired-link' } })) };
    expect(await readDomainCaddyStartFirstLegs({ ...input, list: single([remote]), open: async () => {
        throw new Error('An explicitly remote capture cannot open local content');
    } })).toEqual({ kind: 'ready', legs: [] });
    const changedApi = { ...headers[1]!, contentBodyVersion: 2, placements: headers[1]!.placements!.map(capture => ({ ...capture,
        content: { ...capture.content, contentBodyVersion: 2 } })) };
    expect(await readDomainCaddyStartFirstLegs({ ...input, list: single([headers[0]!, changedApi]), open: async id => id === 'api-content'
        ? { ...artifacts.get(id)!, body: JSON.stringify({ ...api, hostname: 'changed-api.example.test' }),
            revision: { headerVersion: 1, bodyVersion: 2 } } : artifacts.get(id) ?? null }))
        .toEqual({ kind: 'conflict', reason: 'route_conflict', domainIds: ['api'] });
    expect(await readDomainCaddyStartFirstLegs({ ...input, list: async request => ({ ...await list(request),
        revision: request.cursor ? 2 : 1 }) })).toEqual({ kind: 'unavailable', reason: 'deployment_conflict', domainIds: [] });
    expect(await readDomainCaddyStartFirstLegs({ ...input, list: single([]) })).toEqual({ kind: 'ready', legs: [] });
});

it('provides the deployment remedy when no active Domain members can supply a route', () => {
    const unavailable = { status: 'unavailable', reason: 'required_fact_unavailable',
        details: { requiredFact: 'activeDomainMembers', remedy: expect.any(String) } };
    expect(selectDomainCaddyPlacements({ members: [] })).toMatchObject(unavailable);
    expect(selectPrivateCaddyOriginNetwork({ observerNetworks: [], members: [] })).toMatchObject(unavailable);
});

it.skipIf(process.platform === 'win32')('derives private/public placements from observed topology without confusing the public redirect with app origin', async () => {
    const [a, b, edge] = await Promise.all([observed('100.70.0.2', 9381), observed('100.70.0.3', 9481), observed('100.70.0.4', 9581, true)]);
    const member = { machineId: 'a', installationId: 'installed-a', dockerEngineId: 'engine-a', state: 'active' as const, caddy: a };
    const peer = { machineId: 'b', installationId: 'installed-b', dockerEngineId: 'engine-b', state: 'active' as const, caddy: b };
    const edgeMember = { machineId: 'edge', installationId: 'installed-edge', dockerEngineId: 'engine-edge', caddy: edge };
    expect(selectDomainCaddyPlacements({ ingress: { kind: 'edgeCaddy', edgeMachineId: 'edge' },
        members: [member, peer], edge: edgeMember })).toEqual({ status: 'ready', placements: [
        { machineId: 'a', installationId: 'installed-a', dockerEngineId: 'engine-a', nativeServer: 'private_app', listener: 'privateOrigin' },
        { machineId: 'b', installationId: 'installed-b', dockerEngineId: 'engine-b', nativeServer: 'private_app', listener: 'privateOrigin' },
        { machineId: 'edge', installationId: 'installed-edge', dockerEngineId: 'engine-edge', nativeServer: 'public_app', listener: 'public' },
    ] });
    expect(selectDomainCaddyPlacements({ ingress: { kind: 'cloudflareTunnel' }, members: [member, peer] }))
        .toEqual({ status: 'unavailable', reason: 'required_fact_unavailable', machineIds: ['a', 'b'],
            details: { requiredFact: 'sharedTunnelOrigin' } });
    expect(selectDomainCaddyPlacements({ members: [{ ...edgeMember, state: 'active' }] }))
        .toMatchObject({ status: 'ready', placements: [
            { nativeServer: 'private_app', listener: 'privateOrigin' }, { nativeServer: 'public_app', listener: 'public' },
        ] });
    expect(selectDomainCaddyPlacements({ members: [member, peer] }))
        .toMatchObject({ status: 'unavailable', details: { requiredFact: 'domainIngress' } });
});

it.skipIf(process.platform === 'win32')('selects one container origin common to every active Tunnel member and preserves its exact per-member mapping', async () => {
    const [a, b, missing, different] = await Promise.all([
        observed('100.70.0.2', 9381, false, [], { name: 'network-a', additionalPorts: [9481] }),
        observed('100.70.0.3', 9481, false, [], { name: 'network-b' }),
        observed('100.70.0.4', 9481, false, [], { address: null }),
        observed('100.70.0.5', 9481, false, [], { address: '172.19.0.2' }),
    ]);
    const member = { machineId: 'a', installationId: 'installed-a', dockerEngineId: 'engine-a', state: 'active' as const, caddy: a };
    const peer = { machineId: 'b', installationId: 'installed-b', dockerEngineId: 'engine-b', state: 'active' as const, caddy: b };
    const joining = { machineId: 'joining', installationId: 'installed-joining', dockerEngineId: 'engine-joining', state: 'joining' as const, caddy: different };
    const selected = selectDomainCaddyPlacements({ ingress: { kind: 'cloudflareTunnel' }, members: [member, peer, joining] });
    expect(selected).toMatchObject({ status: 'ready', tunnelOrigin: { service: 'http://172.18.0.2:9481', members: [
        { machineId: 'a', installationId: 'installed-a', containerId: 'caddy-100.70.0.2', networkName: 'network-a', nativeServer: 'private_app' },
        { machineId: 'b', installationId: 'installed-b', containerId: 'caddy-100.70.0.3', networkName: 'network-b', nativeServer: 'private_app' },
    ] } });
    if (selected.status !== 'ready') throw new Error('Expected a shared native origin');
    const topology = DeploymentDomainTopologyV1Schema.parse({ members: [member, peer].map(({ machineId, installationId }) => ({ machineId, installationId })),
        machines: [member, peer].map(({ machineId, installationId, dockerEngineId, caddy }) => ({
            machineId, installationId, dockerEngineId, caddy, privateNetworks: [], replicas: [],
        })), tunnelOrigin: selected.tunnelOrigin });
    expect(topology.tunnelOrigin).toEqual(selected.tunnelOrigin);
    for (const caddy of [missing, different, { status: 'stopped' as const, containerId: 'stopped-b' }]) {
        expect(selectDomainCaddyPlacements({ ingress: { kind: 'cloudflareTunnel' }, members: [member, { ...peer, caddy }] }))
            .toEqual({ status: 'unavailable', reason: 'required_fact_unavailable', machineIds: ['a', 'b'],
                details: { requiredFact: caddy.status === 'ready' ? 'sharedTunnelOrigin' : 'memberCaddyObservation' } });
    }
    expect(selectDomainCaddyPlacements({ ingress: { kind: 'cloudflareTunnel' }, members: [member, peer, { ...joining, state: 'active' }] }))
        .toEqual({ status: 'unavailable', reason: 'required_fact_unavailable', machineIds: ['a', 'b', 'joining'],
            details: { requiredFact: 'sharedTunnelOrigin' } });
});

it.skipIf(process.platform === 'win32').each(['shared', 'no active Domain members', 'Domain Environment HTTP unavailable', 'Domain Home purpose refused', 'missing tunnel origin', 'misdirected discovery', 'administrator access off', 'administrator access not applied', 'administrator elevation denied', 'managed CLI unavailable', 'network review required', 'firewall prerequisite failed', 'firewall policy unavailable', 'firewall partial failure', 'daemon ACK unavailable', 'daemon ACK unknown', 'native cancelled', 'direct installed Caddy', 'direct installed Caddy admin unavailable', 'native Caddy port occupied', 'native Caddy host port occupied'] as const)(
    'carries the complete shared origin through the real controller and private child transport: %s', async scenario => {
    const environment = createDeploymentEnvironmentDetailV1();
    environment.content.ingress = { kind: 'cloudflareTunnel' };
    environment.environment.owner = { kind: 'account', accountId: 'owner' };
    const link = environment.targetLinks[0]!.targetLink;
    link.machines = ['a', 'b'];
    link.members = [{ machineId: 'a', installationId: 'installed-a', state: 'active' },
        { machineId: 'b', installationId: 'installed-b', state: 'active' }];
    if (scenario !== 'shared' && scenario !== 'misdirected discovery' && scenario !== 'missing tunnel origin') {
        delete environment.content.ingress;
        link.members = [link.members[0]!];
        link.machines = ['a'];
    }
    if (scenario === 'no active Domain members') link.members[0]!.state = 'joining';
    const occupiedPort = scenario === 'native Caddy port occupied' || scenario === 'native Caddy host port occupied';
    const installedCaddy = scenario === 'direct installed Caddy' || scenario === 'direct installed Caddy admin unavailable' || occupiedPort;
    if (installedCaddy) {
        link.state = 'deployed';
        link.activeDeploymentId = 'serving';
    }
    const nativeRuntime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'fixture', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://domain-origin.test', machineId: 'a',
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        async acquirePluginRuntimeRegistryLease() { throw new Error('Uses the active deployed service'); } });
    const prepared = scenario !== 'shared' && scenario !== 'misdirected discovery' && scenario !== 'missing tunnel origin' ? nativeRuntime.prepareDomainCaddy!({
        domain: { hostname: 'qa-domain-1101-r23b.localhost', target: { service: 'web', containerPort: 80 } },
        environment: environment.content, replicas: [{ containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
        privateNetworks: [], daemonGroup: 'happier', daemonGroupId: 1000,
    }) : undefined;
    const observations = await Promise.all([observed('100.70.0.2', 9381, false, [],
        prepared ? { name: 'deployed_default' } : scenario === 'missing tunnel origin' ? { address: null } : {}, prepared), observed('100.70.0.3', 9381)]);
    let installed: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    if (installedCaddy) {
        installed = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [] } });
        const document = 'services: {web: {image: nginx:alpine}}';
        const definition = { kind: 'stored' as const, contentRevision: 1, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] };
        const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
            return { environmentId: environment.environment.id, environmentInstanceId: 'deployed', deploymentId: 'serving',
                machineId: 'a', installationId: 'installed-a', deploymentRoot: join(installed!.happyHomeDir, 'deployments'),
                artifactDirectory: join(installed!.happyHomeDir, 'artifacts'), definition, async assertCurrent() {} };
        } });
        const release = await materializer.materialize({ environmentId: environment.environment.id, deploymentId: 'serving' });
        await release.commit();
        const observedCaddy = observations[0]!;
        if (observedCaddy.status !== 'ready') throw new Error('Installed Caddy observation unavailable');
        await installed.lease.registry.projectManagedServices.superviseProject({ kind: 'environment', serverId: 'home',
            machineId: 'a', environmentId: environment.environment.id, environmentInstanceId: 'deployed', deploymentId: 'serving', release,
            composeService: 'web', serviceId: 'deployed/web', specIdentity: 'web', isCurrent: () => true,
            releaseObservation: async () => {}, nativeEffects: { keys: [] }, processSpec: { mode: { kind: 'native', builtinLifecycle: {
                async inspect() { return { phase: 'running', readiness: 'ready', endpoint: 'http://127.0.0.1:32771' }; },
                async stop() { return { status: 'stopped' }; },
                nativeContainers: () => [{ id: 'healthy-web', composeProject: 'deployed', service: 'web', containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
                nativeDocker: async () => occupiedPort ? { engineId: 'engine-a', async run(args) {
                    if (args.includes('--all')) return { exitCode: 0, stdout: '', stderr: '' };
                    if (scenario === 'native Caddy host port occupied') {
                        // The server is the OS boundary; the Domain acquisition,
                        // port owner and public failure projection remain real.
                        vi.spyOn(TcpServer.prototype, 'listen').mockImplementation(function (this: TcpServer) {
                            queueMicrotask(() => this.emit('error', Object.assign(new Error('native listener'), { code: 'EADDRINUSE' })));
                            return this;
                        });
                        return { exitCode: 0, stdout: '', stderr: '' };
                    }
                    if (args.includes('{{json .NetworkSettings.Ports}}')) return { exitCode: 0, stdout: JSON.stringify({
                        '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }],
                        '443/tcp': [{ HostIp: '0.0.0.0', HostPort: '443' }],
                    }), stderr: '' };
                    if (args.includes('ls')) return { exitCode: 0, stdout: '"coolify-proxy"', stderr: '' };
                    throw new Error('Port refusal cannot mutate Docker');
                } } : nativeDocker.get(observedCaddy.adminSocketPath)!,
            } } } });
    }
    const machines = link.members.map((member, index) => DeploymentDomainMachineTopologyV1Schema.parse({
        machineId: member.machineId, installationId: member.installationId, dockerEngineId: `engine-${member.machineId}`,
        caddy: observations[index], privateNetworks: [], replicas: [],
    }));
    const input = DeploymentActionInputSchemasV1['deployments.domains.add'].parse({ serverId: 'home',
        environmentId: environment.environment.id, domainId: 'domain', expectedRevision: environment.environment.revision,
        targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: 'domain-add',
        contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 });
    if (!('contentArtifactId' in input)) throw new Error('Expected prepared Domain input');
    const domainContent = DeploymentDomainContentV1Schema.parse({
        hostname: 'qa-domain-1101-ingress.localhost', target: { service: 'web', containerPort: 80 },
        healthCheck: { path: '/', expectStatus: 200 } });
    const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`, encryption: null };
    const documents = new Map<string, Record<string, unknown>>();
    for (const [id, kind, content] of [[environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content],
        [link.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {}],
        [input.contentArtifactId, 'deployment-domain.v1', domainContent]] as const) {
        documents.set(id, { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ kind, title: 'Domain' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
    }
    const identity = tweetnacl.sign.keyPair();
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
        installationId: 'controller-installation', createdAt: 1, publicKey: Buffer.from(identity.publicKey).toString('base64url'),
        privateKey: Buffer.from(identity.secretKey).toString('base64url') });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(url).pathname;
        if (path.startsWith('/v1/machines/')) {
            const machineId = path.split('/').at(-1)!;
            return { status: 200, data: { machine: { id: machineId, kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                metadataVersion: 1, daemonStateVersion: 1,
                metadata: encodePlainMachineStoredContent({ host: 'own-server', platform: 'linux', happyCliVersion: '0.3',
                    homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier', adminAccess: { version: 1, mode: 'preauthorized' } }),
                daemonState: encodePlainMachineStoredContent({ status: 'running', adminAccess: { version: 1, observedAt: 1,
                    daemonUid: 1000, daemonUsername: 'happier', daemonPrimaryGroup: 'happier', daemonIdentity: 'nonRoot',
                    rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid',
                    tailscaledOperator: { authorization: 'unknown' } } }),
                installationId: `installed-${machineId}`, installationPublicKey: Buffer.from(identity.publicKey).toString('base64') } } };
        }
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        const document = documents.get(path.split('/').at(-1)!);
        if (!document && path.startsWith('/v1/artifacts/')) return { status: 404, data: { error: 'not_found' } };
        if (!document) throw new Error(`Unexpected Domain read ${path}`);
        return { status: 200, data: document };
    });
    const admissions: Array<ReturnType<typeof DeploymentDomainAddAdmissionInputV1Schema.parse>> = [];
    let admittedDomain: ReturnType<typeof DeploymentDomainHeaderV1Schema.parse> | undefined;
    const transitions: unknown[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        if (request.method === 'GET' && scenario === 'Domain Environment HTTP unavailable') {
            throw Object.assign(new Error('Private network transport context'), { code: 'ECONNRESET' });
        }
        if (request.method === 'GET' && scenario === 'Domain Home purpose refused') {
            expect(request.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toEqual(expect.any(String));
            return { status: 401, data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } };
        }
        if (request.method === 'GET') return { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
            environment: environment.environment, targetLinks: [link] }) };
        if (path.endsWith('/transitions')) {
            transitions.push(request.data);
            return { status: 200, data: { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 2,
                domain: { ...admittedDomain, state: 'active', revision: 2 } } };
        }
        expect(path).toBe(`/v1/deployments/environments/${input.environmentId}/domains`);
        const admitted = DeploymentDomainAddAdmissionInputV1Schema.parse(request.data);
        admissions.push(admitted);
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: input.domainId, environmentId: input.environmentId,
            targetLinkId: link.id, revision: 1, state: 'applying', contentArtifactId: input.contentArtifactId,
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
            placements: admitted.placements.map(placement => ({ placement: { serverId: 'home', accountId: 'owner',
                environmentId: input.environmentId, targetLinkId: link.id, domainId: input.domainId, machineId: placement.machineId,
                installationId: placement.installationId, nativeServer: placement.nativeServer,
                actionOperationId: admitted.actionOperationId, requestId: admitted.requestId }, listener: placement.listener, desired: true,
                environmentContent: { contentArtifactId: environment.environment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
                targetLinkContent: { contentArtifactId: link.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
                dockerEngineId: placement.dockerEngineId, content: { contentArtifactId: input.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } })) });
        admittedDomain = domain;
        return { status: 200, data: { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1, domain } };
    });
    // The Account HTTP boundary retains the real approval Artifact codec and CAS path.
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (!isRecord(body)) throw new Error('Expected an Artifact write object at the Home HTTP boundary');
        const path = new URL(url).pathname;
        if (path === '/v1/artifacts') {
            documents.set(String(body.id), { ...body, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
        }
        if (path.startsWith('/v1/artifacts/')) {
            const id = path.split('/').at(-1)!;
            const current = documents.get(id);
            if (!current) return { status: 404, data: { error: 'not_found' } };
            if (body.expectedHeaderVersion !== undefined && body.expectedHeaderVersion !== current.headerVersion
                || body.expectedBodyVersion !== undefined && body.expectedBodyVersion !== current.bodyVersion) {
                return { status: 200, data: { success: false, error: 'version-mismatch' } };
            }
            const headerVersion = Number(current.headerVersion) + (body.header === undefined ? 0 : 1);
            const bodyVersion = Number(current.bodyVersion) + (body.body === undefined ? 0 : 1);
            documents.set(id, { ...current, ...(body.header === undefined ? {} : { header: body.header }),
                ...(body.body === undefined ? {} : { body: body.body }), headerVersion, bodyVersion });
            return { status: 200, data: { success: true, headerVersion, bodyVersion } };
        }
        return { status: 200, data: { ok: true } };
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } })));
    const channel = await createRequesterCurrentnessSocketHarness();
    const children: Array<ReturnType<typeof DeploymentDomainChildRpcV1Schema.parse>> = [];
    const nativeResults: unknown[] = [];
    type RpcCall = Parameters<ClientToServerEvents[typeof SOCKET_RPC_EVENTS.CALL]>[0];
    channel.server.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, async (call: RpcCall, acknowledge: (result: unknown) => void) => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, call.params, call.method);
            const job = DeploymentChildRpcV1Schema.parse(decoded.params);
            if (installedCaddy) {
                const nativeIdentity = { version: 1 as const, installationId: 'installed-a', createdAt: 1,
                    publicKey: Buffer.from(identity.publicKey).toString('base64url'), privateKey: Buffer.from(identity.secretKey).toString('base64url') };
                vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue(nativeIdentity);
                try {
                    if (job.kind === 'domain') children.push(DeploymentDomainChildRpcV1Schema.parse(job));
                    const result = await memberDeps!.deploymentChild(job, {});
                    nativeResults.push(result);
                    if (scenario === 'direct installed Caddy admin unavailable' && job.kind === 'domainDiscover') {
                        const caddy = observations[0]!;
                        if (caddy.status !== 'ready') throw new Error('Expected installed Caddy');
                        unavailableAdmin.add(caddy.adminSocketPath);
                    }
                    acknowledge({ ok: true, result });
                } finally {
                    vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue({ ...nativeIdentity, installationId: 'controller-installation' });
                }
                return;
            }
            if (job.kind === 'domainDiscover') {
                if (scenario === 'network review required' || scenario === 'firewall prerequisite failed' || scenario === 'firewall policy unavailable' || scenario === 'firewall partial failure'
                    || scenario === 'daemon ACK unavailable' || scenario === 'daemon ACK unknown' || scenario === 'native cancelled') {
                    if (prepared?.status !== 'ready') throw new Error('Expected declared public Caddy bindings');
                    // Machine metadata and elevation are system boundaries. Keep
                    // the real posture admission and failure settlement beneath this RPC.
                    const metadata = scenario === 'network review required' ? {} : { reachabilityPosture: MachineReachabilityPostureV1Schema.parse({
                        revision: 0, management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'none' },
                    }) };
                    // The root process is the OS boundary. Keep the real
                    // CHECK/APPLY parser, elevation, transition and public RPC.
                    const spawn: MachineElevationSpawn = () => {
                        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
                        const settled = (async () => {
                            const lines = createInterface({ input: stdin });
                            try {
                                const frames = lines[Symbol.asyncIterator]();
                                stdout.write('{"type":"ready"}\n');
                                const frame = await frames.next();
                                const request = MachineEffectInternalRequestSchema.parse(JSON.parse(frame.value!));
                                if (request.mode !== 'check' || !('firewallIntent' in request)) throw new Error('Expected root firewall CHECK');
                                if (scenario === 'firewall policy unavailable') {
                                    stdout.write(JSON.stringify({ type: 'result', result: { status: 'unavailable',
                                        reason: 'required_fact_unavailable', requiredFact: 'retainedSshPolicy',
                                        completedStepIds: [], daemonRestartRequired: false } }) + '\n');
                                    return { code: 1, signal: null };
                                }
                                const plan = await checkMachineSetupEffectPlan({ basis: request.basis,
                                    steps: [{ id: 'firewall', kind: 'firewall', rules: 'table inet happier {}' }],
                                    backend: { async observe(step) { return { stepId: step.id, status: 'drifted', facts: {} }; },
                                        async apply() { throw new Error('The root OS process supplies this result'); } } });
                                stdout.write(JSON.stringify({ type: 'result', result: { status: 'checked', plans: [{ plan }, { plan }] } }) + '\n');
                                await frames.next();
                                stdout.write(JSON.stringify({ type: 'progress', stepId: 'firewall', phase: 'apply', status: 'started' }) + '\n');
                                if (scenario === 'daemon ACK unavailable' || scenario === 'daemon ACK unknown' || scenario === 'native cancelled') {
                                    const recovery = { rules: { kind: 'absent' }, unit: { kind: 'absent' }, table: null,
                                        boot: { present: false, enabled: false, running: false } };
                                    if (scenario !== 'native cancelled') {
                                        stdout.write(JSON.stringify({ type: 'firewall.staged', planIndex: 0, planDigest: plan.planDigest, recovery }) + '\n');
                                        const control = JSON.parse((await frames.next()).value!);
                                        expect(control).toMatchObject({ type: 'firewall.settle', decision: 'undo' });
                                    }
                                    stdout.write(JSON.stringify({ type: 'result', result: { status: 'cancelled', completedStepIds: ['firewall'],
                                        daemonRestartRequired: false, restoration: { status: 'verified', recovery } } }) + '\n');
                                    return { code: 1, signal: null };
                                }
                                stdout.write(JSON.stringify({ type: 'result', result: { status: 'failed',
                                    reason: scenario === 'firewall prerequisite failed' ? 'required_fact_unavailable' : 'foreign_effect_conflict',
                                    completedStepIds: [], daemonRestartRequired: false } }) + '\n');
                                return { code: 1, signal: null };
                            } finally { lines.close(); stdout.end(); stderr.end(); }
                        })();
                        return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
                    };
                    try {
                        await machineNativeEffectAdmission.run({ operation: { operationId: 'domain-no-posture', kind: job.actionId },
                            keys: [{ kind: 'machineSetup' }] }, native => settleMachineCaddyFirewallForHost({
                            machineId: job.machineId, installationId: job.installationId, operationId: 'domain-no-posture',
                            basis: { kind: 'setup', machineId: job.machineId, desiredRevision: 0 }, native, caddy: prepared.input,
                            port: { read: async () => ({ status: 'ready', metadata, metadataVersion: 34 }),
                                compareAndSwap: async () => { throw new Error('Domain add cannot invent a network posture'); } },
                            elevation: { installationId: job.installationId, installedCli: '/managed/happier',
                                readPolicy: async () => ({ version: 1, mode: 'preauthorized' }),
                                observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1000, daemonUsername: 'happier',
                                    daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed',
                                    managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }), spawn },
                            readDaemonProof: async () => observeOwnDaemonReachability({ client: {
                                isMachineControlRegistrationReady: () => true,
                                async callConnectedClientRpc() { return { ok: false,
                                    errorCode: scenario === 'daemon ACK unavailable' ? 'target_unavailable' : 'RPC_METHOD_NOT_AVAILABLE' }; },
                            } }),
                        }));
                        throw new Error('Missing posture must refuse Domain setup');
                    } catch (error) {
                        if (!(error instanceof Error) || !('code' in error)) throw error;
                        acknowledge({ ok: true, result: { ok: false, errorCode: error.code, error: error.code,
                            ...('details' in error ? { details: error.details } : {}) } });
                    }
                    if (scenario === 'network review required') expect(metadata).toEqual({});
                    return;
                }
                if (scenario === 'administrator access off' || scenario === 'administrator access not applied'
                    || scenario === 'administrator elevation denied'
                    || scenario === 'managed CLI unavailable') {
                    if (prepared?.status !== 'ready') throw new Error('Expected native Caddy preparation');
                    const installHome = await mkdtemp(join(tmpdir(), 'domain-refusal-cli-'));
                    roots.push(installHome);
                    vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', installHome);
                    // Native policy, privilege observation and process streams are
                    // OS boundaries; setup/elevation decisions below remain real.
                    try {
                        await prepared.ensure({ setup: {
                            readDesired: () => getMachineSetupDesiredV1({
                                read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 38 }),
                                compareAndSwap: async () => { throw new Error('Domain cannot change Machine policy'); },
                            }),
                            elevation: {
                                readPolicy: async () => ({ version: 1, mode: scenario === 'administrator access off' ? 'none' : 'preauthorized' }),
                                observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier',
                                    daemonIdentity: 'nonRoot', rootEquivalentGroups: [],
                                    passwordlessSudoToRoot: scenario === 'administrator access not applied' ? 'denied' : 'allowed',
                                    managedDropIn: 'absent', tailscaledOperator: { authorization: 'unknown' } }),
                                ...(scenario === 'administrator elevation denied' ? { spawn: () => {
                                    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
                                    stdout.end(); stderr.end();
                                    return { stdin, stdout, stderr, settled: Promise.resolve({ code: 1, signal: null }),
                                        terminate: async () => { stdin.destroy(); } };
                                } } : {}),
                            },
                        }, context: { actionRequestId: 'domain-refusal' }, actionId: job.actionId,
                            installationId: job.installationId, dockerEngineId: 'engine-a', signal: new AbortController().signal,
                            async run() { throw new Error('Refused setup cannot mutate Docker'); },
                        });
                        throw new Error('Expected setup refusal');
                    } catch (error) {
                        if (!(error instanceof Error) || !('code' in error)) throw error;
                        acknowledge({ ok: true, result: { ok: false, errorCode: error.code, error: error.code,
                            ...('details' in error ? { details: error.details } : {}) } });
                    }
                    return;
                }
                const result = scenario === 'misdirected discovery' && job.machineId === 'b' ? machines[0]
                    : machines.find(machine => machine.machineId === job.machineId);
                acknowledge({ ok: true, result });
            } else {
                children.push(DeploymentDomainChildRpcV1Schema.parse(job));
                acknowledge({ ok: true, result: { errorCode: 'native_route_unavailable' } });
            }
        });
    });
    const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://domain-origin.test',
        machineId: 'controller', resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        runtime: { async acquire() { throw new Error('Domain discovery cannot redeploy services'); } } });
    const memberDeps = installed ? createDaemonDeploymentActionDeps({ credentials, serverId: 'home',
        serverHttpBaseUrl: 'https://domain-origin.test', machineId: 'a', runtime: nativeRuntime,
        acquirePluginRuntimeRegistryLease: async () => installed.lease,
        captureNativeSetup: () => ({
            readDesired: () => { throw new Error('Port refusal cannot read setup intent'); },
            elevation: {
                readPolicy: async () => { throw new Error('Port refusal cannot request elevation'); },
                observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier',
                    daemonPrimaryGroup: 'happier', daemonIdentity: 'nonRoot', rootEquivalentGroups: [],
                    passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }),
            },
        }),
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) }) : undefined;
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const envelope = { v: 1 as const, requestId: 'domain-request', target, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'domain-root', binding: {
        serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, custodianAccountId: 'owner',
        machineId: 'controller', installationId: 'controller-installation', environmentId: input.environmentId,
        actionId: 'deployments.domains.add', deploymentChildRoot: true,
        requestId: envelope.requestId, accountEncryptionMode: 'plain', target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.domains.add', input) } });
    const requester = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
        machineId: 'controller', installationId: 'controller-installation', installationPrivateKey: identity.secretKey,
        serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://domain-origin.test', ownCredentials: credentials,
        isCurrent: async () => true, createExecutor: () => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps }) });
    try {
        if (!requester) throw new Error('Expected admitted Domain requester');
        const execute = () => deps.deploymentAction('deployments.domains.add', input, { externalActionExecutionAuthorization: requester.authorization,
            originalActionEnvelope: envelope, externalActionTarget: target, actionRequestId: envelope.requestId,
            operationAcceptance: { operationId: 'domain-operation', accept() {} } });
        if (scenario === 'no active Domain members' || scenario === 'Domain Environment HTTP unavailable'
            || scenario === 'network review required' || scenario === 'Domain Home purpose refused'
           ) {
            const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: 'controller',
                resolveAccountId: async () => 'owner', generateOperationId: () => 'domain-operation' });
            const result = await operations.observeExecution({ actionId: 'deployments.domains.add', input,
                actionRequestId: envelope.requestId, execute: async () => ActionExecuteResultSchema.parse(await execute()) });
            const details = { environmentId: input.environmentId, domainId: input.domainId, step: 'native_execution',
                ...(scenario === 'no active Domain members' ? { requiredFact: 'activeDomainMembers', remedy: expect.any(String) }
                    : scenario === 'network review required' ? { requiredFact: 'reachabilityPosture', remedy: expect.any(String) }
                        : scenario === 'Domain Home purpose refused' ? { requiredFact: 'verification_purpose', remedy: expect.any(String) } : {}),
                operation: { serverId: 'home', machineId: 'controller', operationId: 'domain-operation' } };
            // RpcError carries the Home reader's typed failure unchanged.
            const errorCode = scenario === 'no active Domain members' ? 'required_fact_unavailable'
                : scenario === 'network review required' ? 'machine_network_review_required'
                    : scenario === 'Domain Home purpose refused' ? 'action_forbidden' : 'home_unreachable';
            expect.soft(result).toMatchObject({ ok: false, errorCode, details });
            if (scenario === 'Domain Home purpose refused') expect.soft(result).toMatchObject({
                failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 401 } });
            else expect.soft(result).not.toHaveProperty('failureCause');
            const operation = await executeActionOperationActionV1({ actionId: 'action.operations.get',
                input: { serverId: 'home', machineId: 'controller', operationId: 'domain-operation' },
                transport: async ({ payload }) => operations.handlers.getV2(payload) });
            expect.soft(operation).toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
                errorCode, details } } });
            if (scenario === 'Domain Home purpose refused') expect.soft(operation).toMatchObject({ operation: { error: {
                failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 401 } } } });
            else expect.soft(operation).not.toHaveProperty('operation.error.failureCause');
            const { contentArtifactId: _artifactId, contentHeaderVersion: _headerVersion,
                contentBodyVersion: _bodyVersion, ...authoredScope } = input;
            const canonicalHome = 'srv_domain_home';
            const actionArgs = scenario === 'network review required'
                ? { ...authoredScope, serverId: canonicalHome, content: domainContent } : input;
            const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
                createdBy: { surface: 'cli' }, requestedSurface: 'ui', actionId: 'deployments.domains.add', actionArgs,
                summary: 'Add Domain', decision: { kind: 'approve', decidedAtMs: 2 },
                executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                    serverId: 'home', accountId: 'owner', machineId: 'controller',
                    ...(scenario === 'network review required' ? { serverIdentityId: canonicalHome,
                        target: { kind: 'machine', machineId: 'controller' } } : {}),
                    actionId: 'deployments.domains.add', requestId: envelope.requestId } });
            const settled = projectSettledApprovalExecution({ request, actionId: 'deployments.domains.add', exec: result,
                dispatchEffectAttempted: true, executedAtMs: 3 });
            const approvals = createCliApprovalsArtifactStore({ credentials, serverId: 'home',
                serverHttpBaseUrl: 'https://domain-origin.test', getAccountEncryptionMode: async () => 'plain' });
            const { artifactId } = await approvals.approvalsCreate({ request, serverId: 'home' });
            expect(await approvals.approvalsUpdate({ artifactId, serverId: 'home', expectedStatus: 'executing',
                request: settled.request })).toEqual({ ok: true });
            const stored = StoredApprovalRequestSchema.parse(await approvals.approvalsGet({ artifactId, serverId: 'home' }));
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...approvals });
            const publicResult = await executor.execute('approval.request.get', { artifactId }, {
                surface: 'ui', authority: 'present_user', serverId: 'home', serverIdentityId: 'home',
                runtimeAccountId: 'owner', defaultSessionMachineId: 'controller', actionCaller: { kind: 'host' } });
            if (!publicResult.ok) throw new Error('The failed Domain approval must remain publicly readable');
            const publicRead = ApprovalRequestGetResultV1Schema.parse(publicResult.result);
            for (const observed of [stored, publicRead.request]) {
                expect.soft(observed).toMatchObject({ status: 'failed', execution: {
                    ok: false, errorCode, details } });
                if (scenario === 'Domain Home purpose refused') expect.soft(observed).toMatchObject({ execution: {
                    failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 401 } } });
                else expect.soft(observed).not.toHaveProperty('execution.failureCause');
                expect(JSON.stringify(observed)).not.toContain('Private network transport context');
            }
            expect(JSON.stringify(operation)).not.toContain('Private network transport context');
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
            return;
        }
        const result = scenario === 'direct installed Caddy admin unavailable' ? await (async () => {
            // HTTP and Socket.IO are genuine network boundaries. All Domain
            // decisions, including the failing guest observation, remain real.
            const { createLightSqliteHarness } = await import('../../../../../server/sources/testkit/lightSqliteHarness');
            const database = await createLightSqliteHarness({ tempDirPrefix: 'domain-admin-result-',
                env: { HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '1' } });
            const { createAuthenticatedTestApp } = await import('../../../../../server/sources/app/api/testkit/sqliteFastify');
            const { registerExternalActionRoutes } = await import('../../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes');
            const { prepareExternalActionResponseEnvelopeV1 } = await import('@happier-dev/protocol/actions');
            const app = createAuthenticatedTestApp();
            registerExternalActionRoutes(app, { dispatch: async (request: Parameters<ExternalActionDaemonDispatcher>[0]) => ({ kind: 'response',
                prepared: prepareExternalActionResponseEnvelopeV1({ v: 1, actionId: request.actionId,
                    requestId: request.envelope.requestId, execution: await execute() }) }) });
            try {
                const response = await app.inject({ method: 'POST', url: '/v1/actions/deployments.domains.add',
                    headers: { authorization: 'Bearer fixture', 'x-test-user-id': 'owner',
                        'x-test-auth-token-kind': 'api_token', 'x-test-api-token-account-id': 'owner',
                        'x-test-api-token-principal-id': 'principal', 'x-test-api-token-credential-id': 'credential' }, payload: envelope });
                expect(response.statusCode).toBe(200);
                return response.json().execution;
            } finally { await app.close(); await database.close(); }
        })() : await execute();
        if (scenario === 'administrator elevation denied') {
            // A failed native child does not establish an Admin Access refusal.
            expect(result).toMatchObject({ ok: false, errorCode: 'native_protocol_invalid',
                details: { failure: { kind: 'native_protocol_invalid' } } });
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
        } else if (scenario === 'administrator access off' || scenario === 'administrator access not applied') {
            expect(result).toMatchObject({ ok: false, errorCode: 'machine_admin_access_required' });
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
        } else if (scenario === 'daemon ACK unavailable' || scenario === 'daemon ACK unknown') {
            expect(result).toMatchObject({ ok: false,
                errorCode: scenario === 'daemon ACK unavailable' ? 'machine_unavailable' : 'required_fact_unavailable', details: {
                    requiredFact: 'homeRoutedDaemonAck',
                    failure: { kind: 'daemon_reachability_unavailable', reason: 'required_fact_unavailable', requiredFact: 'homeRoutedDaemonAck',
                        errorCode: scenario === 'daemon ACK unavailable' ? 'target_unavailable' : 'RPC_METHOD_NOT_AVAILABLE' },
                    restoration: { status: 'verified' }, remedy: expect.stringContaining('Home-routed daemon ACK'),
                } });
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
        } else if (scenario === 'native cancelled') {
            expect(result).toMatchObject({ ok: false, errorCode: 'cancelled', details: { restoration: { status: 'verified' } } });
            expect(result).not.toHaveProperty('details.failure');
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
        } else if (scenario === 'firewall policy unavailable') {
            expect(result).toMatchObject({ ok: false, errorCode: 'required_fact_unavailable', details: {
                requiredFact: 'retainedSshPolicy',
                failure: { kind: 'native_check_unavailable', reason: 'required_fact_unavailable', requiredFact: 'retainedSshPolicy' },
                remedy: expect.stringContaining('retainedSshPolicy'),
            } });
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
        } else if (scenario === 'firewall prerequisite failed' || scenario === 'firewall partial failure') {
            expect(result).toMatchObject({ ok: false,
                errorCode: scenario === 'firewall prerequisite failed' ? 'native_effect_failed' : 'outcome_unknown', details: {
                    failure: { kind: 'native_effect_failed', reason: scenario === 'firewall prerequisite failed'
                        ? 'required_fact_unavailable' : 'foreign_effect_conflict' }, remedy: expect.any(String),
                } });
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
        } else if (scenario === 'managed CLI unavailable') {
            expect(result).toMatchObject({ ok: false, errorCode: 'managed_cli_unavailable', details: {
                recovery: { kind: 'install_managed_cli', executablePath: resolveInstalledMachineEffectCli() },
            } });
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
        } else if (scenario === 'missing tunnel origin') {
            expect(result).toMatchObject({ ok: false, errorCode: 'required_fact_unavailable',
                details: { requiredFact: 'sharedTunnelOrigin' } });
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
        } else if (scenario === 'misdirected discovery') {
            expect(result).toMatchObject({ ok: false, errorCode: 'target_mismatch' });
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
        } else if (occupiedPort) {
            expect(ActionExecuteResultSchema.parse(result)).toMatchObject({ ok: false, errorCode: 'foreign_effect_conflict', details: {
                failure: { kind: 'native_observation_unavailable', reason: 'port_in_use', stepId: 'caddy-public-port', port: 80 },
                remedy: expect.stringContaining('Tunnel'),
            } });
            expect(admissions).toEqual([]);
            expect(children).toEqual([]);
            expect(transitions).toEqual([]);
        } else if (scenario === 'direct installed Caddy admin unavailable') {
            expect(result).toMatchObject({ ok: false, errorCode: 'required_fact_unavailable', details: {
                requiredFact: 'caddyAdminConfig',
                failure: { requiredFact: 'caddyAdminConfig', errorCode: 'HTTP_503' },
                remedy: expect.stringContaining('caddyAdminConfig'),
            } });
            expect(nativeResults).toMatchObject([{ caddy: { status: 'ready' } }, { errorCode: 'required_fact_unavailable',
                details: { failure: { requiredFact: 'caddyAdminConfig' } } }]);
            expect(admissions).toHaveLength(1);
            expect(transitions).toEqual([]);
        } else if (scenario === 'direct installed Caddy') {
            expect(result, `Native public TLS listener/publication required for Domain admission: ${JSON.stringify(result)}`)
                .toMatchObject({ ok: true, domain: { state: 'active' } });
            expect(admissions).toHaveLength(1);
            expect(children).toHaveLength(2);
            expect(transitions).toMatchObject([{ observations: [{ state: 'active' }, { state: 'active' }] }]);
            expect(nativeResults).toMatchObject([{ caddy: { status: 'ready' } }, { state: 'active' }, { state: 'active' }]);
            expect(admissions[0]?.placements).toEqual(expect.arrayContaining([
                expect.objectContaining({ machineId: 'a', listener: 'privateOrigin', nativeServer: 'happier_private' }),
                expect.objectContaining({ machineId: 'a', listener: 'public', nativeServer: 'happier_public' }),
            ]));
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'native_route_unavailable' });
            expect(admissions).toHaveLength(1);
            expect(children).toHaveLength(1);
            expect(children[0]?.topology?.tunnelOrigin).toEqual({ service: 'http://172.18.0.2:9381', members: [
                { machineId: 'a', installationId: 'installed-a', containerId: 'caddy-100.70.0.2', networkName: 'exact_generation', nativeServer: 'private_app' },
                { machineId: 'b', installationId: 'installed-b', containerId: 'caddy-100.70.0.3', networkName: 'exact_generation', nativeServer: 'private_app' },
            ] });
            expect(children[0]?.topology?.members).toEqual(link.members.map(({ machineId, installationId }) => ({ machineId, installationId })));
        }
    } finally { await requester?.dispose(); await channel.close(); await installed?.dispose(); }
});
