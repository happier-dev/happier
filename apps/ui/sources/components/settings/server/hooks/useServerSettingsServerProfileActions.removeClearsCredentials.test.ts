import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

let localStorageHandle: ReturnType<typeof installLocalStorageMock>;
beforeEach(async () => {
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `server-removal-${crypto.randomUUID()}`);
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'unavailable');
    localStorageHandle = installLocalStorageMock();
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockResolvedValue(true);
    // The real first-key presenter owns custody. Simulate dismissing its native
    // modal, never replace the lifecycle operation that decides whether to show it.
    vi.mocked(Modal.show).mockImplementation((config) => {
        queueMicrotask(() => config.onRequestClose?.());
        return 'recovery-modal';
    });
});
afterEach(async () => {
    standardCleanup();
    const { clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
    clearPendingTerminalConnect();
    localStorageHandle.restore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
});

async function actionsFor(options: Partial<Parameters<typeof import('./useServerSettingsServerProfileActions')['useServerSettingsServerProfileActions']>[0]> = {}) {
    const { useServerSettingsServerProfileActions } = await import('./useServerSettingsServerProfileActions');
    const hook = await renderHook(() => useServerSettingsServerProfileActions({
        authStatusByServerId: {},
        selectionScope: 'device',
        onSwitchServerById: async (serverId) => {
            const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
            await setActiveServerId(serverId, { scope: 'device' });
            return 'switched';
        },
        onAfterSignedOutSwitch: vi.fn(),
        setRevision: vi.fn(),
        ...options,
    }));
    return hook.getCurrent();
}

describe('useServerSettingsServerProfileActions (remove server)', () => {
    it('clears server-scoped credentials so re-adding the server does not resurrect auth', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = await profiles.upsertServerProfile({ serverUrl: 'https://server-a.example.test', name: 'Server A' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = { token: 'token-a', secret: 'secret-a' };
        await expect(TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id }, credentials)).resolves.toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id })).resolves.toEqual(credentials);
        let revision = 0;
        const actions = await actionsFor({ setRevision: (next) => { revision = typeof next === 'function' ? next(revision) : next; } });
        await actions.onRemoveServer(profile);
        expect(revision).toBeGreaterThan(0);
        expect(profiles.getServerProfileById(profile.id)).toBeNull();
        const readded = await profiles.upsertServerProfile({ serverUrl: profile.serverUrl, name: 'Server A (again)' });
        expect(readded.id).toBe(profile.id);
        await expect(TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: readded.id })).resolves.toBeNull();
    });

    it('routes marked nonactive profile removal through shared recovery without mutating credentials or profile', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const target = await profiles.upsertServerProfile({ serverUrl: 'https://marked.example.test', name: 'Marked' });
        const active = await profiles.upsertServerProfile({ serverUrl: 'https://active.example.test', name: 'Active' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = { token: 'marked-token', secret: 'marked-secret' };
        await expect(TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, credentials)).resolves.toBe(true);
        const createdAt = Date.now();
        const pending = {
            provider: 'github' as const, proof: 'proof', secret: 'marked-secret',
            serverId: target.id, serverUrl: target.serverUrl, returnTo: '/settings/account',
            accountEncryptionFirstKey: {
                accountId: 'account-1', requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}', createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                pending: 'oauth-pending' as const, migrationSubmissionAttempted: true,
            },
        };
        await expect(TokenStorage.setPendingExternalAuth(pending)).resolves.toBe(true);
        await profiles.setActiveServerId(active.id, { scope: 'device' });
        let revision = 0;
        const actions = await actionsFor({ setRevision: (next) => { revision = typeof next === 'function' ? next(revision) : next; } });
        await actions.onRemoveServer(target);
        const { Modal } = await import('@/modal');
        expect(Modal.show).toHaveBeenCalled();
        expect(revision).toBe(0);
        expect(profiles.getServerProfileById(target.id)).not.toBeNull();
        expect(profiles.getActiveServerId()).toBe(active.id);
        await expect(TokenStorage.getCredentialsForServerUrl(target.serverUrl, { serverId: target.id })).resolves.toEqual(credentials);
        await expect(TokenStorage.readPendingExternalAuthStateForServerUrl(target.serverUrl, { serverId: target.id }))
            .resolves.toMatchObject({ value: pending, serverMismatch: false });
    });

    it('retargets an unclaimed pending terminal connect when the user manually switches Homes', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const from = await profiles.upsertServerProfile({ serverUrl: 'https://wrong.example.test', name: 'Wrong' });
        const to = await profiles.upsertServerProfile({ serverUrl: 'https://correct.example.test', name: 'Correct' });
        await profiles.setActiveServerId(from.id, { scope: 'device' });
        const pending = await import('@/sync/domains/pending/pendingTerminalConnect');
        pending.setPendingTerminalConnect({ publicKeyB64Url: 'abc123', serverUrl: from.serverUrl, serverIdentityId: 'srv_original_home' });
        const actions = await actionsFor({ authStatusByServerId: { [to.id]: 'signedOut' } });
        await actions.onSwitchServer(to);
        expect(pending.getPendingTerminalConnect()).toMatchObject({
            publicKeyB64Url: 'abc123', serverUrl: to.serverUrl, serverIdentityId: 'srv_original_home',
        });
        expect(profiles.getActiveServerId()).toBe(to.id);
    });

    it('selects a signed-out Home and continues to target-specific auth without another prompt', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = await profiles.upsertServerProfile({ serverUrl: 'https://signed-out.example.test', name: 'Signed out' });
        const onAfterSignedOutSwitch = vi.fn();
        const actions = await actionsFor({ onAfterSignedOutSwitch });
        await actions.onSwitchServer(profile);
        const { Modal } = await import('@/modal');
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(profiles.getActiveServerId()).toBe(profile.id);
        expect(onAfterSignedOutSwitch).toHaveBeenCalledTimes(1);
    });

    it('does not route a Home whose credential store cannot be read to sign-in', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = await profiles.upsertServerProfile({ serverUrl: 'https://unreadable.example.test', name: 'Unreadable' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (_url, options) => {
            if (options?.storageReadFailure === 'surface') throw new Error('secure_storage_unavailable');
            return null;
        });
        const onAfterSignedOutSwitch = vi.fn();
        const actions = await actionsFor({ onAfterSignedOutSwitch });
        await actions.onSwitchServer(profile);
        expect(profiles.getActiveServerId()).toBe(profile.id);
        expect(onAfterSignedOutSwitch).not.toHaveBeenCalled();
    });

    it('does not retarget pending terminal state when the containing switch refuses', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const from = await profiles.upsertServerProfile({ serverUrl: 'https://active.example.test', name: 'Active' });
        const to = await profiles.upsertServerProfile({ serverUrl: 'https://blocked.example.test', name: 'Blocked' });
        await profiles.setActiveServerId(from.id, { scope: 'device' });
        const pending = await import('@/sync/domains/pending/pendingTerminalConnect');
        pending.setPendingTerminalConnect({ publicKeyB64Url: 'abc123', serverUrl: from.serverUrl, serverIdentityId: 'srv_original_home' });
        const before = pending.getPendingTerminalConnect();
        const setRevision = vi.fn();
        const actions = await actionsFor({ setRevision, onSwitchServerById: async () => 'blocked', authStatusByServerId: { [to.id]: 'signedOut' } });
        await actions.onSwitchServer(to);
        expect(pending.getPendingTerminalConnect()).toEqual(before);
        expect(profiles.getActiveServerId()).toBe(from.id);
        expect(setRevision).not.toHaveBeenCalled();
    });

    it('switches by server identity after the profile learns a stable server identity', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = await profiles.adoptHomeProfile({
            descriptor: { serverUrl: 'https://correct.example.test', homeServerIdentityId: 'srv_identity_correct', displayName: 'Correct' },
            source: 'manual', suggestedName: 'Correct',
        });
        const actions = await actionsFor({ authStatusByServerId: { srv_identity_correct: 'signedOut' } });
        await actions.onSwitchServer(profile);
        expect(profiles.getActiveServerId()).toBe('srv_identity_correct');
        expect(profiles.resolveServerProfileScopeId(profile)).toBe('srv_identity_correct');
    });
});
