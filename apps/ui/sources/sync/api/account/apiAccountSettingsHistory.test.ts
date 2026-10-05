import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import type { StorageState } from '@/sync/store/types';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import { fetchAccountSettingsHistory } from './apiAccountSettingsHistory';

const credentials: AuthCredentials = { token: 'token-a' };
const snapshots = [
    { version: 3, createdAt: '2026-08-29T10:00:00.000Z', contentKind: 'plain', byteLength: 128 },
    { version: 2, createdAt: '2026-08-28T10:00:00.000Z', contentKind: 'encrypted', byteLength: 256 },
];
let scope: { serverId: string; accountId: string };
const http = vi.fn<RuntimeFetch>();

async function activateHome(name: string) {
    const profile = await upsertAndActivateServer({ serverUrl: `https://home-${name}.example.test`, name });
    scope = { serverId: profile.id, accountId: `account-${name}` };
    // Minimal registered state fixture: the real lifetime owner reads profileScope only.
    registerStorageStateReader(() => ({ profileScope: scope }) as StorageState);
    return scope;
}

beforeEach(async () => {
    retireActiveServerAccountScopeLifetime();
    const initialScope = await activateHome('a');
    await TokenStorage.setCredentialsForServerUrl('https://home-a.example.test', { serverId: initialScope.serverId }, credentials);
    http.mockReset();
    http.mockImplementation(async () => Response.json({ snapshots }));
    setRuntimeFetch(http);
});
afterEach(() => {
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
});

describe('fetchAccountSettingsHistory', () => {
    it('lists plain and encrypted snapshot metadata using the admitted Account endpoint and bearer', async () => {
        await expect(fetchAccountSettingsHistory(credentials, { settingsScope: scope })).resolves.toEqual({ status: 'ready', snapshots });
        const historyRequest = http.mock.calls.find(([url]) => String(url).endsWith('/v2/account/settings/history'));
        expect(String(historyRequest?.[0])).toBe('https://home-a.example.test/v2/account/settings/history');
        expect(new Headers(historyRequest?.[1]?.headers).get('Authorization')).toBe('Bearer token-a');
    });

    it('rejects a retained A list intent after B becomes focused before any HTTP effect', async () => {
        const expectedScope = scope;
        await activateHome('b');
        await expect(fetchAccountSettingsHistory(credentials, { settingsScope: expectedScope })).resolves.toEqual({ status: 'unavailable' });
        expect(http).not.toHaveBeenCalled();
    });

    it('rejects retained A credentials when B settings render before the auth context catches up', async () => {
        const renderedScope = await activateHome('b');
        await TokenStorage.setCredentialsForServerUrl('https://home-b.example.test', { serverId: renderedScope.serverId }, { ...credentials, token: 'token-b' });
        await expect(fetchAccountSettingsHistory(credentials, { settingsScope: renderedScope })).resolves.toEqual({ status: 'unavailable' });
        expect(http).not.toHaveBeenCalled();
    });

    it('abandons admission if focus changes while endpoint credentials are being resolved', async () => {
        const pending = fetchAccountSettingsHistory(credentials, { settingsScope: scope });
        await activateHome('b');
        await expect(pending).resolves.toEqual({ status: 'unavailable' });
        expect(http).not.toHaveBeenCalled();
    });

    it('ignores delayed response decoding after a Home switch and keeps the admitted request on A', async () => {
        const expectedScope = scope;
        let finish!: (value: unknown) => void;
        let decoding = false;
        http.mockImplementation(async () => {
            const response = Response.json({ snapshots });
            response.json = () => { decoding = true; return new Promise((resolve) => { finish = resolve; }); };
            return response;
        });
        const pending = fetchAccountSettingsHistory(credentials, { settingsScope: expectedScope });
        await vi.waitFor(() => expect(decoding).toBe(true));
        await activateHome('b');
        finish({ snapshots });
        await expect(pending).resolves.toEqual({ status: 'unavailable' });
        expect(http.mock.calls.every(([url]) => new URL(String(url)).hostname === 'home-a.example.test')).toBe(true);
    });

    it('aborts HTTP when the Account lifetime retires and ignores an abort-insensitive response', async () => {
        let finish!: (response: Response) => void;
        http.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
        const pending = fetchAccountSettingsHistory(credentials, { settingsScope: scope });
        await vi.waitFor(() => expect(http).toHaveBeenCalled());
        retireActiveServerAccountScopeLifetime();
        expect(http.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        finish(Response.json({ snapshots }));
        await expect(pending).resolves.toEqual({ status: 'unavailable' });
    });

    it('reports unavailable transport and malformed listings without throwing', async () => {
        http.mockResolvedValueOnce(Response.json({}, { status: 500 }));
        await expect(fetchAccountSettingsHistory(credentials, { settingsScope: scope })).resolves.toEqual({ status: 'unavailable' });
        http.mockResolvedValueOnce(Response.json({ snapshots: [{ version: 'x' }] }));
        await expect(fetchAccountSettingsHistory(credentials, { settingsScope: scope })).resolves.toEqual({ status: 'unavailable' });
    });
});
