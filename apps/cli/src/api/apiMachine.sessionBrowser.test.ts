import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { configuration } from '@/configuration';
import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { createMachineContentCodec } from './machine/machineStoredContent';
import { encodeBase64, libsodiumEncryptForPublicKey, libsodiumPublicKeyFromSecretKey } from './encryption';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import { ApiMachineClient } from './apiMachine';
import type { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import { admitRequesterSessionBootstrap, createRequesterSessionRuntimeContextResolver, releaseUnretainedRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import type { TrackedSession } from '@/daemon/types';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const boundary = vi.hoisted(() => ({ credentials: null as StoredCredentials | null,
    identity: null as import('@happier-dev/protocol').MachineInstallationIdentityV1 | null }));
// Only persisted identity/credentials and Home/socket network boundaries are substituted.
vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(),
    readStoredCredentialsForServerId: async () => boundary.credentials }));
vi.mock('@/daemon/identity/store', async original => ({ ...await original<typeof import('@/daemon/identity/store')>(),
    readInstallationIdentityIfExistsSync: () => boundary.identity }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.credentials = null; boundary.identity = null; });

it.each(['plain', 'e2ee'] as const)('uses retained guest custody for shared Browser RPC in a %s Session without a custodian Session grant', async mode => {
    const pair = tweetnacl.sign.keyPair();
    boundary.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
        publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    const token = (sub: string) => `fixture.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.fixture`;
    boundary.credentials = { token: token('custodian'), encryption: null };
    const seed = new Uint8Array(32).fill(3), sessionKey = new Uint8Array(32).fill(9);
    const publicKey = libsodiumPublicKeyFromSecretKey(seed);
    const guest: StoredCredentials = { token: token('guest'), encryption: mode === 'plain' ? null
        : { type: 'dataKey', machineKey: seed, publicKey } };
    const sealedKey = libsodiumEncryptForPublicKey(sessionKey, publicKey);
    const bundle = new Uint8Array(sealedKey.length + 1); bundle.set(sealedKey, 1);
    const codec = createMachineContentCodec(mode === 'plain' ? { encryptionMode: 'plain' }
        : { encryptionKey: sessionKey, encryptionVariant: 'dataKey' });
    const content: SocketRpcContent = codec.mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
        encryptRaw: async value => codec.encodeRpc(value), decryptRaw: async value => codec.decodeRpc(value) } };
    const sessionId = 'c' + '7'.repeat(24), machineId = 'machine';
    const sessionReaders: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        const path = new URL(String(url)).pathname;
        const requester = options?.headers?.Authorization === `Bearer ${guest.token}`;
        if (path === `/v2/sessions/${sessionId}`) {
            sessionReaders.push(requester ? 'guest' : 'custodian');
            if (!requester) return { status: 404, data: { error: 'not_found' } };
            return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, active: true, share: null,
                encryptionMode: mode, metadata: codec.encodeStored({ machineId, path: '/repo' }),
                dataEncryptionKey: mode === 'plain' ? null : encodeBase64(bundle) }) } };
        }
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: requester ? mode : 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: requester ? mode : 'plain', updatedAt: 1 } };
        if (path === '/v2/account/settings') return { status: 200, data: requester && mode === 'e2ee'
            ? { content: null, version: 0 } : { content: { t: 'plain', v: {} }, version: 1 } };
        if (path.endsWith('/profile')) return { status: 200, data: { id: requester ? 'guest' : 'custodian', settings: null, settingsVersion: 0 } };
        throw new Error(`Unexpected Home read ${path}`);
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_browser_home' } } }), { status: 200 })));
    const directory = await mkdtemp(join(tmpdir(), 'requester-browser-'));
    const serverId = configuration.activeServerId, serverHttpBaseUrl = resolveServerHttpBaseUrl();
    const trackedSessions = new Map<SessionTrackingKey, TrackedSession>(), registry = new ConnectedServiceRuntimeRegistry();
    let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
    const host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
        serverId, serverHttpBaseUrl, machineId, custodianAccountId: 'custodian', credentials: boundary.credentials,
        connectedServicesMaterializationBaseDir: join(directory, 'materialized'), registry, trackedSessions,
        getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    onTestFinished(async () => { await runtime?.dispose(); await host.dispose(); await rm(directory, { recursive: true, force: true }); });
    const bootstrap = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials(guest) },
        existingSessionId: sessionId, boundary: { serverId, serverHttpBaseUrl, happyHomeDir: directory }, context: {
            signal: new AbortController().signal, machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'custodian', machineId,
                installationId: boundary.identity.installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true } });
    if (!bootstrap) throw new Error('Requester bootstrap was not admitted');
    runtime = await createRequesterSessionRuntimeContext({ bootstrap: bootstrap.admitted, providerAccountUsageStore: createProviderAccountUsageStore(),
        activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'), resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
        coordinatorInput: { machineId, machineIdProvider: () => machineId, runtimeId: 'browser-runtime', happyHomeDir: directory,
            logger: { debug() {}, info() {}, warn() {} }, processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
            trackedSessionsByKey: trackedSessions, connectedServiceRuntimeRegistry: registry,
            connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!runtime) throw new Error('Requester runtime was not retained');
    trackedSessions.set(legacyPidSessionTrackingKey(process.pid), { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: sessionId, startedBy: 'daemon',
        requesterWorkAttributionV1: runtime.bootstrap.attribution, requesterSessionRuntimeContext: runtime });
    const resolve = createRequesterSessionRuntimeContextResolver({ trackedSessions, getCreateRuntime: () => null, recoverBootstrap: async () => null });
    let releases = 0;
    const client = new ApiMachineClient(boundary.credentials.token, { id: machineId, encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined, { requesterSessionRuntime: {
            serverId, resolve, release: async context => { releases++; await releaseUnretainedRequesterSessionRuntimeContext(context,
                [...trackedSessions.values()].map(tracked => tracked.requesterSessionRuntimeContext)); } } });
    onTestFinished(() => client.shutdown());
    const manager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    manager.registerHandler(RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT, input => input);
    const access = { kind: 'session.browser' as const, sessionId, actorAccountId: 'viewer', custodianAccountId: 'custodian', machineId,
        installationId: boundary.identity.installationId, effectiveAccess: { v: 1 as const, level: 'view' as const,
            sources: [{ kind: 'direct' as const, shareId: 'share' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: false,
                grants: [{ accessLevel: 'view', canApprovePermissions: false }] }) } };
    const callId = '71'.repeat(16), input = { protocolVersion: 1, machineId, streamFamily: 'browser.streamed', sourceId: 'browser-source' };
    sessionReaders.length = 0;
    const params = await socketRpcCodec.encodeParams(content, input, { method: `${sessionId}:${RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT}`, callId });
    const response = await manager.handleRequest({ method: `${machineId}:${RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT}`,
        params, authorization: access, callerAuthority: 'present_user' }, undefined, 'authenticated_home_socket');
    expect(await socketRpcCodec.decodeResult(content, { ok: true, result: response }, callId)).toEqual(input);
    expect(sessionReaders).toEqual(['guest']);
    expect(releases).toBe(1);
});
