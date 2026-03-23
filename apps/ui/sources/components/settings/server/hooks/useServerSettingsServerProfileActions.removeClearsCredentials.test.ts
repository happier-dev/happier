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

installServerSettingsHooksCommonModuleMocks({
    modal: () => createModalModuleMock({ spies: modalSpies }).module,
});

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
    vi.clearAllMocks();
    vi.resetModules();
});

describe('useServerSettingsServerProfileActions (remove server)', () => {
    it('clears server-scoped credentials so re-adding the server does not resurrect auth', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const localStorageHandle = installLocalStorageMock();

        const { Modal } = await import('@/modal');
        // Current behavior prompts twice: "remove" then optionally "also sign out".
        // This test asserts we clear credentials even if the second prompt is declined.
        (Modal.confirm as any).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

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
                onSwitchServerById: vi.fn(async () => {}),
                onAfterSignedOutSwitch: vi.fn(),
                setRevision: setRevision as any,
                setServerSelectionActiveTargetKind: vi.fn(),
                setServerSelectionActiveTargetId: vi.fn(),
            }),
        );

        await actions.onRemoveServer(profile);
        expect(revision).toBeGreaterThan(0);

        const readded = profiles.upsertServerProfile({ serverUrl: profile.serverUrl, name: 'Server A (again)' });
        expect(readded.id).toBe(profile.id);
        await expect(TokenStorage.getCredentialsForServerUrl(profile.serverUrl)).resolves.toBeNull();

        localStorageHandle.restore();
    });
});
