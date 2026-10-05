import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
    accountMode: 'plain' as 'plain' | 'e2ee',
    credentials: { token: 'token-a' },
    encryption: { marker: 'exact-home-encryption' },
    createEncryption: vi.fn(),
    fetchMode: vi.fn(),
    stagedSnapshot: {
        serverId: 'home-a',
        serverUrl: 'https://home-a.example.test',
        generation: 1,
    },
    appliedSnapshot: {
        serverId: 'home-a',
        serverUrl: 'https://home-a.example.test',
        generation: 1,
    },
    appliedRuntimeAvailable: true,
    mountedProfileScope: null as null | { serverId: string; accountId: string },
    profiles: new Map<string, {
        id: string;
        serverUrl: string;
        serverIdentityId: string;
    }>(),
    serverFetch: vi.fn(),
    endpointFetch: vi.fn(),
    createServerFetchAtEndpoint: vi.fn(),
    resolveServerScopedTransport: vi.fn(),
    releaseTransport: vi.fn(),
    homeCarrier: { endpointId: 'action-home-carrier' },
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => boundary.credentials),
    },
    subscribeHomeCredentialMutations: vi.fn(() => () => undefined),
}));
vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: (...args: unknown[]) => boundary.createEncryption(...args),
}));
vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/api/account/apiAccountEncryptionMode')>(),
    fetchAccountEncryptionMode: (...args: unknown[]) => boundary.fetchMode(...args),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: vi.fn(() => boundary.stagedSnapshot),
}));
vi.mock('@/sync/domains/state/storageStateReaderBridge', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/state/storageStateReaderBridge')>(),
    readRegisteredStorageState: () => boundary.mountedProfileScope
        ? { profileScope: boundary.mountedProfileScope }
        : null,
}));
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    areServerProfileIdentifiersEquivalent: vi.fn((left: unknown, right: unknown) => left === right),
    getServerProfileById: vi.fn((serverId: string) => boundary.profiles.get(serverId)),
    resolveServerProfileScopeIdForIdentifier: vi.fn((serverId: string) => serverId),
}));
vi.mock('@/sync/domains/settings/scope/accountSettingsScope', () => ({
    areAccountSettingsScopesEqual: vi.fn(() => true),
}));
vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            settingsScope: { serverId: 'home-a', accountId: 'account-a' },
            settings: { schemaVersion: 2 },
        }),
    },
}));
vi.mock('@/sync/domains/state/accountSettingsPersistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/state/accountSettingsPersistence')>(),
    loadAccountSettings: vi.fn(() => ({ settings: {}, version: null })),
}));
vi.mock('@/sync/engine/settings/accountSettingsBaseline', () => ({
    readAccountSettingsBaseline: vi.fn(async () => ({ raw: {} })),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport', () => ({
    resolveServerScopedTransport: (...args: unknown[]) => boundary.resolveServerScopedTransport(...args),
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => boundary.appliedSnapshot,
    isAppliedActiveServerRuntimeAvailable: () => boundary.appliedRuntimeAvailable,
}));
vi.mock('@/sync/http/client', () => ({
    serverFetch: (...args: unknown[]) => boundary.serverFetch(...args),
    createServerFetchAtEndpoint: (...args: unknown[]) => boundary.createServerFetchAtEndpoint(...args),
}));
vi.mock('@/utils/auth/parseToken', () => ({
    parseToken: vi.fn(() => 'account-a'),
}));

import { captureActionAccountContext, captureLazyActionAccountContext } from './actionAccountContext';
import {
    captureActiveServerAccountScopeLifetime,
    retireActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

beforeEach(() => {
    retireActiveServerAccountScopeLifetime();
    boundary.accountMode = 'plain';
    boundary.fetchMode.mockReset();
    boundary.fetchMode.mockImplementation(async () => ({ mode: boundary.accountMode, updatedAt: 1 }));
    boundary.createEncryption.mockReset();
    boundary.createEncryption.mockResolvedValue(boundary.encryption);
    boundary.stagedSnapshot = {
        serverId: 'home-a',
        serverUrl: 'https://home-a.example.test',
        generation: 1,
    };
    boundary.appliedSnapshot = { ...boundary.stagedSnapshot };
    boundary.appliedRuntimeAvailable = true;
    boundary.mountedProfileScope = { serverId: 'home-a', accountId: 'account-a' };
    boundary.profiles.clear();
    boundary.profiles.set('home-a', {
        id: 'home-a',
        serverUrl: 'https://home-a.example.test',
        serverIdentityId: 'home-identity-a',
    });
    boundary.serverFetch.mockReset();
    boundary.serverFetch.mockResolvedValue(new Response(null, { status: 204 }));
    boundary.endpointFetch.mockReset();
    boundary.endpointFetch.mockResolvedValue(new Response(null, { status: 204 }));
    boundary.createServerFetchAtEndpoint.mockReset();
    boundary.createServerFetchAtEndpoint.mockReturnValue(boundary.endpointFetch);
    boundary.releaseTransport.mockReset();
    boundary.releaseTransport.mockResolvedValue(undefined);
    boundary.resolveServerScopedTransport.mockReset();
    boundary.resolveServerScopedTransport.mockImplementation(async ({ profile }: {
        profile: { serverUrl: string };
    }) => ({
        canonicalServerUrl: profile.serverUrl,
        runtimeOrigin: profile.serverUrl,
        homeCarrier: boundary.homeCarrier,
        release: boundary.releaseTransport,
    }));
});

describe('captureActionAccountContext encryption authority', () => {
    it('exposes no fabricated encryption material for a Plain Account', async () => {
        const context = await captureActionAccountContext('home-a');
        try {
            expect(context.encryption).toBeNull();
            expect(boundary.createEncryption).not.toHaveBeenCalled();
        } finally {
            context.dispose();
        }
    });

    it('exposes the exact encryption instance resolved for the captured E2EE Home', async () => {
        boundary.accountMode = 'e2ee';

        const context = await captureActionAccountContext('home-a');
        try {
            expect(context.encryption).toBe(boundary.encryption);
            expect(boundary.createEncryption).toHaveBeenCalledWith(boundary.credentials);
        } finally {
            context.dispose();
        }
    });
});

describe('captureLazyActionAccountContext encryption on demand', () => {
    it('returns committed self-revocation without opening the now-inaccessible Artifact', async () => {
        const revoked = { artifactId: 'artifact', ownerAccountId: 'owner', access: null, grants: [], changed: true };
        boundary.endpointFetch.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === 'DELETE'
            ? new Response(JSON.stringify(revoked), { status: 200 })
            : new Response(JSON.stringify({ error: 'Artifact not found' }), { status: 404 }));
        const context = await captureLazyActionAccountContext('home-a');
        try {
            await expect(context.artifactAccessGrants.remove({ artifactId: 'artifact',
                principal: { kind: 'account', accountId: 'account-a' } })).resolves.toEqual(revoked);
            expect(boundary.endpointFetch).toHaveBeenCalledTimes(1);
            expect(boundary.fetchMode).not.toHaveBeenCalled();
        } finally {
            context.dispose();
        }
    });

    it('binds the Home and Account without reading the encryption mode or deriving keys', async () => {
        boundary.accountMode = 'e2ee';
        const context = await captureLazyActionAccountContext('home-a');
        try {
            expect(context.accountId).toBe('account-a');
            expect(boundary.fetchMode).not.toHaveBeenCalled();
            expect(boundary.createEncryption).not.toHaveBeenCalled();

            const first = await context.resolveAccountEncryption();
            const second = await context.resolveAccountEncryption();
            expect(first).toEqual({ accountMode: 'e2ee', encryption: boundary.encryption });
            expect(second).toBe(first);
            expect(boundary.fetchMode).toHaveBeenCalledTimes(1);
        } finally {
            context.dispose();
        }
    });

    it('fails a mode-dependent operation closed when the Account encryption mode cannot be read', async () => {
        boundary.fetchMode.mockRejectedValue(new Error('encryption_mode_unavailable'));
        const context = await captureLazyActionAccountContext('home-a');
        try {
            await expect(context.resolveAccountEncryption()).rejects.toThrow('encryption_mode_unavailable');
            await expect(context.fetchArtifact('artifact-a')).rejects.toThrow('encryption_mode_unavailable');
            // Nothing was read under a guessed mode.
            expect(boundary.endpointFetch).not.toHaveBeenCalled();
            expect(boundary.createEncryption).not.toHaveBeenCalled();
        } finally {
            context.dispose();
        }
    });
});

describe('captureActionAccountContext transport authority', () => {
    it.each(['response', 'release'] as const)('preserves a mutation acknowledgement when retirement arrives during %s', async retirement => {
        const response = new Response(JSON.stringify({ committed: true }), { status: 200 });
        if (retirement === 'response') boundary.endpointFetch.mockImplementation(async () => {
            retireActiveServerAccountScopeLifetime();
            return response;
        });
        else {
            boundary.endpointFetch.mockResolvedValue(response);
            boundary.releaseTransport.mockImplementation(async () => { retireActiveServerAccountScopeLifetime(); });
        }
        const context = await captureLazyActionAccountContext('home-a');
        try {
            await expect(context.request('/v1/artifacts', { method: 'POST', body: '{}' })).resolves.toBe(response);
            expect(context.accountLifetime.isCurrent()).toBe(false);
            await expect(context.request('/v1/artifacts', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        } finally { context.dispose(); }
    });

    it('does not return read content when its Account retires while awaiting the response', async () => {
        boundary.endpointFetch.mockImplementation(async () => {
            retireActiveServerAccountScopeLifetime();
            return new Response(JSON.stringify({ private: true }), { status: 200 });
        });
        const context = await captureLazyActionAccountContext('home-a');
        try {
            await expect(context.request('/v1/artifacts')).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        } finally { context.dispose(); }
    });

    it('does not retire the mounted Home lifetime while the next Home is only staged', async () => {
        const mountedA = captureActiveServerAccountScopeLifetime();
        expect(mountedA?.isCurrent()).toBe(true);

        boundary.stagedSnapshot = {
            serverId: 'home-b',
            serverUrl: 'https://home-b.example.test',
            generation: 2,
        };
        boundary.profiles.set('home-b', {
            id: 'home-b',
            serverUrl: 'https://home-b.example.test',
            serverIdentityId: 'home-identity-b',
        });

        const [stagedB, appliedA] = await Promise.all([
            captureActionAccountContext('home-b'),
            captureActionAccountContext('home-a'),
        ]);
        try {
            // The applied connection and mounted Account are still A. Neither
            // action may ask the active-lifetime owner to reinterpret staged B.
            // Restoring the staged view must reuse the original A lifetime,
            // proving it was not retired by the B Action capture.
            boundary.stagedSnapshot = {
                serverId: 'home-a',
                serverUrl: 'https://home-a.example.test',
                generation: 1,
            };
            expect(captureActiveServerAccountScopeLifetime()).toBe(mountedA);

            boundary.stagedSnapshot = {
                serverId: 'home-b',
                serverUrl: 'https://home-b.example.test',
                generation: 2,
            };
            boundary.appliedSnapshot = { ...boundary.stagedSnapshot };
            boundary.mountedProfileScope = { serverId: 'home-b', accountId: 'account-a' };
            const establishedB = await captureActionAccountContext('home-b');
            try {
                boundary.stagedSnapshot = {
                    serverId: 'home-a',
                    serverUrl: 'https://home-a.example.test',
                    generation: 3,
                };
                establishedB.assertCurrent();
                boundary.appliedRuntimeAvailable = false;
                let error: unknown;
                try {
                    establishedB.assertCurrent();
                } catch (caught) {
                    error = caught;
                }
                expect(error).toMatchObject({ code: 'action_account_scope_changed' });
            } finally {
                establishedB.dispose();
            }
        } finally {
            stagedB.dispose();
            appliedA.dispose();
        }
    });

    it('keeps applied, staged, and background Homes on their scoped target transport during a focus switch', async () => {
        boundary.stagedSnapshot = {
            serverId: 'home-b',
            serverUrl: 'https://home-b.example.test',
            generation: 2,
        };
        boundary.profiles.set('home-b', {
            id: 'home-b',
            serverUrl: 'https://home-b.example.test',
            serverIdentityId: 'home-identity-b',
        });
        boundary.profiles.set('home-c', {
            id: 'home-c',
            serverUrl: 'https://home-c.example.test',
            serverIdentityId: 'home-identity-c',
        });

        // A remains the connection-owned Home while profile selection has staged B.
        const [applied, staged, background] = await Promise.all([
            captureActionAccountContext('home-a'),
            captureActionAccountContext('home-b'),
            captureActionAccountContext('home-c'),
        ]);
        try {
            await Promise.all([
                applied.request('/action-applied'),
                staged.request('/action-staged'),
                background.request('/action-background'),
            ]);

            expect(boundary.serverFetch).not.toHaveBeenCalled();
            expect(boundary.resolveServerScopedTransport).toHaveBeenCalledTimes(3);
            expect(boundary.resolveServerScopedTransport.mock.calls.map(([{ profile }]) => profile.id))
                .toEqual(['home-a', 'home-b', 'home-c']);
            expect(boundary.createServerFetchAtEndpoint.mock.calls.map(([params]) => params.serverId))
                .toEqual(['home-a', 'home-b', 'home-c']);
            expect(boundary.createServerFetchAtEndpoint.mock.calls.map(([params]) => params.homeCarrier))
                .toEqual([boundary.homeCarrier, boundary.homeCarrier, boundary.homeCarrier]);
            expect(boundary.endpointFetch.mock.calls.map(([path]) => path))
                .toEqual(['/action-applied', '/action-staged', '/action-background']);
            expect(boundary.releaseTransport).toHaveBeenCalledTimes(3);
        } finally {
            applied.dispose();
            staged.dispose();
            background.dispose();
        }
    });
});
