import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, computeContentPublicKeyFingerprint,
    DeploymentActionInputSchemasV1, DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptListResultV1Schema,
    deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1,
    type ActionExecutorContext } from '@happier-dev/protocol';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MachineStorageDockerPruneResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { MachineDeploymentReferencesPageV1Schema } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    createDeploymentReceiptArtifactHeaderV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1,
    createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { resolveNativeComposeDeploymentImageReferences } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from '@/deployments/targets/ownServer/paths';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createDaemonStorageRoutes } from '@/rpc/handlers/storage';
import { createStoragePolicyFixture } from '@/storage/storagePolicy.testkit';
import { createStorageDockerPruneForHost } from '@/storage/dockerPrune';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { ApiMachineClient } from '@/api/apiMachine';
import type { Machine } from '@/api/types';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encryptWithDataKey, encodeBase64, decodeBase64, decrypt } from '@/api/encryption';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId, type StoredCredentials } from '@/persistence';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { configuration } from '@/configuration';
import * as installation from '@/daemon/identity/store';

const socketBoundary = vi.hoisted(() => ({ create: undefined as (() => unknown) | undefined }));
vi.mock('socket.io-client', () => ({ io: vi.fn(() => {
    if (!socketBoundary.create) throw new Error('Storage Socket.IO boundary is not installed');
    return socketBoundary.create();
}) }));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function fixture(run: (value: Readonly<{
    invoke(selection?: 'explicit' | 'safe' | 'unowned', signal?: AbortSignal): Promise<ReturnType<typeof MachineStorageDockerPruneResultV1Schema.parse>>;
    docker: Awaited<ReturnType<typeof createOwnServerDockerBoundary>>;
    ids: Readonly<Record<'active' | 'retained' | 'dangling' | 'foreign' | 'unowned' | 'running' | 'owned', string>>;
    engineId: string;
    bindMarker: string;
    setPending(pending: boolean): void;
    changeOnHeaderRecheck(kind: 'environment' | 'receipt'): void;
    retire(): void;
}>) => Promise<void>, mode: 'plain' | 'e2ee' = 'plain', serverSelection: 'canonical' | 'profile' = 'canonical') {
    const root = await mkdtemp(join(tmpdir(), 'happier-storage-prune-'));
    const previous = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile,
        serversDir: configuration.serversDir, activeServerId: configuration.activeServerId };
    let client: ApiMachineClient | undefined;
    let routes: ReturnType<typeof createDaemonStorageRoutes> | undefined;
    let active = true;
    const previousHttpAdapter = axios.defaults.adapter;
    const httpTrace: Array<{ method: string; path: string; code?: string }> = [];
    try {
        Object.assign(configuration, { happyHomeDir: root, settingsFile: join(root, 'settings.json'), serversDir: join(root, 'servers') });
        const profile = await addServerProfile({ name: 'prune', serverUrl: 'https://prune.invalid', webappUrl: 'https://prune.invalid' });
        const homeServerIdentityId = 'srv_prune_fixture';
        const target = { serverId: homeServerIdentityId, machineId: 'machine-a' };
        const daemonTarget = { ...target, serverId: serverSelection === 'profile' ? profile.id : homeServerIdentityId };
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId, canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        configuration.activeServerId = profile.id;
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const machineKey = new Uint8Array(randomBytes(32));
        const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
        const machineContentKey = new Uint8Array(randomBytes(32));
        const publishedMachineKey = mode === 'plain' ? MACHINE_PLAIN_DATA_KEY_MARKER
            : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: machineContentKey, recipientPublicKey: publicKey,
                randomBytes: length => new Uint8Array(randomBytes(length)) }));
        const stored: StoredCredentials = { token, encryption: mode === 'plain' ? null
            : { type: 'dataKey', machineKey, publicKey } };
        // Only the real stored-sign-in reader may attest a person-origin CLI
        // invocation. A structurally identical raw credential is automation.
        await writeStoredCredentialsForServerId(profile.id, stored);
        const credentials = await readStoredCredentialsForServerId(profile.id);
        if (!credentials) throw new Error('Fixture terminal sign-in was not readable');
        const currentness = createAccountEncryptionCurrentnessFixture({ mode,
            contentKeyFingerprint: mode === 'plain' ? null : computeContentPublicKeyFingerprint(publicKey) });
        const engineId = 'prune-engine';
        const docker = await createOwnServerDockerBoundary(join(root, 'tools'), { engineId });
        vi.stubEnv('PATH', `${join(root, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
        vi.spyOn(installation, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
            installationId: 'installation-a', publicKey: 'fixture-public-key', privateKey: 'fixture-private-key' });
        // The alias regression needs only the active/retained protection and
        // one expired contrast, not the unrelated native inventory cases.
        const names = serverSelection === 'profile' ? ['active', 'retained', 'dangling'] as const
            : ['active', 'retained', 'dangling', 'foreign', 'unowned', 'running', 'owned'] as const;
        // The executable boundary has one state file; fixture state mutations
        // are ordered just like its Docker commands, not parallel read/writes.
        const images: Awaited<ReturnType<typeof docker.registerImage>>[] = [];
        const imageIds: Array<readonly [typeof names[number], string]> = [];
        for (const name of names) {
            const image = await docker.registerImage(name, 'prune');
            images.push(image);
            imageIds.push([name, await docker.setImagePruneState(image.registryReference!, {
                repoTags: name === 'foreign' ? ['foreign/keep:latest'] : [], repoDigests: [],
            })]);
        }
        const ids = Object.fromEntries(imageIds) as Record<typeof names[number], string>;
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment = { ...environment.environment, serverId: target.serverId,
            owner: { kind: 'account', accountId: 'owner' }, buildMachineId: target.machineId, controllerMachineId: target.machineId };
        environment.content.retainPreviousDeployments = 1;
        const link = environment.targetLinks[0]!.targetLink;
        link.activeDeploymentId = 'active';
        const receipts = names.filter(name => name !== 'foreign' && name !== 'unowned').map((name, index) => {
            const receipt = createDeploymentReceiptDetailV1();
            receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, id: name,
                environmentId: environment.environment.id, targetLinkId: link.id, state: 'succeeded',
                contentArtifactId: `receipt-${name}`, requestedAtMs: name === 'active' ? 20 : name === 'retained' ? 19 : index,
                acceptedExecution: { v: 1,
                    controller: { machineId: target.machineId, installationId: 'installation-a' },
                    builder: { machineId: target.machineId, installationId: 'installation-a' } } });
            receipt.content.machineResults = name === 'active' ? [{ machineId: target.machineId, installationId: 'installation-a',
                steps: [], activation: 'succeeded', health: 'healthy', currentDeploymentId: name }] : [];
            receipt.content.images = [images[names.indexOf(name)]!];
            return receipt;
        });
        // Every removable reference comes from the canonical receipt producer.
        // The unowned tagless object has no receipt and is never discovered as
        // deletion-eligible merely because Docker calls it dangling.
        for (const receipt of receipts) {
            const refs = resolveNativeComposeDeploymentImageReferences({
                environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost(homeServerIdentityId, environment.environment.id),
                deploymentId: receipt.deployment.id, image: receipt.content.images[0]! });
            const name = names.find(name => name === receipt.deployment.id);
            if (!name) throw new Error('Fixture receipt has no native image');
            await docker.setImagePruneState(ids[name], { repoTags: [refs.ownedTag, refs.activationRef], repoDigests: [] });
        }
        if (serverSelection !== 'profile') await docker.setImageContainerReference(ids.running, 'running');
        const bindMarker = join(root, 'bind-marker');
        await writeFile(bindMarker, 'retained bind data');
        let pending = false;
        let changeOnRecheck: 'environment' | 'receipt' | undefined;
        const storageRoute = (actionId: 'deployments.environments.get' | 'deployments.receipts.list') => {
            const spec = getActionSpec(actionId);
            if (!spec.serverTransport) throw new Error('Missing canonical deployment read transport');
            const bound = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: DeploymentActionInputSchemasV1[actionId],
                input: { serverId: target.serverId, environmentId: environment.environment.id } });
            return new URL(bound.path, profile.serverUrl);
        };
        const envRoute = storageRoute('deployments.environments.get');
        const receiptsRoute = storageRoute('deployments.receipts.list');
        const headerReads = { environment: 0, receipts: 0 };
        const storedArtifactContents = new Map<string, Readonly<{ dataEncryptionKey: string; header: string; body: string }>>();
        const response = async (url: string) => {
            const requestUrl = new URL(url);
            const path = requestUrl.pathname;
            const matchesRoute = (expected: URL) => {
                if (path !== expected.pathname) return false;
                // The canonical GET binding retains serverId and any schema
                // defaults in its query. Never ignore the selected Home.
                expect([...requestUrl.searchParams].sort()).toEqual([...expected.searchParams].sort());
                return true;
            };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            if (path === '/v1/account/encryption') return { status: 200,
                data: { mode: currentness.mode, updatedAt: currentness.updatedAt } };
            if (path === `/v1/machines/${target.machineId}`) return { status: 200, data: { machine: {
                id: target.machineId, installationId: 'installation-a', storageMode: mode, dataEncryptionKey: publishedMachineKey,
                revokedAt: null, replacedByMachineId: null,
            } } };
            if (path === '/v1/deployments/machine-references') {
                expect([...requestUrl.searchParams].sort()).toEqual([
                    ['homeId', target.serverId], ['machineId', target.machineId],
                ].sort());
                return { status: 200, data: MachineDeploymentReferencesPageV1Schema.parse({ homeId: target.serverId,
                machineId: target.machineId, coverage: 'complete', references: [{ kind: 'deployment_environment',
                    id: environment.environment.id, name: 'Environment', deploymentRoles: ['runtime', 'build'] }], nextCursor: null }) };
            }
            if (matchesRoute(envRoute)) {
                headerReads.environment++;
                if (headerReads.environment > 1 && changeOnRecheck === 'environment') {
                    environment.environment = { ...environment.environment, revision: environment.environment.revision + 1 };
                    changeOnRecheck = undefined;
                }
                return { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: environment.environment,
                    targetLinks: environment.targetLinks.map(value => value.targetLink) }) };
            }
            const current = receipts.map(row => row.deployment.id === 'dangling' && pending
                ? { ...row, deployment: { ...row.deployment, state: 'outcome_unknown' as const } } : row);
            if (matchesRoute(receiptsRoute)) {
                headerReads.receipts++;
                const items = current.map(row => headerReads.receipts > 1 && changeOnRecheck === 'receipt'
                    && row.deployment.id === 'dangling' ? { ...row.deployment, revision: row.deployment.revision + 1 } : row.deployment);
                if (headerReads.receipts > 1 && changeOnRecheck === 'receipt') changeOnRecheck = undefined;
                return { status: 200, data: DeploymentReceiptListResultV1Schema.parse({ ok: true, items, nextCursor: null }) };
            }
            const id = path.startsWith('/v1/artifacts/') ? decodeURIComponent(path.slice('/v1/artifacts/'.length)) : undefined;
            const receipt = current.find(value => value.deployment.contentArtifactId === id);
            const body = id === environment.environment.contentArtifactId ? environment.content
                : id === link.contentArtifactId ? environment.targetLinks[0]!.content : receipt?.content;
            const header = id === environment.environment.contentArtifactId ? { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Environment' }
                : id === link.contentArtifactId ? { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Target' }
                    : receipt ? createDeploymentReceiptArtifactHeaderV1('Receipt', receipt.content) : undefined;
            if (!id || !body || !header) throw new Error(`Unexpected Storage HTTP boundary: ${path}`);
            // Use the canonical resource-key/envelope producer and content
            // codec in both Account modes; no opener or retention mock.
            let content = storedArtifactContents.get(id);
            if (!content) {
                const key = await createResourceDataKey({ credentials, mode });
                const encode = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
                    : encodeBase64(encryptWithDataKey(value, key.dataKey));
                content = { dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
                    header: encode(header), body: encode({ body: JSON.stringify(body) }) };
                storedArtifactContents.set(id, content);
            }
            return { status: 200, data: ArtifactHttpReadV1Schema.parse({ id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: mode, ...content,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }) };
        };
        // HTTP, the installed identity filesystem adapter and Docker executable
        // are boundaries. Retention, schema parsing, custody and Actions stay real.
        const boundaryRead = async (method: string, url: string) => {
            const observed: { method: string; path: string; code?: string } = { method, path: new URL(url).pathname };
            httpTrace.push(observed);
            try { return await response(url); }
            catch (error) {
                observed.code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                    ? error.code : error instanceof Error ? error.name : 'unknown_error';
                throw error;
            }
        };
        vi.spyOn(axios, 'request').mockImplementation(async request => boundaryRead(String(request.method ?? 'GET').toUpperCase(), axios.getUri(request)));
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => boundaryRead('GET', axios.getUri({ ...config, url: String(url) })));
        // Catch an uncovered genuine HTTP method without issuing a network
        // request. Diagnostics contain method/path/code, never headers or body.
        axios.defaults.adapter = async config => {
            httpTrace.push({ method: String(config.method ?? 'GET').toUpperCase(), path: new URL(axios.getUri(config)).pathname,
                code: 'fixture_http_unhandled' });
            throw Object.assign(new Error('fixture_http_unhandled'), { code: 'fixture_http_unhandled' });
        };
        const machine: Machine = { id: target.machineId, metadataVersion: 1,
            daemonState: null, daemonStateVersion: 0, metadata: { host: 'prune', platform: 'linux', happyCliVersion: 'dev',
                homeDir: root, happyHomeDir: root }, ...(mode === 'plain' ? { encryptionMode: 'plain' }
                    : { encryptionMode: 'e2ee', encryptionKey: machineContentKey, encryptionVariant: 'dataKey' }) };
        client = new ApiMachineClient(token, machine);
        Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true }));
        const native = createStorageDockerPruneForHost({ credentials, ...daemonTarget, serverHttpBaseUrl: profile.serverUrl,
            installationId: 'installation-a', happyHomeDir: root, async assertInstalledCurrent() {
                if (!active) throw Object.assign(new Error('retired'), { code: 'unauthorized' });
            } });
        const policy = await createStoragePolicyFixture();
        const identity = { ...daemonTarget, installationId: 'installation-a', custodianAccountId: 'owner' };
        routes = createDaemonStorageRoutes({ target: () => active ? identity : null, readOwnSessionIds: () => new Set(),
            deps: () => ({ ...identity, resourcesPolicy: policy, dockerPrune: native,
                catalog: { happyHomeDir: root, activeServerDir: join(root, 'server') }, readVolumes: () => [] }) });
        client.registerStorageRoutes(routes);
        const installed = client;
        const content: SocketRpcContent = mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
            encryptRaw: async value => encodeBase64(encryptWithDataKey(value, machineContentKey)),
            decryptRaw: async value => decrypt(machineContentKey, 'dataKey', decodeBase64(value)),
        } };
        // Only the Home/Socket.IO boundary is substituted. The real sender
        // resolves the published Machine key, binds/encrypts its RPC, and the
        // installed receiver runs its real Storage admission and Action owner.
        socketBoundary.create = () => createApiSessionSocketStub({ emitWithAck: async (event, packet) => {
            if (event !== SOCKET_RPC_EVENTS.CALL || !packet || typeof packet !== 'object') {
                throw new Error('Unexpected Storage Socket.IO event');
            }
            const method = Reflect.get(packet, 'method');
            if (typeof method !== 'string' || !method.startsWith(`${target.machineId}:`)) {
                throw new Error('Storage RPC did not target the installed Machine');
            }
            const opened = await socketRpcCodec.decodeRequestParams(content, Reflect.get(packet, 'params'), method);
            const result = await installed.invokeLocalMachineAction(method.slice(target.machineId.length + 1), opened.params,
                { rpcContext: { callerAuthority: 'present_user',
                    machineAdmission: { ...identity, actorAccountId: 'owner', role: 'manage', encryptionMode: mode },
                    verifyMachineAdmissionCurrent: async () => active } });
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, opened.callId) };
        } });
        const executor = createCliActionExecutor({ token, credentials, sessionId: 'cli-global', ...target,
            serverHttpBaseUrl: profile.serverUrl, mode, ctx: null });
        const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', serverId: target.serverId,
            presentUserConfirmation: { actionId: 'machines.storage.docker.prune' } };
        if (serverSelection === 'profile') {
            expect(await executor.execute('machines.storage.docker.prune', { ...target, serverId: 'srv_foreign',
                selection: { kind: 'unusedBuildCacheAndUnreferencedImages' } }, context)).toMatchObject({ ok: false });
            expect(await docker.readInvocations()).toEqual([]);
        }
        const invoke = async (selection: 'explicit' | 'safe' | 'unowned' = 'safe', signal?: AbortSignal) => {
            const selectedName = selection === 'unowned' ? 'unowned' : 'dangling';
            const selectedImage = images[names.indexOf(selectedName)]!;
            const outcome = await executor.execute('machines.storage.docker.prune', { ...target, expectedEngineId: engineId,
                selection: selection === 'safe' ? { kind: 'unusedBuildCacheAndUnreferencedImages' }
                    : { kind: 'explicit', images: [{ nativeId: ids[selectedName], configDigest: selectedImage.configDigest,
                        platform: selectedImage.platform }], buildCacheIds: [] } }, { ...context, ...(signal ? { signal } : {}) });
            expect(outcome.ok, JSON.stringify({ outcome, httpTrace })).toBe(true);
            if (!outcome.ok) throw new Error(JSON.stringify(outcome));
            return MachineStorageDockerPruneResultV1Schema.parse(outcome.result);
        };
        expect(await docker.readInvocations()).toEqual([]);
        await run({ invoke, docker, ids, engineId, bindMarker, setPending(value) { pending = value; }, retire() { active = false; },
            changeOnHeaderRecheck(kind) { changeOnRecheck = kind; } });
    } finally {
        socketBoundary.create = undefined;
        routes?.dispose();
        await client?.shutdown();
        Object.assign(configuration, previous);
        axios.defaults.adapter = previousHttpAdapter;
        await rm(root, { recursive: true, force: true });
    }
}

it.each([
    { mode: 'plain', selection: 'safe' }, { mode: 'plain', selection: 'explicit' },
    { mode: 'e2ee', selection: 'safe' }, { mode: 'e2ee', selection: 'explicit' },
] as const)('prunes only receipt-proven expired images through installed Storage ($mode/$selection)', async ({ mode, selection }) => {
    await fixture(async ({ invoke, docker, ids, bindMarker }) => {
        const result = await invoke(selection);
        expect(result.kind).toBe('completed');
        const remaining = await docker.readPruneImageIds();
        expect(remaining).not.toContain(ids.dangling);
        for (const key of ['active', 'retained', 'foreign', 'unowned', 'running'] as const) expect(remaining).toContain(ids[key]);
        if (selection === 'safe') expect(remaining).not.toContain(ids.owned);
        else expect(remaining).toContain(ids.owned);
        expect(await readFile(bindMarker, 'utf8')).toBe('retained bind data');
        const effects = (await docker.readInvocations()).filter(row => row.args[0] === 'image' && row.args[1] === 'rm');
        expect(effects.length).toBeGreaterThan(0);
        expect(effects.every(row => row.args[2] === '--no-prune' && row.args.length === 4)).toBe(true);
        expect((await docker.readInvocations()).some(row => row.args.includes('--force')
            || ['system', 'volume', 'builder'].includes(row.args[0] ?? '') || row.args[1] === 'prune')).toBe(false);
    }, mode);
});
it('prunes canonical Home image references when the daemon routes through a saved profile alias', async () => {
    await fixture(async ({ invoke, docker, ids, bindMarker }) => {
        expect(await invoke()).toMatchObject({ kind: 'completed' });
        const remaining = await docker.readPruneImageIds();
        expect(remaining).not.toContain(ids.dangling);
        for (const key of ['active', 'retained'] as const) expect(remaining).toContain(ids[key]);
        expect(await readFile(bindMarker, 'utf8')).toBe('retained bind data');
    }, 'plain', 'profile');
});

it('refuses unknown receipt custody and colliding engine work, then permits cleanup after actual settlement', async () => {
    await fixture(async ({ invoke, docker, engineId, setPending }) => {
        setPending(true);
        expect(await invoke()).toMatchObject({ kind: 'unavailable', reason: 'image_custody_unavailable' });
        expect((await docker.readInvocations()).filter(row => row.args[1] === 'rm')).toEqual([]);
        setPending(false);
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const acquired = new Promise<void>(resolve => { entered = resolve; });
        const build = machineNativeEffectAdmission.run({ operation: { operationId: 'native-build', kind: 'build' },
            keys: [{ kind: 'composeProject', dockerEndpoint: engineId, projectName: 'another-environment' }] }, async () => { entered(); await held; });
        await acquired;
        try {
            expect(await invoke()).toMatchObject({ kind: 'effect_in_progress', actionOperationId: 'native-build' });
            expect((await docker.readInvocations()).filter(row => row.args[1] === 'rm')).toEqual([]);
            await machineNativeEffectAdmission.run({ operation: { operationId: 'other-engine', kind: 'build' },
                keys: [{ kind: 'dockerEngine', dockerEndpoint: `${engineId}-other` }] }, async () => {});
        } finally { release(); await build; }
        expect(await invoke()).toMatchObject({ kind: 'completed' });
    });
});

it('refuses explicit tagless selectors that have no exact expired receipt alias', async () => {
    await fixture(async ({ invoke, docker, ids }) => {
        expect(await invoke('unowned')).toMatchObject({ kind: 'unsupported', reason: 'image_custody_unavailable', removed: [] });
        expect(await docker.readPruneImageIds()).toContain(ids.unowned);
        expect((await docker.readInvocations()).filter(row => row.args[1] === 'rm')).toEqual([]);
    });
});

it.each(['environment', 'receipt'] as const)('refuses changed %s headers before any irreversible effect', async kind => {
    await fixture(async ({ invoke, docker, changeOnHeaderRecheck }) => {
        changeOnHeaderRecheck(kind);
        expect(await invoke()).toMatchObject({ kind: 'changed', removed: [] });
        expect((await docker.readInvocations()).filter(row => row.args[1] === 'rm')).toEqual([]);
    });
});

it('reconciles lost native deletion acknowledgement only from known same-engine alias absence without replaying it', async () => {
    await fixture(async ({ invoke, docker, engineId }) => {
        await docker.loseImageRemovalAcknowledgement(true);
        try {
            expect(await invoke('explicit')).toMatchObject({ kind: 'outcome_unknown' });
            const removals = (await docker.readInvocations()).filter(row => row.args[0] === 'image' && row.args[1] === 'rm');
            expect(removals).toHaveLength(1);
            const reference = removals[0]!.args[3]!;
            expect(await docker.readPruneReference(reference)).toBeNull();
            await docker.setImageAliasInventoryUnavailable(true);
            expect(await invoke('explicit')).toMatchObject({ kind: 'effect_in_progress' });
            expect((await docker.readInvocations()).filter(row => row.args[0] === 'image' && row.args[1] === 'rm')).toHaveLength(1);
            await docker.setImageAliasInventoryUnavailable(false);
            await docker.loseImageRemovalAcknowledgement(false);
            expect(await invoke('explicit')).toMatchObject({ kind: 'completed' });
            const settled = (await docker.readInvocations()).filter(row => row.args[0] === 'image' && row.args[1] === 'rm');
            expect(settled.filter(row => row.args[3] === reference)).toHaveLength(1);
        } finally {
            await docker.setImageAliasInventoryUnavailable(false);
            await docker.loseImageRemovalAcknowledgement(false);
            // Always retire this test's unknown admission from native evidence,
            // even when an earlier assertion failed; never replay the effect.
            const removals = (await docker.readInvocations()).filter(row => row.args[0] === 'image' && row.args[1] === 'rm');
            const reference = removals[0]?.args[3];
            if (reference) await machineNativeEffectAdmission.reconcileUnknown({
                keys: [{ kind: 'dockerEngine', dockerEndpoint: engineId }],
                observeSettled: async () => await docker.readPruneReference(reference) === null,
            });
        }
    });
});

it('refuses a replaced reviewed engine before deletion and preserves stopped-container images', async () => {
    await fixture(async ({ invoke, docker, ids, engineId }) => {
        await docker.setPruneEngineId(`${engineId}-replacement`);
        expect(await invoke()).toMatchObject({ kind: 'changed', removed: [] });
        expect((await docker.readInvocations()).filter(row => row.args[1] === 'rm')).toEqual([]);
        await docker.setPruneEngineId(engineId);
        await docker.setImageContainerReference(ids.running, 'exited');
        expect(await invoke()).toMatchObject({ kind: 'completed' });
        expect(await docker.readPruneImageIds()).toContain(ids.running);
    });
});

it.each(['{malformed native JSON', '[{"Id":"unproven","RepoTags":[],"RepoDigests":[]}]'])(
    'returns typed unavailable for an unprovable native inventory without deletion (%s)', async output => {
        await fixture(async ({ invoke, docker }) => {
            await docker.setImageInspectionOutput(output);
            expect(await invoke()).toMatchObject({ kind: 'unavailable', reason: 'native_inventory_unavailable', removed: [] });
            expect((await docker.readInvocations()).filter(row => row.args[0] === 'image' && row.args[1] === 'rm')).toEqual([]);
        });
    });
