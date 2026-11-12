import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getStorage } from '@/sync/domains/state/storage';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import { fetchArtifacts } from '@/sync/api/artifacts/apiArtifacts';
import { AccountEncryptionMigrateRequestSchema, migrateAccountEncryptionMode } from './apiAccountEncryptionMigrate';
import { captureAccountSettingsRequest } from './accountSettingsRequest';

installDisconnectedServerSocketBoundary();

function accountToken(accountId: string): string {
    return `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
}
const credentials = { token: accountToken('account-home-a') };
const migration = AccountEncryptionMigrateRequestSchema.parse({
    toMode: 'plain', expectedAccountVersion: 3,
    expectedSigningKeyFingerprint: 'aemk1_signing', expectedContentKeyFingerprint: 'aemk1_content',
    expectedSettingsVersion: 0, settingsContent: { t: 'plain', v: { migrationPrivateValue: 'only-home-a' } },
    connectedServices: { action: 'assert_empty' }, automations: { action: 'assert_empty' },
    machines: { action: 'assert_empty' }, todos: { action: 'assert_empty' },
    artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' },
    reviewComments: { action: 'assert_empty' }, sessionOrganization: { action: 'assert_empty' },
    pets: { action: 'assert_empty' },
});
const success = { success: true, mode: 'plain', accountVersion: 4, settingsVersion: 1 };
const http = vi.fn<RuntimeFetch>();
let sequence = 0;

async function activateHome(name: string) {
    // Apply through the connection owner, not just the selected-profile projection.
    await disconnectActiveServerConnection();
    const serverUrl = `https://${name}-${sequence}.example.test`;
    const profile = await upsertAndActivateServer({ serverUrl, name });
    const scope = { serverId: profile.id, accountId: `account-${name}` };
    const homeCredentials = name === 'home-a' ? credentials : { token: accountToken(scope.accountId) };
    await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: profile.id }, homeCredentials);
    await restoreConnectionToActiveServer(homeCredentials);
    getStorage().setState({ profileScope: scope, settingsScope: scope });
    return { target: { serverUrl, serverId: profile.id }, scope };
}

beforeEach(async () => {
    sequence += 1;
    await loadSyncSingletonForTests();
    retireActiveServerAccountScopeLifetime();
    http.mockReset();
    // Bootstrap and transport are genuine network boundaries; Account scope,
    // credential storage, connection application and migration logic run for real.
    setRuntimeFetch(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 3,
            settingsVersion: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/migrate' || path === '/v1/artifacts' || path === '/v1/artifacts/read') {
            return await http(url, init) ?? Response.json({ error: 'not_found' }, { status: 404 });
        }
        return Response.json({ error: 'not_found' }, { status: 404 });
    });
});
afterEach(async () => {
    await disconnectActiveServerConnection();
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
});

describe('Account encryption migration Home binding', () => {
    it('replaces only the initiating Home credential after a committed migration, not a new Account on that Home', async () => {
        const homeA = await activateHome('home-a');
        await activateHome('home-b');
        await expect(TokenStorage.setCredentialsForServerUrl(
            homeA.target.serverUrl, { serverId: homeA.target.serverId, expectedCredentials: credentials }, { token: credentials.token, secret: 'new-key' },
        )).resolves.toBe(true);
        const replacement = { token: 'new-account-on-home-a' };
        await TokenStorage.setCredentialsForServerUrl(homeA.target.serverUrl, { serverId: homeA.target.serverId }, replacement);
        await expect(TokenStorage.setCredentialsForServerUrl(
            homeA.target.serverUrl, { serverId: homeA.target.serverId, expectedCredentials: credentials }, { token: credentials.token },
        )).resolves.toBe(false);
        await expect(TokenStorage.getCredentialsForServerUrl(homeA.target.serverUrl, { serverId: homeA.target.serverId })).resolves.toEqual(replacement);
    });

    it('keeps the plaintext mutation on the captured Home while the active Home changes', async () => {
        const homeA = await activateHome('home-a');
        let finishMutation!: (response: Response) => void;
        http.mockImplementation(async () => new Promise<Response>((resolve) => { finishMutation = resolve; }));
        const pending = migrateAccountEncryptionMode(credentials, migration, { target: homeA.target, retry: 'none' });
        await vi.waitFor(() => expect(finishMutation).toBeTypeOf('function'));
        await activateHome('home-b');
        finishMutation(Response.json(success));
        await expect(pending).resolves.toEqual(success);

        const mutations = http.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/encryption/migrate'));
        expect(mutations).toHaveLength(1);
        expect(String(mutations[0]![0])).toBe(`${homeA.target.serverUrl}/v1/account/encryption/migrate`);
        expect(new Headers(mutations[0]![1]?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
        expect(JSON.parse(String(mutations[0]![1]?.body))).toEqual(migration);
        expect(http.mock.calls.every(([url]) => String(url).startsWith(homeA.target.serverUrl))).toBe(true);
    });

    it('rejects a captured settings intent retired during preparation before any migration mutation', async () => {
        const homeA = await activateHome('home-a');
        const captured = await captureAccountSettingsRequest({ credentials, settingsScope: homeA.scope });
        expect(captured).not.toBeNull();
        http.mockImplementation(async () => Response.json(createRootLayoutFeaturesResponse()));
        await activateHome('home-b');
        try {
            await expect(migrateAccountEncryptionMode(credentials, migration, {
                target: homeA.target, request: captured!.request, retry: 'none',
            })).rejects.toThrow();
            expect(http.mock.calls.some(([url]) => String(url).endsWith('/v1/account/encryption/migrate'))).toBe(false);
            expect(http.mock.calls.every(([url]) => String(url).startsWith(homeA.target.serverUrl))).toBe(true);
        } finally {
            captured!.dispose();
        }
    });

    it('retires preparation when the initiating Home credentials change before the Account projection catches up', async () => {
        const homeA = await activateHome('home-a');
        const captured = await captureAccountSettingsRequest({ credentials, settingsScope: homeA.scope });
        expect(captured).not.toBeNull();
        http.mockImplementation(async () => Response.json(success));
        try {
            await TokenStorage.setCredentialsForServerUrl(homeA.target.serverUrl, { serverId: homeA.target.serverId }, {
                token: credentials.token, secret: 'replacement-account-material',
            });
            expect(captured!.isCurrent()).toBe(false);
            await expect(captured!.request('/v1/account/encryption/migrate', {
                method: 'POST', body: JSON.stringify(migration),
            })).rejects.toThrow();
            expect(http).not.toHaveBeenCalled();
        } finally {
            captured!.dispose();
        }
    });

    it('does not send an inventory bearer to the newly selected Home after preparation retires', async () => {
        const homeA = await activateHome('home-a');
        const captured = await captureAccountSettingsRequest({ credentials, settingsScope: homeA.scope });
        expect(captured).not.toBeNull();
        http.mockImplementation(async () => Response.json([]));
        await activateHome('home-b');
        try {
            await expect(fetchArtifacts(credentials, { request: captured!.request, retry: 'none' })).rejects.toThrow();
            expect(http).not.toHaveBeenCalled();
        } finally {
            captured!.dispose();
        }
    });

    it.each(['GET', 'POST'] as const)('cancels an admitted %s content read when the Account lifetime retires', async method => {
        const homeA = await activateHome('home-a');
        const captured = await captureAccountSettingsRequest({ credentials, settingsScope: homeA.scope });
        expect(captured).not.toBeNull();
        let finishResponse!: () => void;
        http.mockImplementation(async (_url, init) => await new Promise<Response>((resolve, reject) => {
            const abort = () => reject(init?.signal?.reason);
            init?.signal?.addEventListener('abort', abort, { once: true });
            finishResponse = () => {
                init?.signal?.removeEventListener('abort', abort);
                resolve(Response.json({ privateContent: 'account-a' }));
            };
        }));
        try {
            const settled = captured!.request(method === 'GET' ? '/v1/artifacts' : '/v1/artifacts/read', { method })
                .then(response => ({ status: 'disclosed', response }), error => ({ status: 'refused', error }));
            await vi.waitFor(() => expect(finishResponse).toBeTypeOf('function'));
            retireActiveServerAccountScopeLifetime();
            finishResponse();
            expect(await settled).toMatchObject({ status: 'refused' });
        } finally { captured!.dispose(); }
    });

    it.each(['headers', 'body'] as const)('preserves a committed mutation acknowledgement when the Home changes before receiving its %s', async stage => {
        const homeA = await activateHome('home-a');
        const captured = await captureAccountSettingsRequest({ credentials, settingsScope: homeA.scope });
        expect(captured).not.toBeNull();
        let finishResponse!: () => void;
        http.mockImplementation(async (url, init) => {
            if (new URL(String(url)).pathname === '/v1/artifacts') return Response.json([]);
            const response = Response.json(success);
            const receive = () => new Promise<void>((resolve, reject) => {
                const abort = () => reject(init?.signal?.reason);
                init?.signal?.addEventListener('abort', abort, { once: true });
                finishResponse = () => { init?.signal?.removeEventListener('abort', abort); resolve(); };
            });
            if (stage === 'headers') await receive();
            else response.json = async () => { await receive(); return success; };
            return response;
        });
        try {
            const pending = migrateAccountEncryptionMode(credentials, migration, {
                target: homeA.target, request: captured!.request, retry: 'none',
            });
            const settled = pending.then(value => ({ status: 'completed', value }), error => ({ status: 'failed', error }));
            await vi.waitFor(() => expect(finishResponse).toBeTypeOf('function'));
            await activateHome('home-b');
            finishResponse();
            await expect(settled).resolves.toEqual({ status: 'completed', value: success });
            expect(captured!.isCurrent()).toBe(false);
            const mutations = http.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/account/encryption/migrate');
            expect(mutations).toHaveLength(1);
            expect(String(mutations[0]![0])).toBe(`${homeA.target.serverUrl}/v1/account/encryption/migrate`);
            expect(new Headers(mutations[0]![1]?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
            expect(JSON.parse(String(mutations[0]![1]?.body))).toEqual(migration);
        } finally {
            captured!.dispose();
        }
    });
});
