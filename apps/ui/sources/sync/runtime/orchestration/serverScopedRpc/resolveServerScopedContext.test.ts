import { afterEach, describe, expect, it, vi } from 'vitest';

const getCredentialsSpy = vi.hoisted(() => vi.fn());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsSpy(...args),
    },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: (...args: unknown[]) => createEncryptionSpy(...args),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

describe('resolveServerScopedContext', () => {
    afterEach(() => {
        getCredentialsSpy.mockReset();
        createEncryptionSpy.mockReset();
        listServerProfilesSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
    });

    it('returns active scope when serverId is missing', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });

        const { resolveServerScopedContext } = await import('./resolveServerScopedContext');
        const context = await resolveServerScopedContext({
            machineId: 'machine-1',
        });

        expect(context).toEqual({
            scope: 'active',
            machineId: 'machine-1',
            timeoutMs: 30000,
        });
    });

    it('returns scoped context with credentials and encryption when target differs from active server', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
        ]);
        getCredentialsSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
        const fakeEncryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(),
        };
        createEncryptionSpy.mockResolvedValue(fakeEncryption);

        const { resolveServerScopedContext } = await import('./resolveServerScopedContext');
        const context = await resolveServerScopedContext({
            machineId: 'machine-1',
            serverId: 'server-b',
            timeoutMs: 5000,
        });

        expect(context).toEqual({
            scope: 'scoped',
            machineId: 'machine-1',
            timeoutMs: 5000,
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            token: 'token-b',
            encryption: fakeEncryption,
        });
    });
});
