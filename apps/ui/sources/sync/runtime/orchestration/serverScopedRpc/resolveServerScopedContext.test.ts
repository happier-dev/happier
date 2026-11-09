import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Encryption } from '@/sync/encryption/encryption';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resolveServerScopedContext } from './resolveServerScopedContext';

const getCredentialsSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const getAppliedActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const isAppliedActiveServerRuntimeAvailableSpy = vi.hoisted(() => vi.fn());
const SECRET_A = btoa('a'.repeat(32));
const SECRET_B = btoa('b'.repeat(32));

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    // Only the credential read is stubbed; the credential-shape predicates stay real so
    // this suite keeps exercising the actual token-only/legacy/dataKey classification.
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsSpy(...args),
        },
    };
});

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createServerProfilesModuleMock({
        listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
    });
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: (...args: unknown[]) => getAppliedActiveServerSnapshotSpy(...args),
    isAppliedActiveServerRuntimeAvailable: (...args: unknown[]) => isAppliedActiveServerRuntimeAvailableSpy(...args),
}));

describe('resolveServerScopedContext', () => {
    beforeEach(() => {
        getAppliedActiveServerSnapshotSpy.mockImplementation(() => getActiveServerSnapshotSpy());
        isAppliedActiveServerRuntimeAvailableSpy.mockReturnValue(true);
        setRuntimeFetch(async (input, init) => {
            const target = new URL(String(input));
            if (target.pathname !== '/v1/account/encryption/currentness') return Response.json({});
            const account = target.hostname === 'server-a.example.test' ? 'a' : 'b';
            if (new Headers(init?.headers).get('authorization') !== `Bearer ${tokenForSub(`account-${account}`)}`) {
                return Response.json({ error: 'unauthorized' }, { status: 401 });
            }
            return Response.json(createLegacyAccountEncryptionCurrentnessFixture({
                secret: new Uint8Array(32).fill(account.charCodeAt(0)),
            }));
        });
    });

    afterEach(() => {
        invalidateAccountEncryptionModeCache();
        resetRuntimeFetch();
        getCredentialsSpy.mockReset();
        listServerProfilesSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
        getAppliedActiveServerSnapshotSpy.mockReset();
        isAppliedActiveServerRuntimeAvailableSpy.mockReset();
    });

    it('returns active scope when serverId is missing', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });

        const context = await resolveServerScopedContext({
            machineId: 'machine-1',
        });

        expect(context).toEqual(expect.objectContaining({
            scope: 'active',
            machineId: 'machine-1',
            timeoutMs: 30000,
        }));
    });

    it('returns active scope when the target profile id aliases the active durable server identity', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'srv_server_a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([
            {
                id: 'localhost-52753',
                serverIdentityId: 'srv_server_a',
                serverUrl: 'https://server-a.example.test',
                name: 'Server A',
            },
        ]);
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: SECRET_A });

        const context = await resolveServerScopedContext({
            machineId: 'machine-1',
            serverId: 'localhost-52753',
        });

        expect(context).toEqual(expect.objectContaining({
            scope: 'active',
            machineId: 'machine-1',
            timeoutMs: 30000,
        }));
        expect(getCredentialsSpy).not.toHaveBeenCalled();
    });

    it('uses scoped credentials for the applied Home while its direct runtime is unavailable during a staged switch', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            generation: 2,
        });
        getAppliedActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        isAppliedActiveServerRuntimeAvailableSpy.mockReturnValue(false);
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-a', serverUrl: 'https://server-a.example.test', name: 'Server A' },
            { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
        ]);
        const tokenA = tokenForSub('account-a');
        const tokenB = tokenForSub('account-b');
        getCredentialsSpy.mockImplementation(async (_url: string, options: { serverId?: string }) => (
            options.serverId === 'server-a'
                ? { token: tokenA, secret: SECRET_A }
                : { token: tokenB, secret: SECRET_B }
        ));

        const [appliedContext, stagedContext] = await Promise.all([
            resolveServerScopedContext({ machineId: 'machine-a', serverId: 'server-a' }),
            resolveServerScopedContext({ machineId: 'machine-b', serverId: 'server-b' }),
        ]);

        expect(appliedContext).toEqual(expect.objectContaining({
            scope: 'scoped',
            machineId: 'machine-a',
            targetServerId: 'server-a',
            targetAccountId: 'account-a',
            token: tokenA,
        }));
        expect(stagedContext).toEqual(expect.objectContaining({
            scope: 'scoped',
            machineId: 'machine-b',
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            targetAccountId: 'account-b',
        }));
        expect(getCredentialsSpy).toHaveBeenCalledWith('https://server-b.example.test', { serverId: 'server-b' });
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
        const token = tokenForSub('account-b');
        const credentials = { token, secret: SECRET_B } as const;
        getCredentialsSpy.mockResolvedValue(credentials);

        const context = await resolveServerScopedContext({
            machineId: 'machine-1',
            serverId: 'server-b',
            timeoutMs: 5000,
        });

        expect(context).toEqual(expect.objectContaining({
            scope: 'scoped',
            machineId: 'machine-1',
            timeoutMs: 5000,
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            targetAccountId: 'account-b',
            token,
            credentials,
            encryption: expect.any(Encryption),
        }));
    });

    it('can force scoped context for the active server', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        const token = tokenForSub('account-a');
        getCredentialsSpy.mockResolvedValue({ token, secret: SECRET_A });

        const context = await resolveServerScopedContext({
            machineId: 'machine-1',
            forceScoped: true,
            timeoutMs: 5000,
        });

        expect(context).toEqual(expect.objectContaining({
            scope: 'scoped',
            machineId: 'machine-1',
            timeoutMs: 5000,
            targetServerId: 'server-a',
            targetServerUrl: 'https://server-a.example.test',
            targetAccountId: 'account-a',
            token,
            encryption: expect.any(Encryption),
        }));
    });

    it('fails closed when scoped credentials belong to a different Account than requested', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        getCredentialsSpy.mockResolvedValue({ token: tokenForSub('account-b'), secret: SECRET_B });

        await expect(resolveServerScopedContext({
            machineId: 'machine-1',
            serverId: 'server-a',
            accountId: 'account-a',
            forceScoped: true,
        })).rejects.toThrow('do not match requested Account');
    });
});
