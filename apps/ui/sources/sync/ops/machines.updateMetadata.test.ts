import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePlainMachineStoredContent, type MachineUpdateMetadataRequest, type MachineUpdateMetadataResponse } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { MachineMetadata } from '@/sync/domains/state/storageTypes';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDeferred } from '@/dev/testkit';
import type { Socket } from 'socket.io-client';

// The host graph imports Socket before the configured transport harness;
// hoist this genuine network boundary before those first imports.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const sent: MachineUpdateMetadataRequest[] = [];
let respond: (request: MachineUpdateMetadataRequest) => Promise<MachineUpdateMetadataResponse>;
let readySocket: Socket | undefined;
installDisconnectedServerSocketBoundary((socket) => {
    readySocket = socket;
    socket.connected = true;
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, request: MachineUpdateMetadataRequest) => {
        if (event !== 'machine-update-metadata') throw new Error('Unexpected metadata socket event: ' + event);
        sent.push(request);
        return await respond(request);
    });
});

type StoreState = ReturnType<ReturnType<typeof import('@/sync/domains/state/storage').getStorage>['getState']>;
let initialState: StoreState;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
async function fixture(mode: 'plain' | 'e2ee') {
    readySocket = undefined;
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    // Reachability's HTTP probe is a separate genuine network leaf from the
    // Account request adapter installed by the governance harness.
    setRuntimeFetch(async (input) => {
        const url = new URL(String(input));
        if (url.origin !== 'https://machine-metadata.test') throw new Error('unexpected_metadata_probe_origin');
        return url.pathname === '/v1/auth/ping' ? Response.json({ ok: true }) : new Response(null, { status: 404 });
    });
    const homeId = await homes.addHome({ name: 'Metadata Home', serverUrl: 'https://machine-metadata.test', accountId: 'account-a', accountEncryptionMode: mode });
    const token = homes.findByServerUrl('https://machine-metadata.test')?.token;
    if (!token) throw new Error('expected_metadata_account');
    homes.answer(homeId, '/v2/cursor', { body: { cursor: '0' } });
    const { encodeBase64 } = await import('@/encryption/base64');
    const credentials = mode === 'plain' ? { token } : { token, secret: encodeBase64(new Uint8Array(32).fill(17), 'base64url') };
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(credentials);
    await vi.waitFor(() => expect(readySocket?.connected).toBe(true));
    const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
    const sync = getSyncSingleton();
    const { MACHINE_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/machines/machineStoredContent');
    let dataEncryptionKey = MACHINE_PLAIN_DATA_KEY_MARKER;
    if (mode === 'e2ee') {
        if (!sync.encryption) throw new Error('expected_real_account_encryption');
        dataEncryptionKey = encodeBase64(await sync.encryption.encryptEncryptionKey(new Uint8Array(32).fill(23)), 'base64');
        sync.encryption.captureMachineEncryptionContext('m1', { dataEncryptionKey, expectedDataEncryptionKey: dataEncryptionKey });
        await sync.encryption.initializeMachines(new Map([['m1', new Uint8Array(32).fill(23)]]));
    }
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { getStorage } = await import('@/sync/domains/state/storage');
    const machine = createMachineFixture({ id: 'm1', storageMode: mode, metadataVersion: 4, dataEncryptionKey });
    getStorage().getState().applyMachines([machine]);
    const metadata: MachineMetadata = { ...machine.metadata!, displayName: 'New Name' };
    return { sync, metadata, homeId, dataEncryptionKey };
}

describe('machineUpdateMetadata', () => {
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        await homes.reset();
        // afterEach restores the native credential boundary; each real Action
        // capture must read this test's Home rather than the unseeded device store.
        installHomeGovernanceBoundaries(homes);
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        const { getStorage } = await import('@/sync/domains/state/storage');
        initialState = getStorage().getState();
        sent.length = 0;
    });
    afterEach(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
        await homes.reset();
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().setState(initialState, true);
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
        vi.restoreAllMocks();
        webLocks.restore();
    });

    it('encrypts E2EE metadata and applies the updated metadata locally on success', async () => {
        const { sync, metadata, dataEncryptionKey } = await fixture('e2ee');
        const cipher = sync.encryption?.getMachineEncryption('m1');
        if (!cipher) throw new Error('expected_real_machine_cipher');
        const serverBytes = await cipher.encryptRaw(metadata);
        respond = async () => ({ result: 'success', version: 5, metadata: serverBytes });
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({ enabled: true });
        syncPerformanceTelemetry.reset();
        const { machineUpdateMetadata } = await import('./machines');
        await expect(machineUpdateMetadata('m1', metadata, 4)).resolves.toEqual({ version: 5, metadata: serverBytes });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ machineId: 'm1', expectedVersion: 4, expectedDataEncryptionKey: dataEncryptionKey });
        expect(() => decodePlainMachineStoredContent(sent[0]!.metadata)).toThrow();
        expect(await cipher.decryptRaw(sent[0]!.metadata)).toEqual(metadata);
        const { getStorage } = await import('@/sync/domains/state/storage');
        expect(getStorage().getState().machines.m1).toMatchObject({ metadataVersion: 5, metadata });
        expect(syncPerformanceTelemetry.snapshot().events.find((event) => event.name === 'sync.encryption.machine.encryptRaw.metadataWrite'))
            .toMatchObject({ count: 1, fields: { items: 1 } });
    });

    it('writes plaintext Machine metadata without requiring Account or Machine encryption', async () => {
        const { sync, metadata, dataEncryptionKey } = await fixture('plain');
        expect(sync.encryption).toBeNull();
        respond = async (request) => ({ result: 'success', version: 5, metadata: request.metadata });
        const { machineUpdateMetadata } = await import('./machines');
        await machineUpdateMetadata('m1', metadata, 4);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ machineId: 'm1', expectedVersion: 4, expectedDataEncryptionKey: dataEncryptionKey });
        expect(decodePlainMachineStoredContent(sent[0]!.metadata)).toEqual(metadata);
    });

    it('settles an acknowledged old write without publishing it over a replaced context', async () => {
        const { sync, metadata, dataEncryptionKey } = await fixture('e2ee');
        const issued = createDeferred<void>();
        const reply = createDeferred<MachineUpdateMetadataResponse>();
        respond = async () => { issued.resolve(); return await reply.promise; };
        const { machineUpdateMetadata } = await import('./machines');
        const pending = machineUpdateMetadata('m1', metadata, 4);
        await issued.promise;
        const { getStorage } = await import('@/sync/domains/state/storage');
        const current = getStorage().getState().machines.m1!;
        sync.encryption!.captureMachineEncryptionContext('m1', {
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        });
        getStorage().getState().applyMachines([{
            ...current, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            metadataVersion: 7, metadata: { ...current.metadata!, displayName: 'Converted current' },
        }]);
        reply.resolve({ result: 'success', version: 5, metadata: sent[0]!.metadata });
        expect(await pending).toMatchObject({ version: 5 });
        expect(sent).toHaveLength(1);
        expect(sent[0]?.expectedDataEncryptionKey).toBe(dataEncryptionKey);
        expect(getStorage().getState().machines.m1).toMatchObject({ metadataVersion: 7, metadata: { displayName: 'Converted current' } });
    });

    it('rebases finite policy over an unrelated metadata CAS change on the exact Machine', async () => {
        const { metadata, homeId } = await fixture('plain');
        const current = { ...metadata, displayName: 'Current Name' };
        homes.answer(homeId, '/v1/machines/m1', { body: { machine: {
            id: 'm1', metadata: encodePlainMachineStoredContent(current), metadataVersion: 4,
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } } });
        respond = async (request) => request.expectedVersion === 4
            ? { result: 'version-mismatch', version: 5, metadata: encodePlainMachineStoredContent({ ...current, displayName: 'Concurrent Name' }) }
            : { result: 'success', version: 6, metadata: request.metadata };
        const { machineWorkerPolicySet } = await import('./machineFinitePolicy');
        expect(await machineWorkerPolicySet('m1', {
            expectedPolicy: { accepting: true, runAtMost: null }, expectedMetadataVersion: 4,
            policy: { accepting: false, runAtMost: 2 },
        })).toEqual({ status: 'applied', policy: { accepting: false, runAtMost: 2 }, metadataVersion: 6 });
        expect(sent).toHaveLength(2);
        expect(decodePlainMachineStoredContent(sent[1]!.metadata)).toMatchObject({
            displayName: 'Concurrent Name', finitePolicyV1: { accepting: false, runAtMost: 2 },
        });
    });

    it('preserves a confirmed E2EE policy receipt after Account material retirement without stale publication', async () => {
        const { sync, metadata, homeId, dataEncryptionKey } = await fixture('e2ee');
        const capturedEncryption = sync.encryption;
        const cipher = capturedEncryption?.getMachineEncryption('m1');
        if (!cipher) throw new Error('expected_real_machine_cipher');
        homes.answer(homeId, '/v1/machines/m1', { body: { machine: {
            id: 'm1', metadata: await cipher.encryptRaw(metadata), metadataVersion: 4,
            dataEncryptionKey,
        } } });
        const issued = createDeferred<void>();
        const reply = createDeferred<MachineUpdateMetadataResponse>();
        respond = async () => { issued.resolve(); return await reply.promise; };
        const { machineWorkerPolicySet } = await import('./machineFinitePolicy');
        const pending = machineWorkerPolicySet('m1', {
            expectedPolicy: { accepting: true, runAtMost: null }, expectedMetadataVersion: 4,
            policy: { accepting: false, runAtMost: 2 },
        });
        await issued.promise;
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ machineId: 'm1', expectedVersion: 4, expectedDataEncryptionKey: dataEncryptionKey });
        expect(() => decodePlainMachineStoredContent(sent[0]!.metadata)).toThrow();
        expect(await cipher.decryptRaw(sent[0]!.metadata)).toMatchObject({ finitePolicyV1: { accepting: false, runAtMost: 2 } });

        await homes.switchAccount(homeId, 'replacement');
        const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        // The real credential boundary returns the replacement's token-only
        // credential; the connection owner replaces the original E2EE runtime.
        await switchConnectionToActiveServer();
        expect(sync.encryption).toBeNull();
        const { getStorage } = await import('@/sync/domains/state/storage');
        expect(getStorage().getState().profileScope).toMatchObject({ serverId: homeId, accountId: 'replacement' });
        expect(getStorage().getState().machines.m1).toBeUndefined();

        reply.resolve({ result: 'success', version: 5, metadata: sent[0]!.metadata });
        expect(await pending).toEqual({ status: 'applied', policy: { accepting: false, runAtMost: 2 }, metadataVersion: 5 });
        expect(sync.encryption).toBeNull();
        expect(getStorage().getState().machines.m1).toBeUndefined();
        expect(sent).toHaveLength(1);
        expect(homes.requestsFor('/v1/machines/m1')).toHaveLength(1);
    });

    it.each(['confirmed', 'lost', 'malformed', 'mismatched', 'version-mismatch', 'key-mismatch'] as const)(
        'verifies policy receipt custody after credential retirement without stale metadata (%s acknowledgement)', async (acknowledgement) => {
        const { metadata, homeId } = await fixture('plain');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://machine-metadata.test', { serverId: homeId });
        if (!credentials) throw new Error('expected_current_metadata_home_credential');
        const accountId = parseToken(credentials.token);
        const { getStorage } = await import('@/sync/domains/state/storage');
        expect(getStorage().getState().profileScope).toMatchObject({ serverId: homeId, accountId });
        const settingsScope = getStorage().getState().settingsScope;
        expect(settingsScope).toMatchObject({ serverId: homeId, accountId });
        if (!settingsScope) throw new Error('expected_current_metadata_settings_scope');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const configuredSettings = settingsParse({ ...getStorage().getState().settings,
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.worker.policy.set': ['ui'] } },
        });
        const settingsVersion = (getStorage().getState().settingsVersion ?? 0) + 1;
        homes.answer(homeId, '/v1/machines/m1', { body: { machine: {
            id: 'm1', metadata: encodePlainMachineStoredContent(metadata), metadataVersion: 4,
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } } });
        homes.answer(homeId, '/v2/account/settings', { body: { content: { t: 'plain', v: configuredSettings }, version: settingsVersion } });
        // The restored active Account is the Action's canonical settings source;
        // a later HTTP answer alone cannot replace its already-published baseline.
        getStorage().getState().applySettingsForScope(settingsScope, configuredSettings, settingsVersion);
        expect(getStorage().getState().settingsVersion).toBe(settingsVersion);
        expect(getStorage().getState().settings.actionsSettingsV1.approvalWaivedSurfaces?.['machines.worker.policy.set']).toEqual(['ui']);
        respond = async (request) => {
            expect(request.expectedDataEncryptionKey).toBe(MACHINE_PLAIN_DATA_KEY_MARKER);
            expect(decodePlainMachineStoredContent(request.metadata)).toMatchObject({ finitePolicyV1: { accepting: false, runAtMost: 2 } });
            await homes.switchAccount(homeId, 'replacement');
            if (acknowledgement === 'lost') throw new TypeError('Metadata acknowledgement disconnected after dispatch');
            if (acknowledgement === 'malformed') return { result: 'success', version: -1, metadata: request.metadata };
            if (acknowledgement === 'mismatched') return { result: 'success', version: 5,
                metadata: encodePlainMachineStoredContent({ ...metadata, finitePolicyV1: { accepting: true, runAtMost: null } }) };
            if (acknowledgement === 'version-mismatch') return { result: 'version-mismatch', version: 5, metadata: request.metadata };
            if (acknowledgement === 'key-mismatch') return { result: 'key-mismatch' };
            return { result: 'success', version: 5, metadata: request.metadata };
        };
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('machines.worker.policy.set', {
            serverId: homeId, machineId: 'm1',
            expectedPolicy: { accepting: true, runAtMost: null }, expectedMetadataVersion: 4,
            policy: { accepting: false, runAtMost: 2 },
        }, { surface: 'ui', serverId: homeId, expectedAccountId: accountId })).toEqual({ ok: true,
            result: acknowledgement === 'confirmed'
                ? { status: 'applied', policy: { accepting: false, runAtMost: 2 }, metadataVersion: 5 }
                : { status: 'outcomeUnknown' } });
        expect(getStorage().getState().machines.m1?.metadataVersion).toBe(4);
        expect(homes.findByServerUrl('https://machine-metadata.test')?.accountId).toBe('replacement');
        expect(sent).toHaveLength(1);
        expect(homes.requestsFor('/v1/machines/m1')).toHaveLength(1);
    });

    it('preserves a typed Home stored-content upgrade requirement without a local snapshot preflight', async () => {
        const { sync, metadata, homeId } = await fixture('plain');
        expect(sync.encryption).toBeNull();
        homes.answer(homeId, '/v1/features', { body: { capabilities: { encryption: { storagePolicy: 'optional' } } } });
        respond = async () => ({
            error: 'client-upgrade-required',
            requirement: { v: 1, kind: 'account-stored-content', minimumProtocolVersion: 2 },
        });
        const { machineUpdateMetadata } = await import('./machines');
        await expect(machineUpdateMetadata('m1', metadata, 4)).rejects.toMatchObject({
            code: 'client-upgrade-required', retryable: false,
            requirement: { v: 1, kind: 'account-stored-content', minimumProtocolVersion: 2 },
        });
        // Compatibility admission is the server socket owner's verdict today,
        // not an invented client feature-snapshot preflight or plaintext fallback.
        expect(sent).toHaveLength(1);
        expect(decodePlainMachineStoredContent(sent[0]!.metadata)).toEqual(metadata);
        const { getStorage } = await import('@/sync/domains/state/storage');
        expect(getStorage().getState().machines.m1?.metadataVersion).toBe(4);
    });
});
