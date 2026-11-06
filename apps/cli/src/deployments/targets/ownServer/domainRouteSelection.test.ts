import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { Server as TcpServer } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { nativeCaddyImage, observeNativeCaddyContainer, type MachineSetupNativeCommandResult,
    type NativeCaddyObservationResult } from '@happier-dev/cli-common/machineSetup';
import type { MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { DeploymentDomainHeaderV1Schema, DeploymentDomainListResultV1Schema,
    type NativeCaddyRoutePlacement } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDomainTopologyV1Schema, DeploymentDomainAddAdmissionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentActionInputSchemasV1, DeploymentDomainChildRpcV1Schema, DeploymentDomainMachineTopologyV1Schema,
    DeploymentEnvironmentGetResultV1Schema, DeploymentChildRpcV1Schema, createActionExecutor } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
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
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
const network = (address: string): MachinePrivateNetworkObservationV1 => ({ provider: { kind: 'builtin', id: 'tailscale' },
    networkIdentity: 'tailnet-a', interfaceName: 'tailscale0', addresses: [address], sourceRanges: ['100.64.0.0/10'],
    displayName: null, dnsName: null, magicDnsEnabled: false, state: 'ready' });
const ok = (stdout: string): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });

/** Docker is the system boundary; mounted seed and live Unix HTTP are real. */
async function observed(address: string, port: number, edge = false,
    installed: readonly CaddyDomainRouteInput[] = [], containerNetwork: Readonly<{
        name?: string; address?: string | null; additionalPorts?: readonly number[];
    }> = {}): Promise<NativeCaddyObservationResult> {
    const root = await mkdtemp('/tmp/hde-'); roots.push(root);
    const seed = { admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' } };
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
    const config = { ...seed, apps: { http: { servers: nativeServers }, tls } };
    const server = createServer((request, response) => {
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
        .toEqual({ status: 'unavailable', reason: 'required_fact_unavailable', machineIds: ['a', 'b'] });
    expect(selectDomainCaddyPlacements({ members: [{ ...edgeMember, state: 'active' }] }))
        .toMatchObject({ status: 'ready', placements: [
            { nativeServer: 'private_app', listener: 'privateOrigin' }, { nativeServer: 'public_app', listener: 'public' },
        ] });
    expect(selectDomainCaddyPlacements({ members: [member, peer] }))
        .toMatchObject({ status: 'unavailable' });
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
            .toEqual({ status: 'unavailable', reason: 'required_fact_unavailable', machineIds: ['a', 'b'] });
    }
    expect(selectDomainCaddyPlacements({ ingress: { kind: 'cloudflareTunnel' }, members: [member, peer, { ...joining, state: 'active' }] }))
        .toEqual({ status: 'unavailable', reason: 'required_fact_unavailable', machineIds: ['a', 'b', 'joining'] });
});

it.skipIf(process.platform === 'win32').each(['shared', 'misdirected discovery', 'administrator access off', 'managed CLI unavailable', 'native Caddy port occupied', 'native Caddy host port occupied'] as const)(
    'carries the complete shared origin through the real controller and private child transport: %s', async scenario => {
    const environment = createDeploymentEnvironmentDetailV1();
    environment.content.ingress = { kind: 'cloudflareTunnel' };
    environment.environment.owner = { kind: 'account', accountId: 'owner' };
    const link = environment.targetLinks[0]!.targetLink;
    link.machines = ['a', 'b'];
    link.members = [{ machineId: 'a', installationId: 'installed-a', state: 'active' },
        { machineId: 'b', installationId: 'installed-b', state: 'active' }];
    const occupiedPort = scenario === 'native Caddy port occupied' || scenario === 'native Caddy host port occupied';
    if (scenario === 'administrator access off' || scenario === 'managed CLI unavailable' || occupiedPort) {
        delete environment.content.ingress;
        link.members = [link.members[0]!];
        link.machines = ['a'];
    }
    if (occupiedPort) { link.state = 'deployed'; link.activeDeploymentId = 'serving'; }
    const observations = await Promise.all([observed('100.70.0.2', 9381), observed('100.70.0.3', 9381)]);
    const nativeRuntime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'fixture', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://domain-origin.test', machineId: 'a',
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        async acquirePluginRuntimeRegistryLease() { throw new Error('Uses the active deployed service'); } });
    let installed: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    if (occupiedPort) {
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
        await installed.lease.registry.projectManagedServices.superviseProject({ kind: 'environment', serverId: 'home',
            machineId: 'a', environmentId: environment.environment.id, environmentInstanceId: 'deployed', deploymentId: 'serving', release,
            composeService: 'web', serviceId: 'deployed/web', specIdentity: 'web', isCurrent: () => true,
            releaseObservation: async () => {}, nativeEffects: { keys: [] }, processSpec: { mode: { kind: 'native', builtinLifecycle: {
                async inspect() { return { phase: 'running', readiness: 'ready', endpoint: 'http://127.0.0.1:32771' }; },
                async stop() { return { status: 'stopped' }; },
                nativeContainers: () => [{ id: 'healthy-web', composeProject: 'deployed', service: 'web', containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
                nativeDocker: async () => ({ engineId: 'engine-a', async run(args) {
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
                } }),
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
    const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`, encryption: null };
    const documents = new Map<string, Record<string, unknown>>();
    for (const [id, kind, content] of [[environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content],
        [link.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {}],
        [input.contentArtifactId, 'deployment-domain.v1', DeploymentDomainContentV1Schema.parse({
            hostname: 'qa-domain-1101-ingress.localhost', target: { service: 'web', containerPort: 80 },
            healthCheck: { path: '/', expectStatus: 200 } })]] as const) {
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
                ...(occupiedPort ? {
                    metadataVersion: 1, daemonStateVersion: 1,
                    metadata: encodePlainMachineStoredContent({ host: 'own-server', platform: 'linux', happyCliVersion: '0.3',
                        homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier', adminAccess: { version: 1, mode: 'preauthorized' } }),
                    daemonState: encodePlainMachineStoredContent({ status: 'running', adminAccess: { version: 1, observedAt: 1,
                        daemonUid: 1000, daemonUsername: 'happier', daemonPrimaryGroup: 'happier', daemonIdentity: 'nonRoot',
                        rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid',
                        tailscaledOperator: { authorization: 'unknown' } } }),
                } : {}),
                installationId: `installed-${machineId}`, installationPublicKey: Buffer.from(identity.publicKey).toString('base64') } } };
        }
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        const document = documents.get(path.split('/').at(-1)!);
        if (!document) throw new Error(`Unexpected Domain read ${path}`);
        return { status: 200, data: document };
    });
    const admissions: Array<ReturnType<typeof DeploymentDomainAddAdmissionInputV1Schema.parse>> = [];
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        if (request.method === 'GET') return { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
            environment: environment.environment, targetLinks: [link] }) };
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
                dockerEngineId: placement.dockerEngineId, content: { contentArtifactId: input.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } })) });
        return { status: 200, data: { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1, domain } };
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } })));
    const channel = await createRequesterCurrentnessSocketHarness();
    const children: Array<ReturnType<typeof DeploymentDomainChildRpcV1Schema.parse>> = [];
    type RpcCall = Parameters<ClientToServerEvents[typeof SOCKET_RPC_EVENTS.CALL]>[0];
    channel.server.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, async (call: RpcCall, acknowledge: (result: unknown) => void) => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, call.params, call.method);
            const job = DeploymentChildRpcV1Schema.parse(decoded.params);
            if (occupiedPort) {
                const nativeIdentity = { version: 1 as const, installationId: 'installed-a', createdAt: 1,
                    publicKey: Buffer.from(identity.publicKey).toString('base64url'), privateKey: Buffer.from(identity.secretKey).toString('base64url') };
                vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue(nativeIdentity);
                try {
                    if (job.kind === 'domain') children.push(DeploymentDomainChildRpcV1Schema.parse(job));
                    const result = await memberDeps!.deploymentChild(job, {});
                    acknowledge({ ok: true, result });
                } finally {
                    vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue({ ...nativeIdentity, installationId: 'controller-installation' });
                }
                return;
            }
            if (job.kind === 'domainDiscover') {
                if (scenario === 'managed CLI unavailable') {
                    acknowledge({ ok: true, result: { ok: false, errorCode: 'managed_cli_unavailable',
                        error: 'managed_cli_unavailable', details: { recovery: { kind: 'install_managed_cli',
                            executablePath: '/managed/cli/current/happier' } } } });
                    return;
                }
                if (scenario === 'administrator access off') {
                    acknowledge({ ok: true, result: { ok: false, errorCode: 'mode_none', error: 'mode_none' } });
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
        machineId: 'controller', installationId: 'controller-installation', actionId: 'deployments.domains.add',
        environmentId: input.environmentId, deploymentChildRoot: true, requestId: envelope.requestId, accountEncryptionMode: 'plain', target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.domains.add', input) } });
    const requester = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
        machineId: 'controller', installationId: 'controller-installation', installationPrivateKey: identity.secretKey,
        serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://domain-origin.test', ownCredentials: credentials,
        isCurrent: async () => true, createExecutor: () => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps }) });
    try {
        if (!requester) throw new Error('Expected admitted Domain requester');
        const result = await deps.deploymentAction('deployments.domains.add', input, { externalActionExecutionAuthorization: requester.authorization,
            originalActionEnvelope: envelope, externalActionTarget: target, actionRequestId: envelope.requestId,
            operationAcceptance: { operationId: 'domain-operation', accept() {} } });
        if (scenario === 'administrator access off') {
            expect(result).toMatchObject({ ok: false, errorCode: 'machine_admin_access_required' });
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(0);
        } else if (scenario === 'managed CLI unavailable') {
            expect(result).toMatchObject({ ok: false, errorCode: 'managed_cli_unavailable', details: {
                recovery: { kind: 'install_managed_cli', executablePath: '/managed/cli/current/happier' },
            } });
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
