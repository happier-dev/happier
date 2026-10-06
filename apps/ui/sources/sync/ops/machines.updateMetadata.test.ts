import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePlainMachineStoredContent, type MachineUpdateMetadataRequest, type MachineUpdateMetadataResponse } from '@happier-dev/protocol';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { MachineMetadata } from '@/sync/domains/state/storageTypes';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const sent: MachineUpdateMetadataRequest[] = [];
let respond: (request: MachineUpdateMetadataRequest) => Promise<MachineUpdateMetadataResponse>;
installDisconnectedServerSocketBoundary((socket) => {
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
    const homeId = await homes.addHome({ name: 'Metadata Home', serverUrl: 'https://machine-metadata.test', accountId: 'account-a', accountEncryptionMode: mode });
    const token = homes.findByServerUrl('https://machine-metadata.test')?.token;
    if (!token) throw new Error('expected_metadata_account');
    homes.answer(homeId, '/v2/cursor', { body: { cursor: '0' } });
    const { encodeBase64 } = await import('@/encryption/base64');
    const credentials = mode === 'plain' ? { token } : { token, secret: encodeBase64(new Uint8Array(32).fill(17), 'base64url') };
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(credentials);
    const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
    const sync = getSyncSingleton();
    if (mode === 'e2ee') {
        if (!sync.encryption) throw new Error('expected_real_account_encryption');
        await sync.encryption.initializeMachines(new Map([['m1', new Uint8Array(32).fill(23)]]));
    }
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { getStorage } = await import('@/sync/domains/state/storage');
    const machine = createMachineFixture({ id: 'm1', storageMode: mode, metadataVersion: 4 });
    getStorage().getState().applyMachines([machine]);
    const metadata: MachineMetadata = { ...machine.metadata!, displayName: 'New Name' };
    return { sync, metadata, homeId };
}

describe('machineUpdateMetadata', () => {
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        const { getStorage } = await import('@/sync/domains/state/storage');
        initialState = getStorage().getState();
        sent.length = 0;
    });
    afterEach(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
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
        const { sync, metadata } = await fixture('e2ee');
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
        expect(sent[0]).toMatchObject({ machineId: 'm1', expectedVersion: 4 });
        expect(decodePlainMachineStoredContent(sent[0]!.metadata)).toBeNull();
        expect(await cipher.decryptRaw(sent[0]!.metadata)).toEqual(metadata);
        const { getStorage } = await import('@/sync/domains/state/storage');
        expect(getStorage().getState().machines.m1).toMatchObject({ metadataVersion: 5, metadata });
        expect(syncPerformanceTelemetry.snapshot().events.find((event) => event.name === 'sync.encryption.machine.encryptRaw.metadataWrite'))
            .toMatchObject({ count: 1, fields: { items: 1 } });
    });

    it('writes plaintext Machine metadata without requiring Account or Machine encryption', async () => {
        const { sync, metadata } = await fixture('plain');
        expect(sync.encryption).toBeNull();
        respond = async (request) => ({ result: 'success', version: 5, metadata: request.metadata });
        const { machineUpdateMetadata } = await import('./machines');
        await machineUpdateMetadata('m1', metadata, 4);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ machineId: 'm1', expectedVersion: 4 });
        expect(decodePlainMachineStoredContent(sent[0]!.metadata)).toEqual(metadata);
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
