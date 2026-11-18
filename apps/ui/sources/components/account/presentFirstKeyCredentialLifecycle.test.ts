import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { Platform } from 'react-native';
import { AuthProvider } from '@/auth/context/AuthContext';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks, installTokenStorageTestIsolation } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createAccountEncryptionFirstKeyFixture } from '@/dev/testkit/fixtures/accountEncryptionFirstKey';
import { createAccountEncryptionMigrateRequestBindingDigestV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { guardAccountEncryptionFirstKeyCredentialMutation } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { presentFirstKeyCredentialLifecycle } from './presentFirstKeyCredentialLifecycle';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('present-first-key-lifecycle');
const mocks = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: mocks.show } }).module);

type ShownConfig = Readonly<{
    props: Readonly<{
        finish: () => Promise<Readonly<{ kind: 'completed' | 'recovery_failed' }>>;
        abandon: () => Promise<Readonly<{ kind: 'completed' | 'recovery_failed' }>>;
        onSettled: (outcome: 'finish' | 'abandon' | 'keep') => void;
    }>;
    onRequestClose: () => void;
    onHostUnmount: () => void;
}>;
function shownConfig(): ShownConfig {
    const config = mocks.show.mock.calls.at(-1)?.[0];
    if (!config) throw new Error('Expected recovery modal');
    return config as ShownConfig;
}

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let storage: LocalStorageMockHandle;
let target: { serverId: string; serverUrl: string };

async function retainRecovery(options: Readonly<{ omitServerId?: boolean }> = {}) {
    const fixture = await createAccountEncryptionFirstKeyFixture();
    expect(await TokenStorage.setPendingExternalAuth({
        provider: 'github', proof: 'pending-proof', secret: fixture.proposedCredentials.secret, ...target,
        returnTo: '/settings/account', accountEncryptionFirstKey: {
            accountId: fixture.accountId,
            requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({ request: fixture.request,
                accountId: fixture.accountId, sourceMode: 'plain' }),
            requestJson: JSON.stringify(fixture.request), createdAt: Date.now() - 60_000,
            expiresAt: Date.now() - 1, pending: 'pending-first-key', migrationSubmissionAttempted: true,
        },
    }, target)).toBe(true);
    const result = await guardAccountEncryptionFirstKeyCredentialMutation(options.omitServerId
        ? { serverUrl: target.serverUrl } : target);
    if (result.kind !== 'finish_encryption_setup') throw new Error('Expected retained first-key custody');
    return { result, fixture };
}

async function pending() {
    return (await TokenStorage.readPendingExternalAuthStateForServerUrl(target.serverUrl, { serverId: target.serverId })).value;
}

describe('presentFirstKeyCredentialLifecycle', () => {
    beforeEach(async () => {
        Platform.OS = 'web';
        storage = installLocalStorageMock();
        vi.clearAllMocks();
        const profile = await adoptHomeProfile({
            descriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://server-b.example.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://server-b.example.test' }] }),
            source: 'account-directory', descriptorAuthority: 'current_connection_observation',
        });
        target = { serverId: profile.id, serverUrl: profile.serverUrl };
        // External network failure is observable through the real retry/recovery owner.
        setRuntimeFetch(async () => { throw new TypeError('Network unavailable'); });
        screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: null,
            children: React.createElement(React.Fragment),
        }));
    });
    afterEach(async () => {
        await screen?.unmount();
        screen = undefined;
        resetRuntimeFetch();
        storage.restore();
    });

    it('settles a safe host unmount while retaining the exact pending custody', async () => {
        const { result } = await retainRecovery();
        const retained = await pending();
        const afterAbandon = vi.fn();
        const presented = presentFirstKeyCredentialLifecycle({ run: async () => result, afterAbandon });
        await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
        shownConfig().onHostUnmount();
        await presented;
        expect(await pending()).toEqual(retained);
        expect(afterAbandon).not.toHaveBeenCalled();
    });

    it('presents completion only after successful finish recovery and modal settlement', async () => {
        const { result } = await retainRecovery();
        const finish = vi.fn(async () => ({ kind: 'completed' as const }));
        const onFinishCompleted = vi.fn();
        const presented = presentFirstKeyCredentialLifecycle({ run: async () => result, finish, onFinishCompleted });
        await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
        const config = shownConfig();
        await expect(config.props.finish()).resolves.toEqual({ kind: 'completed' });
        expect(onFinishCompleted).not.toHaveBeenCalled();
        config.props.onSettled('finish');
        await presented;
        expect(onFinishCompleted).toHaveBeenCalledTimes(1);
    });

    it('keeps modal recovery and custody when the exact Home cannot be reached', async () => {
        const { result, fixture } = await retainRecovery();
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.serverId }, fixture.proposedCredentials);
        const retained = await pending();
        const presented = presentFirstKeyCredentialLifecycle({ run: async () => result });
        await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
        await expect(shownConfig().props.finish()).resolves.toEqual({ kind: 'recovery_failed' });
        expect(await pending()).toEqual(retained);
        shownConfig().onRequestClose();
        await presented;
    });

    it('fails default Finish safely when the recovery owner retained no exact Home id', async () => {
        const { result } = await retainRecovery({ omitServerId: true });
        const presented = presentFirstKeyCredentialLifecycle({ run: async () => result });
        await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
        await expect(shownConfig().props.finish()).resolves.toEqual({ kind: 'recovery_failed' });
        expect(await pending()).not.toBeNull();
        shownConfig().onRequestClose();
        await presented;
    });

    it('fails default Finish safely when no credential is stored for the retained Home', async () => {
        const { result } = await retainRecovery();
        const presented = presentFirstKeyCredentialLifecycle({ run: async () => result });
        await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
        await expect(shownConfig().props.finish()).resolves.toEqual({ kind: 'recovery_failed' });
        expect(await TokenStorage.getCredentialsForServerUrl(target.serverUrl, { serverId: target.serverId })).toBeNull();
        expect(await pending()).not.toBeNull();
        shownConfig().onRequestClose();
        await presented;
    });

    it('retries abandonment and the requested mutation without removing custody twice', async () => {
        const beforeCustodyKeys = new Set(storage.store.keys());
        const { result } = await retainRecovery();
        const custodyKeys = new Set([...storage.store.keys()].filter((key) => !beforeCustodyKeys.has(key)));
        expect(custodyKeys.size).toBeGreaterThan(0);
        const afterAbandon = vi.fn().mockResolvedValueOnce({ kind: 'recovery_failed' }).mockResolvedValueOnce({ kind: 'completed' });
        const onCompleted = vi.fn();
        const presented = presentFirstKeyCredentialLifecycle({ run: async () => result, afterAbandon, onCompleted });
        await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
        const config = shownConfig();
        storage.removeItemMock.mockImplementation((key) => {
            if (custodyKeys.has(key)) throw new Error('Storage unavailable');
            storage.store.delete(key);
        });
        await expect(config.props.abandon()).resolves.toEqual({ kind: 'recovery_failed' });
        expect(await pending()).not.toBeNull();
        storage.removeItemMock.mockImplementation((key) => { storage.store.delete(key); });
        await expect(config.props.abandon()).resolves.toEqual({ kind: 'recovery_failed' });
        expect(await pending()).toBeNull();
        storage.removeItemMock.mockClear();
        await expect(config.props.abandon()).resolves.toEqual({ kind: 'completed' });
        expect(storage.removeItemMock).not.toHaveBeenCalled();
        expect(afterAbandon).toHaveBeenCalledTimes(2);
        config.props.onSettled('abandon');
        await presented;
        expect(onCompleted).toHaveBeenCalledTimes(1);
    });
});
