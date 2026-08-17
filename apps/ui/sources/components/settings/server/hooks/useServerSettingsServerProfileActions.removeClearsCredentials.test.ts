import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';

import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';

const modalSpies = vi.hoisted(() => ({
    alert: vi.fn(),
    confirm: vi.fn(),
    prompt: vi.fn(),
    show: vi.fn(),
}));

const credentialLifecycleSpies = vi.hoisted(() => ({
    present: vi.fn(async (params: {
        run: () => Promise<
            | { kind: 'completed' }
            | { kind: 'finish_encryption_setup'; recovery: unknown }
            | { kind: 'recovery_failed' }
        >;
        onCompleted?: () => void | Promise<void>;
    }) => {
        const result = await params.run();
        if (result.kind === 'completed') {
            await params.onCompleted?.();
        }
    }),
}));

installServerSettingsHooksCommonModuleMocks({
    modal: () => createModalModuleMock({ spies: modalSpies }).module,
});

vi.mock('@/components/account/presentFirstKeyCredentialLifecycle', () => ({
    presentFirstKeyCredentialLifecycle: credentialLifecycleSpies.present,
}));

const pendingTerminalConnectMock = vi.hoisted(() => ({
    current: null as { publicKeyB64Url: string; serverUrl: string } | null,
    set: vi.fn((value: { publicKeyB64Url: string; serverUrl: string }) => {
        pendingTerminalConnectMock.current = value;
    }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => pendingTerminalConnectMock.current,
    setPendingTerminalConnect: pendingTerminalConnectMock.set,
}));

vi.mock('expo-secure-store', () => ({}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function renderHook<T>(useValue: () => T): Promise<T> {
    let current: T | null = null;

    function Test() {
        current = useValue();
        return null;
    }

    await renderScreen(React.createElement(Test));

    if (!current) throw new Error('Hook did not render');
    return current;
}

afterEach(() => {
    vi.unstubAllGlobals();
    pendingTerminalConnectMock.current = null;
    credentialLifecycleSpies.present.mockClear();
    vi.clearAllMocks();
    vi.resetModules();
});

describe('useServerSettingsServerProfileActions (remove server)', () => {
    it('clears server-scoped credentials so re-adding the server does not resurrect auth', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const localStorageHandle = installLocalStorageMock();

        const { Modal } = await import('@/modal');
        (Modal.confirm as any).mockResolvedValueOnce(true);

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = profiles.upsertServerProfile({
            serverUrl: 'https://server-a.example.test',
            name: 'Server A',
        });
        profiles.setActiveServerId(profile.id, { scope: 'device' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl(profile.serverUrl)).resolves.toEqual({
            token: 'token-a',
            secret: 'secret-a',
        });

        let revision = 0;
        const setRevision = (next: any) => {
            revision = typeof next === 'function' ? next(revision) : next;
        };

        const { useServerSettingsServerProfileActions } = await import('./useServerSettingsServerProfileActions');
        const actions = await renderHook(() =>
            useServerSettingsServerProfileActions({
                authStatusByServerId: {},
                onSwitchServerById: vi.fn(async () => true),
                onAfterSignedOutSwitch: vi.fn(),
                setRevision: setRevision as any,
            }),
        );

        await actions.onRemoveServer(profile);
        expect(revision).toBeGreaterThan(0);

        const readded = profiles.upsertServerProfile({ serverUrl: profile.serverUrl, name: 'Server A (again)' });
        expect(readded.id).toBe(profile.id);
        await expect(TokenStorage.getCredentialsForServerUrl(profile.serverUrl)).resolves.toBeNull();

        localStorageHandle.restore();
    });

    it('routes marked nonactive profile removal through shared recovery without mutating credentials or profile', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const localStorageHandle = installLocalStorageMock();

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const targetProfile = profiles.upsertServerProfile({
            serverUrl: 'https://marked.example.test',
            name: 'Marked',
        });
        const activeProfile = profiles.upsertServerProfile({
            serverUrl: 'https://active.example.test',
            name: 'Active',
        });
        profiles.setActiveServerId(targetProfile.id, { scope: 'device' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.setCredentials({
            token: 'marked-token',
            secret: 'marked-secret',
        })).resolves.toBe(true);
        const createdAt = Date.now();
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'marked-secret',
            serverId: targetProfile.id,
            serverUrl: targetProfile.serverUrl,
            returnTo: '/settings/account',
            accountEncryptionFirstKey: {
                accountId: 'account-1',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}',
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                pending: 'oauth-pending',
                migrationSubmissionAttempted: true,
            },
        })).resolves.toBe(true);
        profiles.setActiveServerId(activeProfile.id, { scope: 'device' });
        const { Modal } = await import('@/modal');
        (Modal.confirm as any).mockResolvedValueOnce(true);

        let revision = 0;
        const { useServerSettingsServerProfileActions } = await import('./useServerSettingsServerProfileActions');
        const actions = await renderHook(() =>
            useServerSettingsServerProfileActions({
                authStatusByServerId: {},
                onSwitchServerById: vi.fn(async () => true),
                onAfterSignedOutSwitch: vi.fn(),
                setRevision: ((next: React.SetStateAction<number>) => {
                    revision = typeof next === 'function'
                        ? next(revision)
                        : next;
                }) as React.Dispatch<React.SetStateAction<number>>,
            }),
        );

        await actions.onRemoveServer(targetProfile);

        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(revision).toBe(0);
        expect(profiles.getServerProfileById(targetProfile.id)).not.toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl(
            targetProfile.serverUrl,
            { serverId: targetProfile.id },
        )).resolves.toEqual({
            token: 'marked-token',
            secret: 'marked-secret',
        });

        localStorageHandle.restore();
    });

    it('retargets a pending terminal connect when the user manually switches relays', async () => {
        pendingTerminalConnectMock.current = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://wrong.example.test',
        };
        const onSwitchServerById = vi.fn(async () => true);
        const setRevision = vi.fn();
        const profile = {
            id: 'server-correct',
            name: 'Correct',
            serverUrl: 'https://correct.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
        };

        const { useServerSettingsServerProfileActions } = await import('./useServerSettingsServerProfileActions');
        const actions = await renderHook(() =>
            useServerSettingsServerProfileActions({
                authStatusByServerId: { 'server-correct': 'signedIn' },
                onSwitchServerById,
                onAfterSignedOutSwitch: vi.fn(),
                setRevision: setRevision as any,
            }),
        );

        await actions.onSwitchServer(profile);

        expect(pendingTerminalConnectMock.set).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://correct.example.test',
        });
        expect(onSwitchServerById).toHaveBeenCalledWith('server-correct');
    });

    it('does not retarget pending terminal state when custody blocks the server switch', async () => {
        pendingTerminalConnectMock.current = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://active.example.test',
        };
        const onSwitchServerById = vi.fn(async () => false);
        const setRevision = vi.fn();
        const profile = {
            id: 'server-blocked',
            name: 'Blocked',
            serverUrl: 'https://blocked.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
        };

        const { useServerSettingsServerProfileActions } = await import('./useServerSettingsServerProfileActions');
        const actions = await renderHook(() =>
            useServerSettingsServerProfileActions({
                authStatusByServerId: { 'server-blocked': 'signedIn' },
                onSwitchServerById,
                onAfterSignedOutSwitch: vi.fn(),
                setRevision: setRevision as any,
            }),
        );

        await actions.onSwitchServer(profile);

        expect(onSwitchServerById).toHaveBeenCalledWith('server-blocked');
        expect(pendingTerminalConnectMock.set).not.toHaveBeenCalled();
        expect(setRevision).not.toHaveBeenCalled();
    });

    it('switches by server identity id after the profile learns a stable server identity', async () => {
        pendingTerminalConnectMock.current = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://wrong.example.test',
        };
        const onSwitchServerById = vi.fn(async () => true);
        const setRevision = vi.fn();
        const profile = {
            id: 'server-host-derived',
            name: 'Correct',
            serverUrl: 'https://correct.example.test',
            serverIdentityId: 'srv_identity_correct',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
        };

        const { useServerSettingsServerProfileActions } = await import('./useServerSettingsServerProfileActions');
        const actions = await renderHook(() =>
            useServerSettingsServerProfileActions({
                authStatusByServerId: { srv_identity_correct: 'signedIn' },
                onSwitchServerById,
                onAfterSignedOutSwitch: vi.fn(),
                setRevision: setRevision as any,
            }),
        );

        await actions.onSwitchServer(profile);

        expect(pendingTerminalConnectMock.set).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://correct.example.test',
        });
        expect(onSwitchServerById).toHaveBeenCalledWith('srv_identity_correct');
    });
});
