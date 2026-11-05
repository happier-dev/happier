import axios from 'axios';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile, mkdir, readFile, lstat, chmod } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { nativeCaddyImage } from '@happier-dev/cli-common/machineSetup';
import { DeploymentDomainHeaderV1Schema, DeploymentDomainListResultV1Schema, DeploymentDomainObservationV1Schema, verifyNativeCaddyRemovalProofV1, nativeCaddyDomainRouteIdsV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentChildRpcV1Schema } from '@happier-dev/protocol';
import { ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionHttpError';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encryptWithDataKey, encodeBase64 } from '@/api/encryption';
import { registerDaemonDeploymentChildRpcHandler } from '@/deployments/daemonDeploymentChildRpc';
import { resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import type { RpcHandler } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { withSocketTempDir } from '@/testkit/fs/tempDir';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { materializeCaddyDomainRouteV1 } from './caddyRouteMaterialization';
import { createOwnServerStartFirstRoutesForHost } from './ownServerDomainNative';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { NativeComposeRoutingGeneration } from '@/daemon/local/services/launch/nativeComposeStartFirst';
import type { OwnServerDeploymentRequest } from './ownServerDeploymentTarget';
import { ApiMachineClient } from '@/api/apiMachine';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { MachineUpdateStateRequestSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDaemonMachineAdminAccessRoutes } from '@/machines/adminAccess/createDaemonMachineAdminAccessRoutes';
import { runMachineSetupEffectInternal } from '@/machines/setup/effectInternal';
import type { MachineElevationSpawn } from '@/machines/adminAccess/runElevatedEffect';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { machineSecretGrantSubjectKey } from '@happier-dev/deployment-protocol';

const connectorFs = vi.hoisted(() => ({ directory: '' }));
// Substitute protected OS paths only. Real bytes/modes, root CHECK/APPLY,
// grant transport/opening and the canonical file backend remain unchanged.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    const owned = (value: unknown) => typeof value === 'string'
        && (value === '/etc/cloudflared' || value.startsWith('/etc/cloudflared/'));
    const path = <T,>(value: T): T => {
        if (!owned(value)) return value;
        if (!connectorFs.directory) throw new Error('Protected Cloudflare fixture is not active');
        return (connectorFs.directory + String(value).slice('/etc/cloudflared'.length)) as T;
    };
    return { ...actual,
        lstat: async (...args: Parameters<typeof actual.lstat>) => {
            const stat = await actual.lstat(path(args[0]), args[1]);
            return owned(args[0]) ? Object.assign(stat, { uid: 0, gid: 0 }) : stat;
        },
        readFile: (...args: Parameters<typeof actual.readFile>) => actual.readFile(path(args[0]), args[1]),
        writeFile: (...args: Parameters<typeof actual.writeFile>) => actual.writeFile(path(args[0]), args[1], args[2]),
        mkdir: (...args: Parameters<typeof actual.mkdir>) => actual.mkdir(path(args[0]), args[1]),
        chmod: (...args: Parameters<typeof actual.chmod>) => actual.chmod(path(args[0]), args[1]),
        chown: async (...args: Parameters<typeof actual.chown>) => {
            if (owned(args[0])) { await actual.lstat(path(args[0])); return; }
            await actual.chown(...args);
        },
        mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
            const physical = await actual.mkdtemp(path(args[0]), args[1]);
            // The adapter reports its logical path, so subsequent protected
            // ancestor checks stay in the same translated OS namespace.
            return owned(args[0]) ? '/etc/cloudflared' + String(physical).slice(connectorFs.directory.length) : physical;
        },
        rename: (...args: Parameters<typeof actual.rename>) => actual.rename(path(args[0]), path(args[1])),
        unlink: (...args: Parameters<typeof actual.unlink>) => actual.unlink(path(args[0])),
        rm: (...args: Parameters<typeof actual.rm>) => actual.rm(path(args[0]), args[1]),
    };
});

afterEach(() => { connectorFs.directory = ''; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([
    { encryptionMode: 'plain', missingEngine: false, mismatchedEngine: false, cutover: false, connectorRetirement: 'none', verify: true },
    { encryptionMode: 'plain', missingEngine: false, mismatchedEngine: false, cutover: false, connectorRetirement: 'none' },
    { encryptionMode: 'e2ee', missingEngine: false, mismatchedEngine: false, cutover: false, connectorRetirement: 'none' },
    { encryptionMode: 'plain', missingEngine: true, mismatchedEngine: false, cutover: false, connectorRetirement: 'none' },
    { encryptionMode: 'plain', missingEngine: false, mismatchedEngine: true, cutover: false, connectorRetirement: 'none' },
    { encryptionMode: 'plain', missingEngine: false, mismatchedEngine: false, cutover: true, connectorRetirement: 'none' },
    { encryptionMode: 'plain', missingEngine: false, mismatchedEngine: false, cutover: false, connectorRetirement: 'exact' },
    { encryptionMode: 'plain', missingEngine: false, mismatchedEngine: false, cutover: false, connectorRetirement: 'none', artifactRefusal: true },
    { encryptionMode: 'plain', missingEngine: false, mismatchedEngine: false, cutover: false, connectorRetirement: 'foreign' },
    { encryptionMode: 'plain', missingEngine: false, mismatchedEngine: false, cutover: false, connectorRetirement: 'retain' },
] as const)('settles captured $encryptionMode Domain custody (cutover: $cutover, missing engine: $missingEngine, mismatched engine: $mismatchedEngine, connector: $connectorRetirement, artifact refusal: $artifactRefusal)', async scenario => withSocketTempDir(async directory => {
    const { encryptionMode, missingEngine, mismatchedEngine, cutover, connectorRetirement } = scenario;
    const verifying = 'verify' in scenario && scenario.verify;
    const artifactRefusal = 'artifactRefusal' in scenario && scenario.artifactRefusal;
    const socketPath = join(directory, 'admin.sock');
    const configPath = join(directory, 'initial.json');
    const domain = { hostname: 'app.example.test', target: { service: 'web', containerPort: 8080 },
        healthCheck: { path: '/health', expectStatus: 200 } };
    const connectorSubject = { v: 1 as const, kind: 'connectorToken' as const, machineId: 'receiver',
        installationId: 'receiver-installation', provider: { kind: 'builtin' as const, id: 'cloudflareNamed' as const },
        connectorId: 'environment-tunnel' };
    // Fixture Home issued this opaque reference. Native consumers must retain
    // it verbatim, not reconstruct it from caller operands.
    const connector = { tunnelId: connectorSubject.connectorId, networkName: 'environment_default',
        grantRef: machineSecretGrantSubjectKey(connectorSubject),
        connector: { imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0' } };
    const tokenPath = '/etc/cloudflared/happier-environment-tunnel.token';
    const token = 'private-minted-connector-token', unrelated = 'another-environment-token';
    if (connectorRetirement !== 'none') {
        connectorFs.directory = join(directory, 'cloudflared');
        await mkdir(connectorFs.directory, { mode: 0o700 });
        await writeFile(tokenPath, connectorRetirement === 'foreign' ? 'foreign-private-file' : token, { mode: 0o600 });
        await chmod(tokenPath, 0o600);
        await writeFile('/etc/cloudflared/happier-other.token', unrelated, { mode: 0o600 });
    }
    const nativeConnector = { Id: 'f'.repeat(64), Name: '/happier-cloudflared-environment-tunnel', State: { Running: true },
        Config: { Image: connector.connector.imageRef, User: '0:0', Entrypoint: ['cloudflared'],
            Labels: { 'dev.happier.machine-setup.recipe': 'cloudflare-connector@1' },
            Cmd: ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:20241', 'run', '--token=', '--token-file', tokenPath] },
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: connector.networkName,
            Privileged: false, ReadonlyRootfs: true, PublishAllPorts: false, PortBindings: null, Binds: null,
            CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
            Mounts: [{ Type: 'bind', Source: tokenPath, Target: tokenPath, ReadOnly: true }] },
        NetworkSettings: { Networks: { [connector.networkName]: {} } } };
    const rootEvents: unknown[] = [], rootLaunches: Parameters<MachineElevationSpawn>[0][] = [];
    let grantReads = 0, setupClient: ApiMachineClient | undefined;
    const material = materializeCaddyDomainRouteV1({ domainId: 'domain', domain, listener: 'privateOrigin',
        upstreams: { kind: 'replicas', containerNames: ['retired-generation-web-42'] }, privateSourceRanges: [] });
    const foreign = { '@id': 'foreign-app', match: [{ host: ['other.example.test'] }], handle: [{ handler: 'static_response', status_code: 204 }] };
    const nativeServer = { listen: [':9381'], automatic_https: { disable: true }, routes: missingEngine || mismatchedEngine ? [foreign] : [material.route, foreign],
        errors: { routes: !missingEngine && !mismatchedEngine && material.fallbackRoute ? [material.fallbackRoute] : [] } };
    const config = { admin: { listen: 'unix//run/domain-native/admin.sock|0660' },
        apps: { http: { servers: { 'observed-private': nativeServer } } } };
    await writeFile(configPath, JSON.stringify(config));
    let version = 1;
    const mutations: string[] = [];
    const networkOrder: string[] = [];
    const server = createServer(async (request, response) => {
        const etag = `"${version}"`;
        if (request.method === 'GET') {
            response.setHeader('ETag', etag);
            response.end(JSON.stringify(request.url === '/config/' ? config : nativeServer));
            return;
        }
        if (request.headers['if-match'] !== etag) { response.writeHead(412).end(); return; }
        const id = decodeURIComponent(request.url!.slice('/id/'.length));
        if (request.method === 'PATCH') {
            let body = '';
            for await (const chunk of request) body += String(chunk);
            const next: unknown = JSON.parse(body);
            const replace = (value: unknown): boolean => {
                if (!value || typeof value !== 'object') return false;
                for (const [key, child] of Object.entries(value)) {
                    if (child && typeof child === 'object' && '@id' in child && child['@id'] === id) {
                        Reflect.set(value, key, next); return true;
                    }
                    if (replace(child)) return true;
                }
                return false;
            };
            if (!replace(nativeServer)) { response.writeHead(404).end(); return; }
            networkOrder.push('PATCH'); version++; response.end(); return;
        }
        mutations.push(id);
        nativeServer.routes = nativeServer.routes.filter(route => route['@id'] !== id);
        nativeServer.errors.routes = nativeServer.errors.routes.filter(route => route['@id'] !== id);
        version++;
        response.end();
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    let mounted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    let prepared: Awaited<ReturnType<Awaited<ReturnType<typeof createDeploymentChildRequesterHarness>>['prepare']>> | undefined;
    const channel = await createRequesterCurrentnessSocketHarness();
    try {
        const bin = join(directory, 'bin');
        const docker = await createOwnServerDockerBoundary(bin, { ...(mismatchedEngine ? { engineId: 'replacement-engine' } : {}), nativeCaddy: {
            Id: 'c'.repeat(64), Name: '/observed-caddy', State: { Running: true },
            Config: { Image: nativeCaddyImage, Labels: { 'dev.happier.machine-setup.recipe': 'caddy@1' },
                Cmd: ['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json'] },
            HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Mounts: [
                { Type: 'bind', Source: directory, Target: '/run/domain-native' },
                { Type: 'bind', Source: configPath, Target: '/etc/caddy/happier.json' },
            ] }, NetworkSettings: { Ports: {}, Networks: {} },
        }, ...(connectorRetirement !== 'none' ? { nativeCloudflare: nativeConnector } : {}) });
        vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.serverId = 'srv_archive_home';
        const link = environment.targetLinks[0].targetLink;
        link.machines = ['receiver']; link.members = [{ machineId: 'receiver', installationId: 'receiver-installation', state: 'active' }];
        const placement = { serverId: environment.environment.serverId, accountId: 'bob', environmentId: environment.environment.id, targetLinkId: link.id,
            domainId: 'domain', machineId: 'receiver', installationId: 'receiver-installation', nativeServer: 'observed-private',
            actionOperationId: 'removal-operation', requestId: 'private-deployment-request' };
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain',
            actionId: verifying ? 'deployments.domains.verify' : 'deployments.domains.remove',
            input: { serverId: placement.serverId, environmentId: placement.environmentId, domainId: 'domain' },
            machineId: placement.machineId, installationId: placement.installationId, actionOperationId: placement.actionOperationId,
            ...(connectorRetirement === 'exact' || connectorRetirement === 'foreign' ? { cloudflareConnector: connector } : {}),
            expectedDomainRevision: 3, capture: { placement, listener: 'privateOrigin', desired: verifying,
                ...(!missingEngine ? { dockerEngineId: 's0-docker-engine' } : {}),
                environmentContent: { contentArtifactId: environment.environment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
                targetLinkContent: { contentArtifactId: link.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
                content: { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 } } });
        const fixture = await createDeploymentChildRequesterHarness({ encryptionMode, job, profileId: placement.serverId,
            rootInput: { ...job.input, expectedRevision: environment.environment.revision, expectedDomainRevision: 3, requestKey: 'remove' } });
        const resourceKey = await createResourceDataKey({ credentials: fixture.bob, mode: encryptionMode });
        const encode = (value: unknown) => resourceKey.mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, resourceKey.dataKey));
        const content = new Map<string, Readonly<{ kind: string; value: unknown }>>([
            ['domain-content', { kind: 'deployment-domain.v1', value: domain }],
            [environment.environment.contentArtifactId, { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, value: environment.content }],
            [link.contentArtifactId, { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, value: {} }],
        ]);
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: fixture.currentness };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: encryptionMode, updatedAt: 1 } };
            if (cutover && new URL(url).pathname === '/v1/machines/receiver') {
                throw new axios.AxiosError('No published private networks', 'ERR_BAD_REQUEST', undefined, undefined,
                    { status: 404, statusText: 'Not Found', data: { error: 'not_found' }, headers: {}, config: { headers: new axios.AxiosHeaders() } });
            }
            const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
            if (artifactRefusal && id === 'domain-content') return { status: 401,
                data: ExternalActionHttpErrorSchema.parse({ error: 'invalid_token', authorizationRefusal: 'deployment_preparation' }) };
            const document = content.get(id);
            if (!document) throw new Error('Unexpected private resource read');
            return { status: 200, data: { id, ownerAccountId: 'bob', access: 'owner', publicAudience: 'none', encryptionMode,
                dataEncryptionKey: resourceKey.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encode({ kind: document.kind, title: 'Domain' }),
                body: encode({ body: JSON.stringify(document.value) }), headerVersion: 1, bodyVersion: 1,
                seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const sealed = sealMachineSecretGrant({ subject: connectorSubject, installationPublicKey: fixture.receiver.publicKey,
            content: { kind: 'connectorToken', token } });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (connectorRetirement === 'none' || new URL(request.url!).pathname !== '/v1/deployments/machines/receiver/connector-secret-grant') {
                throw new Error('Admitted native work cannot reread mutable Environment metadata');
            }
            expect(request.data).toMatchObject({ operation: 'read', subject: connectorSubject,
                hostMachineId: placement.machineId, hostInstallationId: placement.installationId });
            grantReads++;
            expect(JSON.stringify(request)).not.toContain(token);
            return { status: 200, data: { ok: true, grant: sealed } };
        });
        mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory, controller: pluginReloadController,
            runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
        prepared = await fixture.prepare();
        if (cutover) {
            const reference = { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
            const domainHeader = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: placement.domainId,
                environmentId: placement.environmentId, targetLinkId: placement.targetLinkId, revision: 3,
                state: 'active', createdByAccountId: 'bob', createdAtMs: 1, updatedAtMs: 1, ...reference,
                placements: [{ placement, content: reference, listener: 'privateOrigin', desired: true, dockerEngineId: 's0-docker-engine' }] });
            let listed = 0, opened = 0;
            const readRoutes = createOwnServerStartFirstRoutesForHost({ credentials: fixture.bob,
                serverId: placement.serverId, serverHttpBaseUrl: fixture.serverHttpBaseUrl, machineId: placement.machineId,
                async list(input) {
                    expect(input.environmentId).toBe(placement.environmentId); listed++;
                    return DeploymentDomainListResultV1Schema.parse({ ok: true, environmentId: placement.environmentId,
                        revision: 7, domains: [domainHeader], nextCursor: null });
                },
                async open(id) {
                    expect(id).toBe(reference.contentArtifactId); opened++;
                    return { artifactId: id, header: { kind: 'deployment-domain.v1', title: 'Domain' },
                        body: JSON.stringify(domain), revision: { headerVersion: 1, bodyVersion: 1 } };
                } });
            const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy',
                input: { serverId: placement.serverId, environmentId: placement.environmentId, expectedRevision: 7,
                    targetLinkId: placement.targetLinkId, expectedTargetLinkRevision: 1, requestKey: 'cutover',
                    contentArtifactId: 'deployment-content', contentHeaderVersion: 1, contentBodyVersion: 1 },
                receipt: { ok: true, environmentId: placement.environmentId, revision: 7,
                    deploymentId: 'candidate', deploymentRevision: 1, state: 'running' }, context: {} };
            const generation = (name: string): NativeComposeRoutingGeneration => ({ environmentInstanceId: 'instance',
                engineId: 's0-docker-engine', admissionProjectName: 'logical', projectName: name,
                services: [{ service: 'web', stopGracePeriodSeconds: 17, replicas: [{ id: `${name}-id`,
                    name: name === 'retired' ? 'retired-generation-web-42' : 'candidate-web-1', networks: [`${name}_default`] }] }] });
            const signal = new AbortController().signal;
            await machineNativeEffectAdmission.run({ operation: { operationId: 'cutover', kind: 'deploy', signal },
                keys: [{ kind: 'dockerEngine', dockerEndpoint: 's0-docker-engine' }] }, async context => {
                const routes = await readRoutes(request, { installationId: placement.installationId, affectedServices: ['web'], context, signal,
                    docker: { engineId: 's0-docker-engine', async run(args, nativeSignal, inputBytes) {
                        nativeSignal?.throwIfAborted();
                        // The shared Docker executable has no network writer.
                        // Substitute that genuine OS boundary here, not the
                        // inventory, network-selection or route owner.
                        if (args[0] === 'network') {
                            expect(args).toEqual(['network', 'connect', 'candidate_default', 'c'.repeat(64)]);
                            networkOrder.push(args.join(' '));
                            return { exitCode: 0, stdout: '' };
                        }
                        const output = spawnSync(process.execPath, [docker.executablePath, ...args], { encoding: 'utf8',
                            ...(inputBytes ? { input: Buffer.from(inputBytes) } : {}) });
                        if (output.error) throw output.error;
                        return { exitCode: output.status ?? 1, stdout: output.stdout, stderr: output.stderr };
                    } } });
                expect(await routes.switch({ candidate: generation('candidate'), incumbent: generation('retired'), signal }))
                    .toEqual({ kind: 'switched' });
            });
            expect(networkOrder).toEqual([`network connect candidate_default ${'c'.repeat(64)}`, 'PATCH']);
            expect(JSON.stringify(nativeServer)).toContain('candidate-web-1:8080');
            expect(JSON.stringify(nativeServer)).not.toContain('retired-generation-web-42');
            expect(nativeServer.routes).toContainEqual(foreign);
            expect({ listed, opened }).toEqual({ listed: 1, opened: 1 });
            return;
        }
        const handlers = new Map<string, RpcHandler>();
        const spawn: MachineElevationSpawn = invocation => {
            rootLaunches.push(invocation);
            const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
            const controller = new AbortController();
            const running = runMachineSetupEffectInternal(invocation.args.slice(invocation.args.indexOf('effect-internal') + 1), {
                stdin, stdout, signal: controller.signal,
                runNative: async command => {
                    if (command.executable !== 'getent') throw new Error('Unexpected root native command');
                    const account = command.args.at(-1);
                    if (command.args.includes('passwd') && account === 'happier') {
                        return { code: 0, stderr: '', stdout: 'happier:x:1001:1001::/home/happier:/bin/sh\n' };
                    }
                    expect(account).toBe('root');
                    return { code: 0, stderr: '', stdout: command.args.includes('passwd')
                        ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n' };
                },
            });
            const settled = running.then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
            return { stdin, stdout, stderr, settled, async terminate() { controller.abort(); stdin.end(); await settled; } };
        };
        if (connectorRetirement !== 'none') {
            const getuid: MockInstance<NonNullable<typeof process.getuid>> = vi.spyOn(process, 'getuid');
            getuid.mockReturnValue(0);
            setupClient = new ApiMachineClient('installed-policy-token', { id: placement.machineId, encryptionMode: 'plain',
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                metadata: { host: 'receiver', platform: 'linux', happyCliVersion: 'dev', homeDir: directory, happyHomeDir: directory,
                    adminAccess: { version: 1, mode: 'preauthorized' } }, metadataVersion: 1,
                daemonState: { status: 'running' }, daemonStateVersion: 0 });
            Reflect.set(setupClient, 'socket', createApiSessionSocketStub({ connected: true,
                emitWithAck(event, payload) {
                    if (event !== 'machine-update-state') return resolveApiSessionSocketDefaultAck(event, payload);
                    const request = MachineUpdateStateRequestSchema.parse(payload);
                    return { result: 'success', version: request.expectedVersion + 1, daemonState: request.daemonState };
                },
            }));
            setupClient.registerMachineAdminAccessRoutes(createDaemonMachineAdminAccessRoutes({ getMachineClient: () => setupClient!,
                target: () => ({ serverId: fixture.profileId, machineId: placement.machineId,
                    installationId: placement.installationId, custodianAccountId: 'ann' }),
                nativeDependencies: { platform: 'linux', execFile: async (file, args) => {
                    if (file === 'id') return { stdout: args[0] === '-u' ? '1001\n' : 'happier\n' };
                    if (file === 'sudo') return { stdout: '' };
                    throw Object.assign(new Error('Optional native access is unavailable'), { code: 1 });
                } },
            }));
        }
        registerDaemonDeploymentChildRpcHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
            machineId: placement.machineId,
            ...(setupClient ? { captureNativeSetup: () => ({ readDesired: setupClient!.captureMachineSetupDesired().read,
                elevation: { ...setupClient!.captureMachineAdminAccess(), spawn, emit: (event: unknown) => { rootEvents.push(event); } } }) } : {}),
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            resolveRequesterRuntime: ingress => resolveAdmittedRequesterAccountReadRuntime({ ingress,
                serverId: fixture.profileId, machineId: placement.machineId, installationId: placement.installationId, isInstalledCurrent: () => true }),
            resolveInstalledRuntime: async () => ({ serverId: fixture.profileId, machineId: placement.machineId,
                accountId: 'ann', credentials: { ...fixture.ann,
                    // The installed HTTP credential names its real fixture subject.
                    token: `e30.${Buffer.from(JSON.stringify({ sub: 'ann' })).toString('base64url')}.fixture` },
                serverHttpBaseUrl: fixture.serverHttpBaseUrl, isCurrent: async () => true }),
            acquirePluginRuntimeRegistryLease: async () => mounted!.lease,
        });
        const handler = handlers.get(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD)!;
        let admissionReads = 0;
        const rawResult = await handler(job, { signal: new AbortController().signal, callerInputAuthorization: prepared.authorization,
            originalActionEnvelope: fixture.envelope, workspaceSyncSourceExecution: fixture.packet,
            machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'ann', machineId: placement.machineId,
                installationId: placement.installationId, role: 'manage', encryptionMode },
            verifyMachineAdmissionCurrent: async () => { admissionReads++; return true; } });
        if (artifactRefusal) {
            expect(rawResult).toMatchObject({ ok: false, errorCode: 'action_forbidden',
                error: 'action_forbidden (home_signed_authorization_rejected:deployment_preparation)',
                failureCause: { phase: 'home.authorization.deployment_preparation', httpStatus: 401 } });
            expect(mutations).toEqual([]);
            expect(JSON.stringify({ rawResult, rootEvents, rootLaunches })).not.toContain(token);
            return;
        }
        if (verifying) {
            const observation = DeploymentDomainObservationV1Schema.parse(rawResult);
            expect(observation).toMatchObject({ state: 'active', networkExposure: { kind: 'ready',
                listener: 'privateOrigin', localOrigin: true, fallback: false,
                listeners: [{ tls: false, automaticHttpsDisabled: true, endpoints: [] }] } });
            expect(mutations).toEqual([]);
            expect(JSON.stringify(observation)).not.toContain(socketPath);
            expect(JSON.stringify(observation.networkExposure)).not.toMatch(/hostAddress|"listen"/);
            return;
        }
        if (missingEngine || mismatchedEngine) {
            expect(rawResult).toMatchObject({ ok: false, errorCode: 'target_mismatch' });
            expect(mutations).toEqual([]);
            return;
        }
        if (connectorRetirement === 'foreign') {
            expect(rawResult).toMatchObject({ ok: false });
            expect(await readFile(tokenPath, 'utf8')).toBe('foreign-private-file');
            expect(await readFile('/etc/cloudflared/happier-other.token', 'utf8')).toBe(unrelated);
            expect(mutations).toEqual([]);
            expect(grantReads, JSON.stringify({ rawResult, rootEvents, rootLaunches })).toBeGreaterThan(0);
            expect(rootLaunches).not.toEqual([]);
            expect(JSON.stringify({ rawResult, rootEvents, rootLaunches })).not.toContain(token);
            return;
        }
        expect(rawResult).toMatchObject({ state: 'removed' });
        const result = DeploymentDomainObservationV1Schema.parse(rawResult);
        expect(result.state).toBe('removed');
        expect(result.removal && verifyNativeCaddyRemovalProofV1(result.removal, placement,
            nativeCaddyDomainRouteIdsV1('domain', 'privateOrigin').removalIds, fixture.receiver.publicKey)).toBe(true);
        expect(admissionReads).toBe(1);
        if (connectorRetirement === 'exact') {
            await expect(lstat(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await readFile('/etc/cloudflared/happier-other.token', 'utf8')).toBe(unrelated);
            expect(grantReads, JSON.stringify({ rawResult, rootEvents, rootLaunches })).toBeGreaterThan(0);
            expect(rootLaunches).not.toEqual([]);
            const connectorCommands = (await docker.readInvocations()).filter(call => call.args.at(-1) === nativeConnector.Id)
                .map(call => call.args.slice(0, 2));
            expect(connectorCommands).toContainEqual(['container', 'stop']);
            expect(connectorCommands).toContainEqual(['container', 'rm']);
            expect(JSON.stringify({ rawResult, rootEvents, rootLaunches })).not.toContain(token);
        } else if (connectorRetirement === 'retain') {
            expect(await readFile(tokenPath, 'utf8')).toBe(token);
            expect(rootLaunches).toEqual([]);
            expect(grantReads).toBe(0);
            expect((await docker.readInvocations()).some(call => call.args.at(-1) === nativeConnector.Id)).toBe(false);
        }
        expect(nativeServer.routes).toEqual([foreign]);
        expect(mutations).toEqual([nativeCaddyDomainRouteIdsV1('domain', 'privateOrigin').routeId]);
        expect((await docker.readInvocations()).some(call => call.args.includes('compose') || call.args.includes('exec'))).toBe(false);
    } finally {
        await setupClient?.shutdown();
        await prepared?.dispose();
        await channel.close();
        await mounted?.dispose();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}));
