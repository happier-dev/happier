import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IModal } from '@/modal';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { initializeTerminalRouteRuntimeForTests } from '../terminal/terminalRouteTestHelpers';

const prompt = vi.hoisted(() => vi.fn<IModal['prompt']>(async () => 'DELETE'));
installTokenStorageWebPlatformMocks();
installApprovalCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { prompt } }).module,
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ navigation: { setOptions: vi.fn() } }).module,
});
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: { isModernBarcodeScannerAvailable: false, onModernBarcodeScanned: () => ({ remove() {} }), launchScanner() {}, async dismissScanner() {} },
}));
await initializeTerminalRouteRuntimeForTests();

describe('Account erasure original confirmation target', () => {
    let restoreStorage: (() => void) | undefined;
    let restoreLocks: (() => void) | undefined;
    afterEach(async () => {
        await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
        (await import('@/utils/system/runtimeFetch')).resetRuntimeFetch();
        prompt.mockReset(); vi.restoreAllMocks(); restoreLocks?.(); restoreStorage?.(); vi.unstubAllGlobals();
    });

    it('retains both Home credentials when focus changes inside the DELETE prompt', async () => {
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        vi.stubGlobal('window', { location: { origin: 'https://origin.example.test' } });
        vi.stubGlobal('document', {});
        const erasures: Array<{ home: string; authorization: string | null }> = [];
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (!['https://prompt-a.example.test', 'https://prompt-b.example.test'].includes(url.origin)) throw new Error(`Unexpected Home: ${url.origin}`);
            if (url.pathname === '/v1/auth/account/delete') {
                erasures.push({ home: url.origin, authorization: new Headers(init?.headers).get('Authorization') });
                return Response.json({ error: 'account_delete_failed' }, { status: 403 });
            }
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
                encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } },
            } }));
            return new Response('{}', { status: 404 });
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        profiles.resetServerProfilesRuntimeForTests();
        const homeA = await profiles.upsertServerProfile({ serverUrl: 'https://prompt-a.example.test', name: 'Prompt A' });
        const homeB = await profiles.upsertServerProfile({ serverUrl: 'https://prompt-b.example.test', name: 'Prompt B' });
        const original = { token: createAccountTokenForTests('account-a', { currentAccount: true }) };
        const other = { token: createAccountTokenForTests('account-b', { currentAccount: true }) };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id }, original)).resolves.toBe(true);
        await expect(TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, other)).resolves.toBe(true);
        await profiles.setActiveServerId(homeA.id, { scope: 'device' });
        const connection = await import('@/sync/runtime/orchestration/connectionManager');
        await connection.switchConnectionToActiveServer();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().activateProfileScope({ serverId: profiles.resolveServerProfileScopeIdForIdentifier(homeA.id), accountId: 'account-a' });
        const { AuthProvider, getCurrentAuth } = await import('@/auth/context/AuthContext');
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AuthProvider initialCredentials={original}><AccountScreen /></AuthProvider>);
        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected the real original Home Auth provider');
            expect(auth.credentials).toEqual(original);
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            expect(captureActiveServerAccountScopeLifetime()?.scope.accountId).toBe('account-a');
            prompt.mockImplementationOnce(async () => {
                await profiles.setActiveServerId(homeB.id, { scope: 'device' });
                await auth.refreshFromActiveServer();
                storage.getState().activateProfileScope({ serverId: profiles.resolveServerProfileScopeIdForIdentifier(homeB.id), accountId: 'account-b' });
                return 'DELETE';
            });
            await act(async () => { await screen.pressByTestIdAsync('settings-account-delete'); });
            expect(prompt).toHaveBeenCalledOnce();
            expect(getCurrentAuth()?.credentials).toEqual(other);
            expect(erasures).toEqual([]);
            expect(await TokenStorage.getCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id })).toEqual(original);
            expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).toEqual(other);
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: other });
        } finally { await screen.unmount(); }
    });
});
