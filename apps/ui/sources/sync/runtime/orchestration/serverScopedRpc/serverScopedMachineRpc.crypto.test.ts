import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import {
    deriveAccountMachineKeyFromRecoverySecret,
    sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
    createMachineFixture,
    createServerFetchWithReachabilityProbe,
    createSessionFixture,
} from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decrypt, encrypt } from '../../../../../../cli/src/api/encryption';

installTokenStorageWebPlatformMocks();

const transport = vi.hoisted(() => ({
    respond: null as null | ((payload: { method: string; params: string }) => unknown),
}));

// Socket.IO is the network boundary; credential storage, context resolution, envelope opening,
// and the scoped RPC encoder/decoder remain real.
vi.mock('socket.io-client', () => ({
    io: () => {
        const socket = {
            connected: true,
            on: () => socket,
            onAny: () => socket,
            off: () => socket,
            connect: () => socket,
            disconnect: () => socket,
            emit: () => socket,
            emitWithAck: async (_event: string, payload: { method: string; params: string }) => transport.respond?.(payload),
            timeout: (_ms: number) => socket,
        };
        return socket;
    },
}));

describe('scoped Machine RPC credential interoperability', () => {
    let restoreLocalStorage: (() => void) | undefined;

    async function prepareMachine() {
        restoreLocalStorage = installLocalStorageMock().restore;
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const profile = upsertAndActivateServer({ serverUrl: 'http://localhost:41739' });
        const recoverySecret = new Uint8Array(randomBytes(32));
        const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey: machineKey, recipientPublicKey: publicKey, randomBytes });
        await TokenStorage.setCredentials({ token: 'generated-account-token', secret: encodeBase64(recoverySecret, 'base64url') });
        const features = createRootLayoutFeaturesResponse({ features: {
            machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } } },
        } });
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => Response.json(
            new URL(String(input)).pathname === '/v1/features'
                ? features
                : [{ id: 'machine-crypto-test', dataEncryptionKey: encodeBase64(envelope) }],
        ))));
        transport.respond = (payload) => {
            expect(payload.method).toBe('machine-crypto-test:listDirectory');
            expect(decrypt(machineKey, 'dataKey', decodeBase64(payload.params))).toEqual({ path: '/repo' });
            return { ok: true, result: encodeBase64(encrypt(machineKey, 'dataKey', { success: true, entries: [{ name: 'AGENTS.md', type: 'file' }] })) };
        };
        return profile;
    }

    afterEach(async () => {
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { serverScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
        const { resetScopedMachineDataKeyCacheForTests } = await import('./serverScopedRpcPool');
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        apiSocket.disconnect();
        await serverScopedRpcSocketPool.stopAll();
        await resetServerReachabilitySupervisors();
        resetScopedMachineDataKeyCacheForTests();
        transport.respond = null;
        vi.unstubAllGlobals();
        restoreLocalStorage?.();
    });

    it('resolves guarded file RPC through the scoped key owner while active Machine encryption is not hydrated', async () => {
        const profile = await prepareMachine();
        const { storage } = await import('@/sync/domains/state/storage');
        const { sessionListDirectory } = await import('@/sync/ops/sessionFileSystem/directoryBrowsing');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) throw new Error('Expected stored credentials');
        apiSocket.initialize({ endpoint: profile.serverUrl, token: credentials.token }, await createEncryptionFromAuthCredentials(credentials));
        const previous = storage.getState();
        const metadata = createSessionFixture().metadata;
        if (!metadata) throw new Error('Expected session fixture metadata');
        const session = createSessionFixture({
            active: true,
            metadata: { ...metadata, machineId: 'machine-crypto-test', path: '/repo' },
        });
        storage.setState({
            sessions: { [session.id]: session },
            machines: { 'machine-crypto-test': createMachineFixture({ id: 'machine-crypto-test' }) },
        });
        try {
            await expect(sessionListDirectory(session.id, '.')).resolves.toEqual({
                success: true, entries: [{ name: 'AGENTS.md', type: 'file' }],
            });
        } finally {
            storage.setState({ sessions: previous.sessions, machines: previous.machines });
        }
    });
});
