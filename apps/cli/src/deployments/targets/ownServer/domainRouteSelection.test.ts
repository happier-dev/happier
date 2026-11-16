import { Resolver } from 'node:dns/promises';
import * as nativeFs from 'node:fs/promises';
import { mkdtemp, writeFile, readFile, mkdir, chmod, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { Server as TcpServer } from 'node:net';
import { PassThrough, Transform } from 'node:stream';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { logger } from '@/ui/logger';
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
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentDomainContentV1Schema, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, machineSecretGrantSubjectKey } from '@happier-dev/deployment-protocol';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import * as installationStore from '@/daemon/identity/store';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import type { ClientToServerEvents } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import type { DeploymentArtifactDocumentV1, DeploymentDomainContentV1 } from '@happier-dev/deployment-protocol';
import { createNativeCaddyRoutes, createNativeCaddyAdminExchange } from '@/machines/reachability/nativeCaddyRoutes';
import { materializeCaddyDomainRouteV1, type CaddyDomainRouteInput } from './caddyRouteMaterialization';
import { selectEdgeCaddyDomainRoute, selectPrivateCaddyOriginNetwork, selectDomainCaddyPlacements, selectDomainPublicCaddyServer,
    readDomainCaddyStartFirstLegs, readExpectedDownDomainReferencesForHost, selectDomainIngressMembers } from './domainRouteSelection';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createDeploymentSourceMaterializationPort } from './exactCommitRelease';
import { createScmBackendRegistry } from '@/scm/registry';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { resolveInstalledMachineEffectCli } from '@/machines/adminAccess/runElevatedEffect';
import { settleMachineCaddyFirewallForHost } from '@/machines/reachability/machineReachabilityHost';
import { MachineEffectInternalRequestSchema, MachineEffectInternalRecordSchema } from '@/machines/setup/effectInternalProtocol';
import { MachineElevationFailureV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
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
import { runMachineSetupEffectInternal } from '@/machines/setup/effectInternal';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';

const retainedConnector = {
    subject: { v: 1 as const, kind: 'connectorToken' as const, machineId: 'a', installationId: 'installed-a',
        provider: { kind: 'builtin' as const, id: 'cloudflareNamed' as const }, connectorId: 'environment-tunnel' },
    imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0', networkName: 'deployed_default',
    tokenPath: '/etc/cloudflared/happier-environment-tunnel.token', token: 'fixture-private-connector-token', id: 'f'.repeat(64),
};

const seedFs = vi.hoisted(() => ({ root: '' }));
// Translate privileged filesystem paths only; the real file backend reads,
// checks ownership and digests, stages and atomically activates the seed.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    const path = <T,>(value: T): T => {
        if (!seedFs.root || typeof value !== 'string') return value;
        if (value === '/var/lib/happier' || value.startsWith('/var/lib/happier/'))
            return (seedFs.root + '/state' + value.slice('/var/lib/happier'.length)) as T;
        if (value === '/run/happier-caddy' || value.startsWith('/run/happier-caddy/'))
            return (seedFs.root + '/admin' + value.slice('/run/happier-caddy'.length)) as T;
        if (value === '/etc/cloudflared' || value.startsWith('/etc/cloudflared/'))
            return (seedFs.root + '/cloudflared' + value.slice('/etc/cloudflared'.length)) as T;
        return value;
    };
    const protectedConnectorPath = (value: unknown) => seedFs.root && typeof value === 'string'
        && (value === '/etc/cloudflared' || value.startsWith('/etc/cloudflared/'));
    return { ...actual,
        lstat: async (...args: Parameters<typeof actual.lstat>) => {
            const stat = await actual.lstat(path(args[0]), args[1]);
            return protectedConnectorPath(args[0]) ? Object.assign(stat, { uid: 0, gid: 0 }) : stat;
        },
        readFile: (...args: Parameters<typeof actual.readFile>) => actual.readFile(path(args[0]), args[1]),
        writeFile: (...args: Parameters<typeof actual.writeFile>) => actual.writeFile(path(args[0]), args[1], args[2]),
        mkdir: (...args: Parameters<typeof actual.mkdir>) => actual.mkdir(path(args[0]), args[1]),
        chmod: (...args: Parameters<typeof actual.chmod>) => actual.chmod(path(args[0]), args[1]),
        chown: async (...args: Parameters<typeof actual.chown>) => {
            if (protectedConnectorPath(args[0])) { await actual.lstat(path(args[0])); return; }
            await actual.chown(path(args[0]), args[1], args[2]);
        },
        mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
            const physical = await actual.mkdtemp(path(args[0]), args[1]);
            return protectedConnectorPath(args[0]) ? '/etc/cloudflared' + String(physical).slice((seedFs.root + '/cloudflared').length)
                : seedFs.root && String(args[0]).startsWith('/var/lib/happier/')
                    ? '/var/lib/happier' + String(physical).slice((seedFs.root + '/state').length) : physical;
        },
        rename: (...args: Parameters<typeof actual.rename>) => actual.rename(path(args[0]), path(args[1])),
        rm: (...args: Parameters<typeof actual.rm>) => actual.rm(path(args[0]), args[1]),
    };
});
vi.mock('node:http', async importOriginal => {
    const actual = await importOriginal<typeof import('node:http')>();
    return { ...actual, request: new Proxy(actual.request, { apply(target, receiver, args) {
        const options: unknown = args[0];
        if (seedFs.root && options && typeof options === 'object' && 'socketPath' in options
            && options.socketPath === '/run/happier-caddy/admin.sock')
            args[0] = { ...options, socketPath: `${seedFs.root}/admin/admin.sock` };
        return Reflect.apply(target, receiver, args);
    } }) };
});
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, watch: new Proxy(actual.watch, { apply(target, receiver, args) {
        if (seedFs.root && args[0] === '/run/happier-caddy') args[0] = `${seedFs.root}/admin`;
        return Reflect.apply(target, receiver, args);
    } }) };
});

const roots: string[] = [], servers: Server[] = [], adminFixtureFailures: string[] = [];
const nativeDocker = new Map<string, ProjectNativeDockerPort>();
const unavailableAdmin = new Set<string>();
const refusedAdminWrites = new Set<string>();
const pendingSeedOperations: Array<{ abort(): void; settled: Promise<unknown> }> = [];
afterEach(async () => {
    const pending = pendingSeedOperations.splice(0);
    pending.forEach(operation => operation.abort());
    await Promise.allSettled(pending.map(operation => operation.settled));
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    nativeDocker.clear();
    unavailableAdmin.clear();
    refusedAdminWrites.clear();
    seedFs.root = '';
    expect(adminFixtureFailures.splice(0)).toEqual([]);
});
const network = (address: string): MachinePrivateNetworkObservationV1 => ({ provider: { kind: 'builtin', id: 'tailscale' },
    networkIdentity: 'tailnet-a', interfaceName: 'tailscale0', addresses: [address], sourceRanges: ['100.64.0.0/10'],
    displayName: null, dnsName: null, magicDnsEnabled: false, state: 'ready' });
const ok = (stdout: string): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });

/** Docker is the system boundary; mounted seed and live Unix HTTP are real. */
async function observed(address: string, port: number, edge = false,
    installed: readonly CaddyDomainRouteInput[] = [], containerNetwork: Readonly<{
        name?: string; address?: string | null; additionalPorts?: readonly number[]; retainedSeed?: string;
        retainedPublicPorts?: Record<string, { HostIp: string; HostPort: string }[]>;
        retainedPublicDomain?: CaddyDomainRouteInput;
        failNetworkConnect?: boolean;
        retiredNetwork?: boolean;
        runningRetained?: boolean;
    }> = {}, produced?: ReturnType<NonNullable<ReturnType<typeof createOwnServerDeploymentRuntimeForHost>['prepareDomainCaddy']>>): Promise<NativeCaddyObservationResult> {
    const root = await mkdtemp('/tmp/hde-'); roots.push(root);
    if (containerNetwork.retainedSeed !== undefined) {
        seedFs.root = root;
        await mkdir(join(root, 'state', 'caddy'), { recursive: true });
        await mkdir(join(root, 'admin'));
        await chmod(join(root, 'state'), 0o711);
        await chmod(join(root, 'state', 'caddy'), 0o750);
        await chmod(join(root, 'admin'), 0o750);
        for (const name of ['data', 'config', 'logs']) {
            await mkdir(`/var/lib/happier/caddy/${name}`, { mode: 0o700 });
            await chmod(`/var/lib/happier/caddy/${name}`, 0o700);
        }
        await writeFile('/var/lib/happier/caddy/data/incumbent-certificate', 'retained certificate bytes');
        await mkdir('/etc/cloudflared', { mode: 0o755 });
        await chmod('/etc/cloudflared', 0o755);
        await writeFile(retainedConnector.tokenPath, retainedConnector.token, { mode: 0o600 });
        await chmod(retainedConnector.tokenPath, 0o600);
        await writeFile('/var/lib/happier/caddy/initial.json', containerNetwork.retainedSeed, { mode: 0o640 });
        await chmod('/var/lib/happier/caddy/initial.json', 0o640);
    }
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
    if (containerNetwork.retainedPublicDomain) {
        const material = materializeCaddyDomainRouteV1(containerNetwork.retainedPublicDomain);
        const publicServer = config.apps.http.servers.happier_public;
        publicServer.routes.unshift(material.route);
        if (material.fallbackRoute) publicServer.errors.routes.push(material.fallbackRoute);
        if (material.tls) {
            publicServer.tls_connection_policies.push(material.tls.connectionPolicy);
            config.apps.http.servers.happier_public_http.routes.unshift(material.tls.redirectRoute);
            if (material.tls.automationPolicy) config.apps.tls.automation.policies.push(material.tls.automationPolicy);
        }
    }
    const server = createServer((request, response) => {
        if (request.method !== 'GET' && refusedAdminWrites.has(join(root, 'admin.sock'))) {
            response.writeHead(400).end(JSON.stringify({ error: 'private-native-response-must-not-escape' })); return;
        }
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
                else if (request.method === 'DELETE' && Array.isArray(parent)) parent.splice(Number(key), 1);
                else if (request.method === 'DELETE') Reflect.deleteProperty(parent, key);
                else throw new Error(`Unexpected native method ${request.method}`);
                response.end('{}');
            })().catch(() => { adminFixtureFailures.push(request.method ?? 'unknown'); response.writeHead(500).end(); });
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
    const socketPath = join(root, containerNetwork.retainedSeed === undefined ? 'admin.sock' : 'admin/admin.sock');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
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
    if (containerNetwork.retainedSeed !== undefined && produced?.status === 'ready') {
        Object.assign(container.Config, { User: `0:${process.getgid!()}` });
        Object.assign(container.HostConfig, { PortBindings: containerNetwork.retainedPublicPorts ?? {}, Mounts: [
            ...['data', 'config', 'logs'].map(name => ({ Type: 'bind', Source: `/var/lib/happier/caddy/${name}`,
                Target: name === 'logs' ? '/var/log/happier-caddy' : `/${name}`, ReadOnly: false })),
            { Type: 'bind', Source: '/run/happier-caddy', Target: '/run/happier-caddy', ReadOnly: false },
            { Type: 'bind', Source: '/var/lib/happier/caddy/initial.json', Target: '/etc/caddy/happier.json', ReadOnly: true },
        ] });
    }
    let recoveryRunning = containerNetwork.retainedSeed === undefined || containerNetwork.retainedPublicDomain !== undefined || containerNetwork.runningRetained === true;
    let recreated = false;
    let removed = false;
    if (containerNetwork.retiredNetwork) {
        container.HostConfig.NetworkMode = 'retired_default';
        container.NetworkSettings.Networks = { incumbent_default: { IPAddress: '172.18.0.2' } };
    }
    nativeDocker.set(containerNetwork.retainedSeed === undefined ? socketPath : '/run/happier-caddy/admin.sock', { engineId: 'engine-a', async run(args, signal) {
        if (containerNetwork.retainedSeed !== undefined && args.some(arg => arg.startsWith('name=^/happier-cloudflared-')))
            return { exitCode: 0, stdout: JSON.stringify(retainedConnector.id), stderr: '' };
        if (containerNetwork.retainedSeed !== undefined && args.includes(retainedConnector.id)) {
            if (args.includes('inspect')) return { exitCode: 0, stdout: JSON.stringify([{
                Id: retainedConnector.id, Name: `/happier-cloudflared-${retainedConnector.subject.connectorId}`, State: { Running: true },
                Config: { Image: retainedConnector.imageRef, User: '0:0', Entrypoint: ['cloudflared'],
                    Labels: { 'dev.happier.machine-setup.recipe': 'cloudflare-connector@1' },
                    Cmd: ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:20241', 'run', '--token=', '--token-file', retainedConnector.tokenPath] },
                HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: retainedConnector.networkName,
                    Privileged: false, ReadonlyRootfs: true, PublishAllPorts: false, PortBindings: null, Binds: null,
                    CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
                    Mounts: [{ Type: 'bind', Source: retainedConnector.tokenPath, Target: retainedConnector.tokenPath, ReadOnly: true }] },
                NetworkSettings: { Networks: { [retainedConnector.networkName]: {} } },
            }]), stderr: '' };
            if (args.includes('--version')) return { exitCode: 0, stdout: `cloudflared version ${retainedConnector.version}\n`, stderr: '' };
            if (args.includes('ready') || args.includes('restart')) return { exitCode: 0, stdout: '', stderr: '' };
            throw new Error('Unexpected retained connector Docker operation');
        }
        if (args[0] === 'network' && args[1] === 'ls') return { exitCode: 0,
            stdout: ['deployed_default', ...Object.keys(container.NetworkSettings.Networks)].map(name => `id-${name} ${name}`).join('\n'), stderr: '' };
        if (args.includes('ls')) return { exitCode: 0, stdout: removed ? '' : JSON.stringify(container.Id), stderr: '' };
        if (args.includes('inspect')) {
            const retained = containerNetwork.retainedSeed !== undefined;
            return { exitCode: 0, stdout: JSON.stringify([{ ...container,
                State: { Running: recoveryRunning, Status: recoveryRunning ? 'running' : 'created', ExitCode: recoveryRunning || recreated ? 0 : 128 },
                ...(retained ? { HostConfig: { ...container.HostConfig, PortBindings: recreated ? {} : containerNetwork.retainedPublicPorts },
                    NetworkSettings: { Networks: recoveryRunning || recreated ? container.NetworkSettings.Networks : {},
                        Ports: containerNetwork.retainedPublicDomain ? containerNetwork.retainedPublicPorts : {} } } : {}),
            }]), stderr: '' };
        }
        if (containerNetwork.failNetworkConnect && args[0] === 'network' && args[1] === 'connect')
            return { exitCode: 1, stdout: '', stderr: 'network attachment failed' };
        if (containerNetwork.retiredNetwork && args[0] === 'network' && args[1] === 'connect') {
            if (!recreated) return { exitCode: 1, stdout: '', stderr: 'network retired_default not found' };
            container.NetworkSettings.Networks[args[2]!] = { IPAddress: '172.19.0.2' };
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (containerNetwork.retiredNetwork && args[0] === 'container' && args[1] === 'stop') {
            recoveryRunning = false;
            return { exitCode: 0, stdout: container.Id, stderr: '' };
        }
        if (containerNetwork.retainedSeed !== undefined && args.includes('rm')) {
            expect(recoveryRunning).toBe(false);
            removed = true;
            return { exitCode: 0, stdout: container.Id, stderr: '' };
        }
        if (containerNetwork.retainedSeed !== undefined && args.includes('create')) {
            expect(removed).toBe(true);
            expect(args).not.toContain('--publish');
            container.HostConfig.NetworkMode = args[args.indexOf('--network') + 1]!;
            container.NetworkSettings.Networks = { [container.HostConfig.NetworkMode]: { IPAddress: '172.19.0.2' } };
            recreated = true;
            removed = false;
            return { exitCode: 0, stdout: container.Id, stderr: '' };
        }
        if (containerNetwork.retainedSeed !== undefined && args.includes('start')) {
            recoveryRunning = true;
            return { exitCode: 0, stdout: container.Id, stderr: '' };
        }
        if (containerNetwork.retainedSeed !== undefined && args.includes('wait')) {
            await new Promise<void>(resolve => {
                if (!signal || signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
            });
            return { exitCode: 1, stdout: '', stderr: '' };
        }
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
    expect(await readExpectedDownDomainReferencesForHost(input)).toEqual(['web', 'api', 'alias'].map(domainId => ({
        environmentId: 'environment', targetLinkId: 'link', domainId, machineId: 'a', installationId: 'installed-a' })));
    expect(JSON.stringify(selected)).not.toContain('native-only-hash');
    expect(JSON.stringify(selected)).not.toContain('native-only-certificate');
    expect(JSON.stringify(selected)).not.toContain('native-only-private-key');
    const single = (domains: typeof headers) => async () => DeploymentDomainListResultV1Schema.parse({ ok: true,
        environmentId: 'environment', revision: 1, domains, nextCursor: null });
    const twoEdges = { ...headers[0]!, placements: ['edge-a', 'edge-b'].map(machineId => ({
        ...headers[0]!.placements![0]!, placement: { ...placement('web'), machineId, installationId: `installed-${machineId}` },
    })) };
    expect(await readExpectedDownDomainReferencesForHost({ ...input, list: single([twoEdges]) })).toEqual(
        ['edge-a', 'edge-b'].map(machineId => ({ environmentId: 'environment', targetLinkId: 'link', domainId: 'web',
            machineId, installationId: `installed-${machineId}` })));
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
    expect(await readExpectedDownDomainReferencesForHost({ ...input, list: single([remote]) })).toEqual([]);
    expect(await readExpectedDownDomainReferencesForHost({ ...input, list: single([headers[0]!]), open: async () => null })).toBeNull();
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

it('selects a public-only Caddy placement for a draft without workload membership or a private listener', () => {
    const server = { serverId: 'public_app', listen: [':443'], tls: true, automaticHttpsDisabled: false,
        endpoints: [{ hostAddress: '0.0.0.0', hostPort: 443, containerPort: 443 }] };
    const caddy = { status: 'ready' as const, containerId: 'caddy-edge', containerName: 'happier-caddy',
        adminSocketPath: '/run/caddy/admin.sock', networkNames: [], servers: [server] } satisfies NativeCaddyObservationResult;
    const host = { machineId: 'edge', installationId: 'edge-installation', dockerEngineId: 'edge-engine', caddy };
    expect(selectDomainPublicCaddyServer(host)).toEqual({ status: 'ready', nativeServer: server.serverId });
    expect(selectDomainPublicCaddyServer({ ...host, caddy: { status: 'needs_setup' } })).toEqual({
        status: 'unavailable', reason: 'required_fact_unavailable', machineIds: [host.machineId],
        details: { requiredFact: 'publicCaddyObservation' },
    });
    for (const servers of [[], [{ ...server, endpoints: [] }], [server, { ...server, serverId: 'second_public' }]]) {
        expect(selectDomainPublicCaddyServer({ ...host, caddy: { ...caddy, servers } })).toEqual({
            status: 'unavailable', reason: 'required_fact_unavailable', machineIds: [host.machineId],
            details: { requiredFact: 'publicCaddyListener' },
        });
    }
});

it('names the missing serving members and leaves their one remedy to the recovery owner', () => {
    const unavailable = { status: 'unavailable', reason: 'required_fact_unavailable',
        details: { requiredFact: 'activeDomainMembers' } };
    // The recovery owner's sentence and its Deploy are one remedy; a second authored sentence would disagree (DEPLOY-REACCEPT-1113 D7).
    for (const result of [selectDomainCaddyPlacements({ members: [] }), selectPrivateCaddyOriginNetwork({ observerNetworks: [], members: [] })]) {
        expect(result).toMatchObject(unavailable);
        expect(result.status === 'unavailable' ? result.details : undefined).not.toHaveProperty('remedy');
    }
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
        .toMatchObject({ status: 'unavailable', details: { requiredFact: 'domain_ingress_required', remedy: expect.any(String) } });
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
    const joiningReady = { ...joining, caddy: b };
    const membershipMachines = [member, peer, joiningReady].map(({ machineId, installationId }) => ({ machineId, installationId }));
    const enrolled = selectDomainCaddyPlacements({ ingress: { kind: 'cloudflareTunnel' },
        members: selectDomainIngressMembers([member, peer, joiningReady], membershipMachines) });
    expect(enrolled).toMatchObject({ status: 'ready', placements: [
        { machineId: 'a' }, { machineId: 'b' }, { machineId: 'joining' },
    ], tunnelOrigin: { members: [{ machineId: 'a' }, { machineId: 'b' }, { machineId: 'joining' }] } });
    const drained = selectDomainCaddyPlacements({ ingress: { kind: 'cloudflareTunnel' },
        members: selectDomainIngressMembers([member, peer, joiningReady], [membershipMachines[0]!, membershipMachines[2]!]) });
    expect(drained).toMatchObject({ status: 'ready', placements: [{ machineId: 'a' }, { machineId: 'joining' }],
        tunnelOrigin: { members: [{ machineId: 'a' }, { machineId: 'joining' }] } });
});

it.skipIf(process.platform === 'win32').each(['membership join installed', 'membership drain', 'shared', 'no active Domain members', 'Domain Environment HTTP unavailable', 'Domain Home purpose refused', 'missing tunnel origin', 'misdirected discovery', 'administrator access off', 'administrator access not applied', 'administrator elevation denied', 'administrator native check unavailable', 'administrator native outcome unknown', 'administrator native outcome unknown with fact', 'managed CLI unavailable', 'network review required', 'firewall prerequisite failed', 'firewall policy unavailable', 'firewall partial failure', 'daemon ACK unavailable', 'daemon ACK unknown', 'Remove native parsed output invalid', 'Remove malformed native observation', 'native cancelled', 'direct installed Caddy', 'direct installed Caddy redirect', 'incumbent receipt joining member', 'incumbent other installation', 'incumbent no serving release', 'direct installed Caddy admin write refused', 'direct installed Caddy admin unavailable', 'native Caddy port occupied', 'native Caddy host port occupied', ...(process.platform === 'linux' ? ['native Caddy privileged host port occupied'] as const : []), 'Tunnel retained public seed', 'Tunnel foreign seed', 'Tunnel running public Caddy', 'Tunnel running private network failure', 'Tunnel running private retired network'] as const)(
    'carries the complete shared origin through the real controller and private child transport: %s', async scenario => {
    const noActiveDomainMembers = scenario === 'no active Domain members' || scenario === 'incumbent other installation'
        || scenario === 'incumbent no serving release';
    const incumbentJoining = scenario === 'incumbent receipt joining member' || scenario === 'incumbent other installation'
        || scenario === 'incumbent no serving release';
    const membership = scenario === 'membership join installed' || scenario === 'membership drain';
    const removingNativeOutput = scenario === 'Remove native parsed output invalid' || scenario === 'Remove malformed native observation';
    const nativeOutcomeUnknown = scenario === 'administrator native outcome unknown'
        || scenario === 'administrator native outcome unknown with fact';
    const nativeUnknownWithFact = scenario === 'administrator native outcome unknown with fact';
    const nativeCheckFailure = MachineElevationFailureV1Schema.parse({ kind: 'native_check_unavailable',
        phase: 'check', stepId: 'caddy-initial-config', reason: 'foreign_effect_conflict', requiredFact: 'caddy-initial-config',
        remedy: 'Inspect and reconcile the existing Caddy seed before retrying the Domain operation.' });
    const nativeUnknownFailure = MachineElevationFailureV1Schema.parse({ ...nativeCheckFailure, kind: 'native_effect_failed' });
    const environment = createDeploymentEnvironmentDetailV1();
    const adminWriteRefused = scenario === 'direct installed Caddy admin write refused';
    const recordedReplicaCase = scenario === 'direct installed Caddy' || scenario === 'direct installed Caddy redirect';
    // A public Add settles from its finite DNS observation; private origins
    // (including Tunnel activation) do not demand public DNS proof.
    const activationDns = recordedReplicaCase ? vi.spyOn(Resolver.prototype, 'resolve').mockResolvedValue([]) : undefined;
    const networkConnectFailure = scenario === 'Tunnel running private network failure';
    // File logging is the diagnostic boundary; keep the real controller/native path.
    const nativeWarnings = networkConnectFailure ? vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {}) : undefined;
    const retiredNetwork = scenario === 'Tunnel running private retired network';
    const runningPublic = scenario === 'Tunnel running public Caddy';
    const retainedSeed = scenario === 'Tunnel retained public seed' || scenario === 'Tunnel foreign seed' || runningPublic || retiredNetwork || networkConnectFailure;
    const incumbentPublicDomain: CaddyDomainRouteInput = { domainId: 'incumbent-public',
        domain: { hostname: 'incumbent.example.test', target: { service: 'web', containerPort: 80 } },
        listener: 'public', upstreams: { kind: 'replicas', containerNames: ['deployed-web-1'] },
        privateSourceRanges: [], publicTls: { kind: 'managed' } };
    environment.content.ingress = { kind: 'cloudflareTunnel' };
    environment.environment.owner = { kind: 'account', accountId: 'owner' };
    const link = environment.targetLinks[0]!.targetLink;
    link.machines = ['a', 'b'];
    link.members = [{ machineId: 'a', installationId: 'installed-a', state: 'active' },
        { machineId: 'b', installationId: 'installed-b', state: 'active' }];
    if (scenario !== 'shared' && scenario !== 'misdirected discovery' && scenario !== 'missing tunnel origin' && scenario !== 'membership drain') {
        if (!retainedSeed) delete environment.content.ingress;
        link.members = [link.members[0]!];
        link.machines = ['a'];
    }
    if (noActiveDomainMembers || incumbentJoining) link.members[0]!.state = 'joining';
    if (scenario === 'no active Domain members') delete link.activeDeploymentId;
    if (scenario === 'membership join installed') link.members[0]!.state = 'joining';
    const occupiedPort = scenario === 'native Caddy port occupied' || scenario === 'native Caddy host port occupied' || scenario === 'native Caddy privileged host port occupied';
    const installedCaddy = incumbentJoining || scenario === 'direct installed Caddy admin write refused' || recordedReplicaCase || scenario === 'membership join installed' || scenario === 'direct installed Caddy admin unavailable' || occupiedPort || retainedSeed;
    if (installedCaddy) {
        link.state = 'deployed';
        link.activeDeploymentId = 'serving';
    }
    const nativeRuntime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'fixture', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://domain-origin.test', machineId: 'a',
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        async acquirePluginRuntimeRegistryLease() { throw new Error('Uses the active deployed service'); } });
    const prepared = scenario !== 'shared' && scenario !== 'misdirected discovery' && scenario !== 'missing tunnel origin' && scenario !== 'membership drain' ? nativeRuntime.prepareDomainCaddy!({
        domain: { hostname: 'qa-domain-1101-r23b.localhost', target: { service: 'web', containerPort: 80 } },
        environment: environment.content, replicas: [{ containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
        privateNetworks: [], daemonGroup: 'happier', daemonGroupId: 1000,
    }) : undefined;
    const publicPrepared = retainedSeed ? nativeRuntime.prepareDomainCaddy!({
        domain: { hostname: 'qa-domain-1101-r23b.localhost', target: { service: 'web', containerPort: 80 } },
        environment: { ...environment.content, ingress: undefined },
        replicas: [{ containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
        privateNetworks: [], daemonGroup: 'happier', daemonGroupId: process.getgid!(),
    }) : undefined;
    if (publicPrepared && publicPrepared.status !== 'ready') throw new Error('Expected producer-built public Caddy seed');
    const publicSeed = publicPrepared?.status === 'ready' ? publicPrepared.input.initialConfig : undefined;
    if (publicSeed !== undefined) {
        // Exact initial.json observed on the native Caddy guest, 2026-11-06.
        expect(Buffer.byteLength(publicSeed)).toBe(782);
        expect(createHash('sha256').update(publicSeed).digest('hex'))
            .toBe('3f37b3a617aa0eb51a90426e099d73adbfd4a3432d5d23ea4001d72cad97b6cb');
    }
    const installedSeed = scenario === 'Tunnel foreign seed' ? publicSeed!.replace('404', '200') : publicSeed;
    const observations = await Promise.all([observed('100.70.0.2', 9381, false, [],
        prepared ? { name: 'deployed_default', ...(installedSeed === undefined ? {} : { retainedSeed: installedSeed,
            retainedPublicPorts: Object.fromEntries((publicPrepared?.status === 'ready' ? publicPrepared.input.publicBindings ?? [] : []).map(binding => [
                `${binding.containerPort ?? binding.hostPort}/${binding.protocol}`, [{ HostIp: binding.hostAddress, HostPort: String(binding.hostPort) }],
            ])),
            ...(runningPublic ? { retainedPublicDomain: incumbentPublicDomain } : {}),
            ...(networkConnectFailure ? { failNetworkConnect: true } : {}),
            ...(retiredNetwork ? { retiredNetwork: true } : {}),
            ...(retiredNetwork || networkConnectFailure ? { runningRetained: true, retainedPublicPorts: {} } : {}),
        }) }
            : scenario === 'missing tunnel origin' ? { address: null } : {}, runningPublic ? publicPrepared : prepared), observed('100.70.0.3', 9381)]);
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
                nativeContainers: () => [{ id: 'healthy-web', composeProject: 'deployed', service: 'web', containerName: 'deployed-web-1',
                    networkNames: ['deployed_default', ...(networkConnectFailure ? ['deployed_extra'] : [])] },
                    ...(recordedReplicaCase ? [
                        { id: 'second-web', composeProject: 'deployed', service: 'web', containerName: 'deployed-web-2', networkNames: ['deployed_default'] },
                        { id: 'database', composeProject: 'deployed', service: 'db', containerName: 'deployed-db-1', networkNames: ['deployed_default'] },
                    ] : [])],
                nativeDocker: async () => occupiedPort ? { engineId: 'engine-a', async run(args) {
                    if (args.includes('--all')) return { exitCode: 0, stdout: '', stderr: '' };
                    if (scenario === 'native Caddy host port occupied' || scenario === 'native Caddy privileged host port occupied') {
                        if (scenario === 'native Caddy privileged host port occupied') {
                            const realReadFile = nativeFs.readFile;
                            vi.spyOn(nativeFs, 'readFile').mockImplementation(async (...args: Parameters<typeof realReadFile>) => {
                                if (args[0] === '/proc/net/tcp') return '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0300007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 123\n';
                                if (args[0] === '/proc/net/tcp6') return '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
                                return realReadFile(...args);
                            });
                        }
                        // The server is the OS boundary; the Domain acquisition,
                        // port owner and public failure projection remain real.
                        vi.spyOn(TcpServer.prototype, 'listen').mockImplementation(function (this: TcpServer) {
                            queueMicrotask(() => this.emit('error', Object.assign(new Error('native listener'), { code: scenario === 'native Caddy privileged host port occupied' ? 'EACCES' : 'EADDRINUSE' })));
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
        contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1,
        ...(membership ? { membershipDeploymentId: 'membership-receipt', membershipMachines: [
            { machineId: 'a', installationId: 'installed-a' },
        ] } : {}) });
    if (!('contentArtifactId' in input)) throw new Error('Expected prepared Domain input');
    const actionId = removingNativeOutput ? 'deployments.domains.remove' as const : 'deployments.domains.add' as const;
    const actionInput = removingNativeOutput ? DeploymentActionInputSchemasV1['deployments.domains.remove'].parse({
        serverId: input.serverId, environmentId: input.environmentId, domainId: input.domainId,
        expectedRevision: input.expectedRevision, expectedDomainRevision: 1, requestKey: 'domain-remove',
    }) : input;
    const domainContent = DeploymentDomainContentV1Schema.parse({
        hostname: 'qa-domain-1101-ingress.localhost', target: { service: 'web', containerPort: 80,
            ...(scenario === 'direct installed Caddy redirect' ? { redirectTo: 'https://destination.example.test' } : {}) },
        healthCheck: { path: '/', expectStatus: 200 },
        // A previously prepared tunnel retains its opaque target grant; this
        // native recovery does not configure the vendor Account again.
        ...(retainedSeed ? { cloudflarePreparation: { tunnelId: retainedConnector.subject.connectorId, owned: [], dnsOwnership: [],
            connectors: [{ machineId: retainedConnector.subject.machineId, installationId: retainedConnector.subject.installationId,
                grantRef: machineSecretGrantSubjectKey(retainedConnector.subject), imageRef: retainedConnector.imageRef,
                version: retainedConnector.version, networkName: retainedConnector.networkName }] } } : {}),
    });
    const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`, encryption: null };
    const incumbent = createDeploymentReceiptDetailV1();
    incumbent.deployment = { ...incumbent.deployment, id: 'serving', environmentId: input.environmentId, targetLinkId: link.id };
    incumbent.content.machines = ['a'];
    incumbent.content.buildMachineId = 'a';
    incumbent.content.machineResults = [{ machineId: 'a', installationId: 'installed-a', currentDeploymentId: 'serving',
        activation: 'succeeded', health: 'healthy', steps: [] }];
    if (scenario === 'incumbent other installation') incumbent.content.machineResults[0]!.installationId = 'retired-installation';
    if (scenario === 'incumbent no serving release') delete incumbent.content.machineResults[0]!.currentDeploymentId;
    createDeploymentReceiptDetailV1(incumbent); // Validate the complete private receipt at the HTTP fixture boundary.
    const documents = new Map<string, Record<string, unknown>>();
    for (const [id, kind, content] of [[environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content],
        [link.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {}],
        [input.contentArtifactId, 'deployment-domain.v1', domainContent],
        [incumbent.deployment.contentArtifactId, 'deployment-receipt.v1', incumbent.content]] as const) {
        documents.set(id, { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ kind, title: 'Domain' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
    }
    const identity = tweetnacl.sign.keyPair();
    const connectorGrant = retainedSeed ? sealMachineSecretGrant({ subject: retainedConnector.subject,
        installationPublicKey: identity.publicKey, content: { kind: 'connectorToken', token: retainedConnector.token } }) : undefined;
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
        installationId: 'controller-installation', createdAt: 1, publicKey: Buffer.from(identity.publicKey).toString('base64url'),
        privateKey: Buffer.from(identity.secretKey).toString('base64url') });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(url).pathname;
        if (path.startsWith('/v1/machines/')) {
            const machineId = path.split('/').at(-1)!;
            return { status: 200, data: { machine: MachinePublishedRowV1Schema.parse({ id: machineId, kind: 'persistent',
                managedMachineRef: null, revokedAt: null, replacedByMachineId: null,
                storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                metadataVersion: 1, daemonStateVersion: 1,
                metadata: encodePlainMachineStoredContent({ host: 'own-server', platform: 'linux', happyCliVersion: '0.3',
                    homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier', adminAccess: { version: 1, mode: 'preauthorized' } }),
                daemonState: encodePlainMachineStoredContent({ status: 'running', adminAccess: { version: 1, observedAt: 1,
                    daemonUid: 1000, daemonUsername: 'happier', daemonPrimaryGroup: 'happier', daemonIdentity: 'nonRoot',
                    rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid',
                    tailscaledOperator: { authorization: 'unknown' } } }),
                installationId: `installed-${machineId}`, installationPublicKey: Buffer.from(identity.publicKey).toString('base64') }) } };
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
        if (retainedSeed && path === '/v1/deployments/machines/a/connector-secret-grant') {
            expect(request.data).toMatchObject({ operation: 'read', subject: retainedConnector.subject,
                hostMachineId: 'a', hostInstallationId: 'installed-a' });
            expect(JSON.stringify(request)).not.toContain(retainedConnector.token);
            return { status: 200, data: { ok: true, grant: connectorGrant } };
        }
        if (request.method === 'GET' && scenario === 'Domain Environment HTTP unavailable') {
            throw Object.assign(new Error('Private network transport context'), { code: 'ECONNRESET' });
        }
        if (request.method === 'GET' && scenario === 'Domain Home purpose refused') {
            expect(request.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toEqual(expect.any(String));
            return { status: 401, data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } };
        }
        if (request.method === 'GET' && path.endsWith('/receipts/serving')) return { status: 200, data: { ok: true, deployment: incumbent.deployment } };
        if (request.method === 'GET') return { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
            environment: environment.environment, targetLinks: [link] }) };
        if (removingNativeOutput) {
            expect(request.method).toBe('POST');
            expect(path).toBe(`/v1/deployments/environments/${input.environmentId}/domains/${input.domainId}/remove`);
            const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: input.domainId, environmentId: input.environmentId,
                targetLinkId: link.id, revision: 2, state: 'removing', contentArtifactId: input.contentArtifactId,
                contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
                placements: [{ placement: { serverId: 'home', accountId: 'owner', environmentId: input.environmentId,
                    targetLinkId: link.id, domainId: input.domainId, machineId: 'a', installationId: 'installed-a',
                    nativeServer: 'private_app', actionOperationId: 'domain-operation', requestId: 'domain-request' },
                    listener: 'privateOrigin', desired: false, dockerEngineId: 'engine-a', content: {
                        contentArtifactId: input.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } }],
            });
            return { status: 200, data: { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1, domain } };
        }
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
    const seedChecks: unknown[] = [];
    type RpcCall = Parameters<ClientToServerEvents[typeof SOCKET_RPC_EVENTS.CALL]>[0];
    channel.server.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, async (call: RpcCall, acknowledge: (result: unknown) => void) => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, call.params, call.method);
            const job = DeploymentChildRpcV1Schema.parse(decoded.params);
            if (removingNativeOutput) {
                children.push(DeploymentDomainChildRpcV1Schema.parse(job));
                // Socket.IO is the native guest boundary. The controller parses
                // and projects this guest result through its real Domain owner.
                acknowledge({ ok: true, result: scenario === 'Remove native parsed output invalid'
                    ? { ok: false, errorCode: 'invalid_provider_output', error: 'invalid_provider_output' }
                    : { state: 'removed' } });
                return;
            }
            if (installedCaddy) {
                const nativeIdentity = { version: 1 as const, installationId: 'installed-a', createdAt: 1,
                    publicKey: Buffer.from(identity.publicKey).toString('base64url'), privateKey: Buffer.from(identity.secretKey).toString('base64url') };
                vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue(nativeIdentity);
                try {
                    if (job.kind === 'domain') {
                        children.push(DeploymentDomainChildRpcV1Schema.parse(job));
                        if (adminWriteRefused && observations[0]?.status === 'ready') refusedAdminWrites.add(observations[0].adminSocketPath);
                    }
                    const controller = new AbortController();
                    const settled = memberDeps!.deploymentChild(job, { actionRequestId: 'domain-operation',
                        ...(retainedSeed ? { signal: controller.signal } : {}) });
                    if (retainedSeed) pendingSeedOperations.push({ abort: () => controller.abort(), settled });
                    const result = await settled;
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
                        revision: 0, management: { providers: [], publicSsh: { kind: 'closed' } },
                        // A saved default is independent of Domain firewall settlement
                        // (MACH-COMPOSE-1107 T2-INGRESS); retain the native cause.
                        defaultServiceIngress: { kind: 'provider', selection: { provider: { kind: 'builtin', id: 'cloudflareNamed' },
                            config: { hostname: 'app.example.test' }, credentialRefs: [] } },
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
                                    stepId: 'firewall', requiredFact: 'firewall',
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
                        acknowledge({ ok: true, result: { ...('cause' in error ? projectDeploymentFailure(String(error.code), error)
                            : { ok: false, errorCode: error.code, error: error.code }),
                            ...('details' in error ? { details: error.details } : {}) } });
                    }
                    if (scenario === 'network review required') expect(metadata).toEqual({});
                    return;
                }
                if (scenario === 'administrator access off' || scenario === 'administrator access not applied'
                    || scenario === 'administrator elevation denied' || scenario === 'administrator native check unavailable' || nativeOutcomeUnknown
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
                                ...(scenario === 'administrator elevation denied' || scenario === 'administrator native check unavailable' || nativeOutcomeUnknown ? { spawn: () => {
                                    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
                                    // The elevated process is the boundary; its real interpreter
                                    // result is validated before the native/Domain owners read it.
                                    const settled = (async () => {
                                        if (scenario === 'administrator native check unavailable' || nativeOutcomeUnknown) {
                                            const lines = createInterface({ input: stdin });
                                            try {
                                                const frames = lines[Symbol.asyncIterator]();
                                                stdout.write('{"type":"ready"}\n');
                                                const frame = await frames.next();
                                                const request = MachineEffectInternalRequestSchema.parse(JSON.parse(frame.value!));
                                                expect(request.mode).toBe('check');
                                                if (nativeOutcomeUnknown && !nativeUnknownWithFact) {
                                                    if (request.mode !== 'check' || !('steps' in request)) throw new Error('Expected native setup CHECK');
                                                    const plan = await checkMachineSetupEffectPlan({ basis: request.basis, steps: request.steps,
                                                        ...(request.checks ? { checks: request.checks } : {}),
                                                        backend: { async observe(step) { return { stepId: step.id, status: 'drifted', facts: {} }; },
                                                            async apply() { throw new Error('The root OS process supplies this result'); } } });
                                                    stdout.write(JSON.stringify({ type: 'result', result: { status: 'checked', plan } }) + '\n');
                                                    const apply = MachineEffectInternalRequestSchema.parse(JSON.parse((await frames.next()).value!));
                                                    expect(apply.mode).toBe('apply');
                                                }
                                                const result = nativeOutcomeUnknown ? nativeUnknownWithFact ? {
                                                    status: 'outcome_unknown', completedStepIds: [], daemonRestartRequired: false,
                                                    stepId: nativeUnknownFailure.stepId, reason: nativeUnknownFailure.reason,
                                                    requiredFact: nativeUnknownFailure.requiredFact, failure: nativeUnknownFailure,
                                                } : { status: 'applied', completedStepIds: [], daemonRestartRequired: false } : {
                                                    status: 'unavailable', completedStepIds: [], daemonRestartRequired: false,
                                                    stepId: nativeCheckFailure.stepId, reason: nativeCheckFailure.reason,
                                                    requiredFact: nativeCheckFailure.requiredFact, failure: nativeCheckFailure,
                                                };
                                                stdout.end(JSON.stringify(MachineEffectInternalRecordSchema.parse({ type: 'result', result })) + '\n');
                                            } finally { lines.close(); }
                                        } else stdout.end();
                                        stderr.end();
                                        return { code: 1, signal: null };
                                    })();
                                    return { stdin, stdout, stderr, settled,
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
            readDesired: () => {
                if (!retainedSeed) throw new Error('Port refusal cannot read setup intent');
                return getMachineSetupDesiredV1({
                    read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 38 }),
                    compareAndSwap: async () => { throw new Error('Domain cannot change Machine policy'); },
                });
            },
            elevation: {
                readPolicy: async () => {
                    if (!retainedSeed) throw new Error('Port refusal cannot request elevation');
                    return { version: 1, mode: 'preauthorized' };
                },
                observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier',
                    daemonPrimaryGroup: 'happier', daemonIdentity: 'nonRoot', rootEquivalentGroups: [],
                    passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }),
                ...(retainedSeed ? { spawn: ((invocation) => {
                    let protectedRoot = false;
                    const stdin = new Transform({ transform(bytes, _encoding, callback) {
                        const frame = MachineEffectInternalRequestSchema.safeParse(JSON.parse(String(bytes)));
                        if (frame.success && 'connectorSecretGrant' in frame.data) protectedRoot = frame.data.connectorSecretGrant === true;
                        callback(null, bytes);
                    } }), stderr = new PassThrough();
                    const stdout = new Transform({ transform(bytes, _encoding, callback) {
                        const record = MachineEffectInternalRecordSchema.safeParse(JSON.parse(String(bytes)));
                        if (record.success && record.data.type === 'result' && record.data.result.status === 'checked' && 'plan' in record.data.result)
                            seedChecks.push(record.data.result.plan.nativeFacts);
                        callback(null, bytes);
                    } });
                    const settled = runMachineSetupEffectInternal(invocation.args.filter(arg =>
                        arg.startsWith('--operation-id=') || arg.startsWith('--installation-id=')), {
                        stdin, stdout, readUid: () => 0, platform: 'linux',
                        runNative: async command => {
                            if (command.executable !== 'getent') throw new Error(`Unexpected root command ${command.executable}`);
                            // The protected connector fixture projects root ownership;
                            // ordinary Caddy files retain the executing test user's identity.
                            const protectedIdentity = command.args.at(-1) === 'happier' ? 1001 : 0;
                            const uid = protectedRoot ? protectedIdentity : process.getuid!();
                            const gid = protectedRoot ? protectedIdentity : process.getgid!();
                            return ok(command.args.includes('passwd')
                                ? `${command.args.at(-1)}:x:${uid}:${gid}::/root:/bin/sh\n`
                                : `${command.args.at(-1)}:x:${gid}:\n`);
                        },
                    }).then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
                    return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
                }) satisfies MachineElevationSpawn } : {}),
            },
        }),
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) }) : undefined;
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const envelope = { v: 1 as const, requestId: 'domain-request', target, input: actionInput };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'domain-root', binding: {
        serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, custodianAccountId: 'owner',
        machineId: 'controller', installationId: 'controller-installation', environmentId: input.environmentId,
        actionId, deploymentChildRoot: true,
        requestId: envelope.requestId, accountEncryptionMode: 'plain', target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, actionInput) } });
    const requester = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
        machineId: 'controller', installationId: 'controller-installation', installationPrivateKey: identity.secretKey,
        serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://domain-origin.test', ownCredentials: credentials,
        isCurrent: async () => true, createExecutor: () => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps }) });
    try {
        if (!requester) throw new Error('Expected admitted Domain requester');
        const execute = () => deps.deploymentAction(actionId, actionInput, { externalActionExecutionAuthorization: requester.authorization,
            originalActionEnvelope: envelope, externalActionTarget: target, actionRequestId: envelope.requestId,
            operationAcceptance: { operationId: 'domain-operation', accept() {} } });
        if (noActiveDomainMembers || scenario === 'Domain Environment HTTP unavailable'
            || scenario === 'network review required' || scenario === 'Domain Home purpose refused'
            || scenario === 'administrator native check unavailable' || nativeOutcomeUnknown || removingNativeOutput) {
            const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: 'controller',
                resolveAccountId: async () => 'owner', generateOperationId: () => 'domain-operation' });
            const result = await operations.observeExecution({ actionId, input: actionInput,
                actionRequestId: envelope.requestId, execute: async () => ActionExecuteResultSchema.parse(await execute()) });
            const details = { environmentId: input.environmentId, domainId: input.domainId, step: 'native_execution',
                ...(removingNativeOutput ? { requiredFact: 'nativeExecutionResult', remedy: expect.stringMatching(/\S/) }
                    : noActiveDomainMembers ? { requiredFact: 'activeDomainMembers' }
                    : scenario === 'network review required' ? { requiredFact: 'reachabilityPosture', remedy: expect.any(String) }
                        : nativeOutcomeUnknown ? { ...(nativeUnknownWithFact ? { failure: nativeUnknownFailure, requiredFact: nativeUnknownFailure.requiredFact }
                            : { requiredFact: 'nativeExecutionResult' }),
                            remedy: nativeUnknownWithFact ? nativeUnknownFailure.remedy : expect.any(String) }
                        : scenario === 'administrator native check unavailable' ? { failure: nativeCheckFailure, remedy: nativeCheckFailure.remedy }
                        : scenario === 'Domain Home purpose refused' ? { requiredFact: 'verification_purpose', remedy: expect.any(String) } : {}),
                operation: { serverId: 'home', machineId: 'controller', operationId: 'domain-operation' } };
            // RpcError carries the Home reader's typed failure unchanged.
            const errorCode = removingNativeOutput ? scenario === 'Remove native parsed output invalid'
                ? 'invalid_provider_output' : 'invalid_action_transport_output'
                : noActiveDomainMembers ? 'required_fact_unavailable'
                : scenario === 'network review required' ? 'machine_network_review_required'
                    : nativeOutcomeUnknown ? 'outcome_unknown'
                    : scenario === 'administrator native check unavailable' ? 'native_check_unavailable'
                    : scenario === 'Domain Home purpose refused' ? 'action_forbidden' : 'home_unreachable';
            expect.soft(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode, details });
            if (removingNativeOutput || nativeOutcomeUnknown && !nativeUnknownWithFact) {
                // Only the missing Domain result is known; no child-native step is fabricated.
                expect(result).not.toHaveProperty('details.failure');
            }
            if (scenario === 'Domain Home purpose refused') expect.soft(result).toMatchObject({
                failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 401 } });
            else if (scenario === 'Domain Environment HTTP unavailable') expect.soft(result).toMatchObject({
                failureCause: { phase: 'deployment.home.request', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } });
            else if (scenario !== 'administrator native check unavailable' && !nativeOutcomeUnknown) expect.soft(result).not.toHaveProperty('failureCause');
            const operation = await executeActionOperationActionV1({ actionId: 'action.operations.get',
                input: { serverId: 'home', machineId: 'controller', operationId: 'domain-operation' },
                transport: async ({ payload }) => operations.handlers.getV2(payload) });
            expect.soft(operation).toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
                errorCode, details } } });
            if (scenario === 'Domain Home purpose refused') expect.soft(operation).toMatchObject({ operation: { error: {
                failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 401 } } } });
            else if (scenario === 'Domain Environment HTTP unavailable') expect.soft(operation).toMatchObject({ operation: { error: {
                failureCause: { phase: 'deployment.home.request', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } } } });
            else if (scenario !== 'administrator native check unavailable' && !nativeOutcomeUnknown) expect.soft(operation).not.toHaveProperty('operation.error.failureCause');
            const { contentArtifactId: _artifactId, contentHeaderVersion: _headerVersion,
                contentBodyVersion: _bodyVersion, ...authoredScope } = input;
            const canonicalHome = 'srv_domain_home';
            const actionArgs = scenario === 'network review required'
                ? { ...authoredScope, serverId: canonicalHome, content: domainContent } : actionInput;
            const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
                createdBy: { surface: 'cli' }, requestedSurface: 'ui', actionId, actionArgs,
                summary: removingNativeOutput ? 'Remove Domain' : 'Add Domain', decision: { kind: 'approve', decidedAtMs: 2 },
                executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                    serverId: 'home', accountId: 'owner', machineId: 'controller',
                    ...(scenario === 'network review required' ? { serverIdentityId: canonicalHome,
                        target: { kind: 'machine', machineId: 'controller' } } : {}),
                    actionId, requestId: envelope.requestId } });
            const settled = projectSettledApprovalExecution({ request, actionId, exec: result,
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
                expect.soft(observed).toMatchObject({ status: nativeOutcomeUnknown ? 'outcome_unknown' : 'failed', execution: {
                    ok: false, errorCode, details } });
                if (removingNativeOutput || nativeOutcomeUnknown && !nativeUnknownWithFact) {
                    expect(observed).toHaveProperty('execution.details.requiredFact', 'nativeExecutionResult');
                    expect(observed).not.toHaveProperty('execution.details.failure');
                }
                if (scenario === 'Domain Home purpose refused') expect.soft(observed).toMatchObject({ execution: {
                    failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 401 } } });
                else if (scenario === 'Domain Environment HTTP unavailable') expect.soft(observed).toMatchObject({ execution: {
                    failureCause: { phase: 'deployment.home.request', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } } });
                else if (scenario !== 'administrator native check unavailable' && !nativeOutcomeUnknown) expect.soft(observed).not.toHaveProperty('execution.failureCause');
                expect(JSON.stringify(observed)).not.toContain('Private network transport context');
            }
            expect(JSON.stringify(operation)).not.toContain('Private network transport context');
            expect(admissions).toHaveLength(0);
            expect(children).toHaveLength(removingNativeOutput ? 1 : 0);
            if (removingNativeOutput) expect(children[0]).toMatchObject({ actionId, capture: { desired: false } });
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
                errorCode: 'native_effect_failed', effectAttempted: true, details: {
                    failure: { kind: 'native_effect_failed', reason: scenario === 'firewall prerequisite failed'
                        ? 'required_fact_unavailable' : 'foreign_effect_conflict', stepId: 'firewall', requiredFact: 'firewall' },
                    requiredFact: 'firewall', remedy: expect.any(String),
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
        } else if (adminWriteRefused) {
            expect(ActionExecuteResultSchema.parse(result)).toMatchObject({ ok: false, errorCode: 'native_effect_failed',
                details: { requiredFact: 'caddyAdminConfig',
                    failure: { kind: 'native_effect_failed', requiredFact: 'caddyAdminConfig', errorCode: 'HTTP_400' },
                    remedy: expect.any(String) },
                failureCause: { phase: 'deployment.domain.caddy.admin.write', httpStatus: 400 } });
            expect(JSON.stringify(result)).not.toContain('private-native-response-must-not-escape');
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
        } else if (retainedSeed) {
            if (!runningPublic) expect(seedChecks.length, 'The real root CHECK must observe the retained seed').toBeGreaterThan(0);
            if (scenario === 'Tunnel foreign seed') {
                expect(result, JSON.stringify({ result, seedChecks, nativeResults })).toMatchObject({ ok: false, errorCode: 'native_check_unavailable', details: {
                    failure: { kind: 'native_check_unavailable', reason: 'foreign_effect_conflict', requiredFact: 'caddy-initial-config' },
                    remedy: expect.stringMatching(/check|inspect|reconcile/i),
                } });
                expect(await readFile('/var/lib/happier/caddy/initial.json', 'utf8')).toBe(installedSeed);
                expect(admissions).toEqual([]);
                expect(children).toEqual([]);
                expect(transitions).toEqual([]);
            } else {
                if (networkConnectFailure) {
                    expect(ActionExecuteResultSchema.parse(result), JSON.stringify({ result, seedChecks, nativeResults })).toMatchObject({
                        ok: false, errorCode: 'native_effect_failed', details: {
                            failure: { kind: 'native_effect_failed', reason: 'native_effect_failed', requiredFact: 'caddyAdminConfig',
                                stepId: 'caddy-container-network-connect', nativeCommand: { command: 'docker', phase: 'network-connect', exitCode: 1 } },
                            remedy: expect.any(String),
                        },
                    });
                    expect(nativeWarnings?.mock.calls).toEqual(expect.arrayContaining([
                        ['[Deployment] Domain native step refused', expect.objectContaining({
                            phase: 'deployment.domain.native_execution', callSite: expect.stringContaining('ownServerDomainNative'),
                        })],
                        ['[Deployment] Domain native operation failed', expect.objectContaining({
                            kind: 'domainDiscover', domainId: input.domainId,
                            requiredFact: 'caddyAdminConfig',
                            nativeCommand: { command: 'docker', phase: 'network-connect', exitCode: 1 },
                        })],
                    ]));
                    expect(JSON.stringify(nativeWarnings?.mock.calls)).not.toContain('network attachment failed');
                    expect(JSON.stringify(nativeWarnings?.mock.calls)).not.toContain(retainedConnector.token);
                } else expect(result, JSON.stringify({ result, seedChecks, nativeResults })).toMatchObject({ ok: true, domain: { state: 'active' } });
                if (prepared?.status !== 'ready') throw new Error('Expected Tunnel seed');
                expect(await readFile('/var/lib/happier/caddy/initial.json', 'utf8')).toBe(runningPublic ? publicSeed : prepared.input.initialConfig);
                expect(await readFile('/var/lib/happier/caddy/data/incumbent-certificate', 'utf8')).toBe('retained certificate bytes');
                expect(await readFile(retainedConnector.tokenPath, 'utf8')).toBe(retainedConnector.token);
                expect(JSON.stringify({ result, nativeResults })).not.toContain(retainedConnector.token);
                const docker = nativeDocker.get('/run/happier-caddy/admin.sock')!;
                const finalContainer = JSON.parse((await docker.run(['container', 'inspect', '--', 'owned-caddy'], new AbortController().signal)).stdout)[0];
                expect(finalContainer.State.Running).toBe(true);
                if (!runningPublic) expect(finalContainer.HostConfig.PortBindings).toEqual({});
                if (runningPublic) {
                    const exchange = createNativeCaddyAdminExchange('/run/happier-caddy/admin.sock');
                    const publicRoutes = await exchange({ method: 'GET', path: '/config/apps/http/servers/happier_public/routes/' });
                    expect(publicRoutes.status).toBe(200);
                    expect(publicRoutes.value).toContainEqual(materializeCaddyDomainRouteV1(incumbentPublicDomain).route);
                    expect(finalContainer.HostConfig.PortBindings).toEqual(Object.fromEntries((publicPrepared?.status === 'ready'
                        ? publicPrepared.input.publicBindings ?? [] : []).map(binding => [
                        `${binding.containerPort ?? binding.hostPort}/${binding.protocol}`,
                        [{ HostIp: binding.hostAddress, HostPort: String(binding.hostPort) }],
                    ])));
                }
                expect(Object.keys(finalContainer.NetworkSettings.Networks)).toContain('deployed_default');
                expect(admissions).toHaveLength(networkConnectFailure ? 0 : 1);
                expect(children).toHaveLength(networkConnectFailure ? 0 : 1);
                expect(transitions).toMatchObject(networkConnectFailure ? [] : [{ observations: [{ state: 'active' }] }]);
                if (!networkConnectFailure) expect(admissions[0]?.placements).toMatchObject([{ machineId: 'a', listener: 'privateOrigin', nativeServer: 'happier_private' }]);
            }
        } else if (recordedReplicaCase || scenario === 'membership join installed' || scenario === 'incumbent receipt joining member') {
            expect(result, `Native public TLS listener/publication required for Domain admission: ${JSON.stringify(result)}`)
                .toMatchObject({ ok: true, domain: { state: 'active' } });
            expect(admissions).toHaveLength(1);
            expect(children).toHaveLength(2);
            expect(transitions).toMatchObject([{ observations: [{ state: 'active' }, { state: 'warning' }] }]);
            if (recordedReplicaCase) {
                expect(transitions).toMatchObject([{ observations: [
                    { routedReplicas: [{ containerName: 'deployed-web-1' }, { containerName: 'deployed-web-2' }] },
                    { routedReplicas: scenario === 'direct installed Caddy redirect' ? []
                        : [{ containerName: 'deployed-web-1' }, { containerName: 'deployed-web-2' }] },
                ] }]);
                expect(JSON.stringify(transitions)).not.toContain('deployed-db-1');
            }
            expect(nativeResults).toMatchObject([{ caddy: { status: 'ready' } }, { state: 'active' }, { state: 'warning' }]);
            if (activationDns) {
                expect(activationDns).toHaveBeenCalledTimes(2);
                expect(transitions).toMatchObject([{ observations: [{ state: 'active' }, { state: 'warning',
                    dnsHealth: { status: 'down', cause: { reason: 'dns_missing', remedy: expect.any(String) } } }] }]);
                expect(JSON.stringify(transitions)).toContain('dns_missing');
            }
            expect(admissions[0]?.placements).toEqual(expect.arrayContaining([
                expect.objectContaining({ machineId: 'a', listener: 'privateOrigin', nativeServer: 'happier_private' }),
                expect.objectContaining({ machineId: 'a', listener: 'public', nativeServer: 'happier_public' }),
            ]));
        } else if (scenario === 'membership drain') {
            expect(result).toMatchObject({ ok: false, errorCode: 'native_route_unavailable' });
            expect(admissions[0]).toMatchObject({ membershipDeploymentId: 'membership-receipt', membershipMachines: [
                { machineId: 'a', installationId: 'installed-a' },
            ], placements: [{ machineId: 'a', listener: 'privateOrigin' }] });
            expect(children[0]?.topology?.members).toEqual([{ machineId: 'a', installationId: 'installed-a' }]);
            expect(children[0]?.topology?.tunnelOrigin?.members).toMatchObject([{ machineId: 'a' }]);
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
