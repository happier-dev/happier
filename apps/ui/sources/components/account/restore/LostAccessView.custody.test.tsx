import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS, TokenStorage, type PendingExternalAuth } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { Modal } from '@/modal';
import { initializeTerminalRouteRuntimeForTests } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { guardAccountEncryptionFirstKeyCredentialMutation } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { LostAccessView } from './LostAccessView';

installTokenStorageWebPlatformMocks();
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    confirmResult: true,
    // The person closes the recovery prompt without abandoning custody.
    spies: { show: config => { config.onRequestClose?.(); return 'modal-id'; } },
}).module);

await initializeTerminalRouteRuntimeForTests();
let localStorage: ReturnType<typeof installLocalStorageMock>;
let locks: ReturnType<typeof installWebLockManagerMock>;
beforeEach(() => {
    localStorage = installLocalStorageMock();
    locks = installWebLockManagerMock();
    resetServerFeaturesClientForTests();
});
afterEach(async () => {
    await standardCleanup();
    resetServerFeaturesClientForTests();
    locks.restore();
    localStorage.restore();
    vi.clearAllMocks();
});

describe('LostAccessView custody', () => {
    it('does not treat the generic lost-access warning as authority to replace marked custody', async () => {
        const features = createRootLayoutFeaturesResponse({
            features: { auth: { recovery: { providerReset: { enabled: true } } } },
            capabilities: { auth: { recovery: { providerReset: { providers: ['github'] } } } },
        });
        const authRequests: string[] = [];
        setRuntimeFetch(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') return Response.json(features);
            if (url.pathname.includes('/auth/')) authRequests.push(url.href);
            return new Response('{}', { status: 404 });
        });
        const home = await upsertAndActivateServer({ serverUrl: 'https://relay.example.test', source: 'manual', scope: 'device' });
        expect((await getServerFeaturesSnapshot({ serverId: home.id, force: true })).status).toBe('ready');
        const capturedHome = getActiveServerSnapshot();
        const createdAt = Date.now();
        const pending = {
            provider: 'github', proof: 'retained-proof', secret: 'retained-secret',
            serverId: capturedHome.serverId, serverUrl: capturedHome.serverUrl,
            returnTo: '/settings/account',
            accountEncryptionFirstKey: {
                accountId: 'account-1', requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}', createdAt,
                expiresAt: createdAt + ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS,
                pending: 'retained-first-key', migrationSubmissionAttempted: true,
            },
        } satisfies PendingExternalAuth;
        expect(await TokenStorage.setPendingExternalAuth(pending)).toBe(true);
        expect((await guardAccountEncryptionFirstKeyCredentialMutation()).kind).toBe('finish_encryption_setup');

        const screen = await renderScreen(<LostAccessView onBack={() => {}} returnTo="/restore" />);
        await vi.waitFor(() => expect(screen.findByTestId('lost-access-provider-github')).not.toBeNull());
        await screen.pressByTestIdAsync('lost-access-provider-github');

        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(Modal.show).toHaveBeenCalledOnce();
        expect(await TokenStorage.readPendingExternalAuthState()).toEqual({ value: pending, serverMismatch: false });
        expect((await guardAccountEncryptionFirstKeyCredentialMutation()).kind).toBe('finish_encryption_setup');
        expect(getActiveServerSnapshot()).toEqual(capturedHome);
        expect(authRequests).toEqual([]);
    });
});
