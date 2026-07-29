import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_SESSION_SYNC_PROTOCOL_VERSION } from '@happier-dev/protocol';

const ioMock = vi.hoisted(() => vi.fn(() => ({
    on: vi.fn(),
})));

vi.mock('socket.io-client', () => ({
    io: ioMock,
}));

vi.mock('@/utils/proxy/socketIoProxy', () => ({
    getSocketIoProxyOptions: () => ({}),
}));

describe('createMachineSocketTransport', () => {
    beforeEach(() => {
        ioMock.mockClear();
    });

    it('declares the current CLI as a daemon on the machine-scoped socket', async () => {
        const { configuration } = await import('@/configuration');
        const { createMachineSocketTransport } = await import('./createMachineSocketTransport');

        createMachineSocketTransport({
            serverUrl: 'https://api.example.com',
            token: 'token',
            machineId: 'machine-1',
            env: {},
        });

        expect(ioMock).toHaveBeenLastCalledWith('https://api.example.com', expect.objectContaining({
            auth: expect.objectContaining({
                clientCompatibility: {
                    v: 1,
                    clientKind: 'daemon',
                    appVersion: configuration.currentCliVersion,
                    sessionSyncProtocolVersion: CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
                },
            }),
        }));
    });

    it('includes installation identity fields in machine-scoped socket auth when provided', async () => {
        const installationPublicKey = Buffer.from(new Uint8Array(32)).toString('base64url');
        const installationProofSignature = Buffer.from(new Uint8Array(64)).toString('base64url');
        const { createMachineSocketTransport } = await import('./createMachineSocketTransport');

        createMachineSocketTransport({
            serverUrl: 'https://api.example.com',
            token: 'token',
            machineId: 'machine-1',
            installationId: 'installation-1',
            installationPublicKey,
            installationProof: {
                version: 1,
                algorithm: 'ed25519',
                signature: installationProofSignature,
            },
            env: {},
        });

        expect(ioMock).toHaveBeenCalledWith('https://api.example.com', expect.objectContaining({
            auth: expect.objectContaining({
                clientType: 'machine-scoped',
                machineId: 'machine-1',
                installationId: 'installation-1',
                installationPublicKey,
                installationProof: {
                    version: 1,
                    algorithm: 'ed25519',
                    signature: installationProofSignature,
                },
            }),
        }));
    });

});
