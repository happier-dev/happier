import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';

import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest } from './account.testHelpers';
import {
    getAccountSettingsRouteRouterMockRef,
    installAccountSettingsRouteModuleMocks,
} from './accountSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type LogoutOptions = Readonly<{
    beforeMutation?: () => void;
}>;
type LogoutResult =
    | Readonly<{ kind: 'completed' }>
    | Readonly<{
        kind: 'finish_encryption_setup';
        recovery: never;
    }>;

const teardownStartedMock = vi.hoisted(() => vi.fn());
const modalMockRef = vi.hoisted(() => ({
    current: null as ReturnType<
        typeof import('@/dev/testkit/mocks/modal')['createModalModuleMock']
    > | null,
}));
const logoutMock = vi.hoisted(() =>
    vi.fn<
        (options?: LogoutOptions) =>
            Promise<LogoutResult>
    >(async () => ({ kind: 'completed' })),
);
const deleteCurrentAccountMock = vi.hoisted(() => vi.fn(async () => ({ status: 'deleted' as const })));

installAccountSettingsRouteModuleMocks({
    modalModule: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock({
            confirmResult: true,
        });
        modalMockRef.current = modalMock;
        return modalMock.module;
    },
});

vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: {
        isModernBarcodeScannerAvailable: false,
        onModernBarcodeScanned: () => ({ remove: () => {} }),
        launchScanner: () => {},
        dismissScanner: async () => {},
    },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        logout: logoutMock,
    }),
}));

vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: () => ({
        connectAccount: vi.fn(),
        isLoading: false,
    }),
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => false,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({
        isReady: true,
        isLoadingFeatures: false,
        reason: null,
        requiredProviderId: null,
        requiredProviderDisplayName: null,
        requiredProviderConnected: false,
        requiredProviderLogin: null,
        gate: { isReady: true, gateVariant: 'none' },
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));
vi.mock('@/sync/api/account/deleteCurrentAccount', () => ({ deleteCurrentAccount: deleteCurrentAccountMock }));

vi.mock('@/components/account/ProviderIdentityItems', () => ({
    ProviderIdentityItems: () => null,
}));

const routerMockRef = getAccountSettingsRouteRouterMockRef();

describe('Settings → Account logout redirect', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        logoutMock.mockClear();
        deleteCurrentAccountMock.mockClear();
        teardownStartedMock.mockClear();
        routerMockRef.current?.spies.push.mockReset();
        routerMockRef.current?.spies.back.mockReset();
        routerMockRef.current?.spies.replace.mockReset();
        routerMockRef.current?.spies.setParams.mockReset();
        modalMockRef.current?.spies.show.mockClear();
        modalMockRef.current?.spies.confirm.mockClear();
        standardCleanup();
    });

    it('routes after custody authorization and before tearing down auth state', async () => {
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        let resolveLogout!: () => void;
        logoutMock.mockImplementationOnce(async (options) => {
            options?.beforeMutation?.();
            teardownStartedMock();
            return await new Promise<{ kind: 'completed' }>((resolve) => {
                resolveLogout = () => resolve({ kind: 'completed' });
            });
        });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = getRequestUrl(input);
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse(),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderSettingsView(<AccountScreen />);

        const logoutRow = screen.findRowByTitle('settingsAccount.logout');
        expect(logoutRow?.props.testID).toBe('settings-account-logout');

        let pendingLogoutPress: Promise<void> | undefined;
        await act(async () => {
            pendingLogoutPress = logoutRow?.props.onPress?.();
            await Promise.resolve();
        });

        expect(routerMockRef.current.spies.replace).toHaveBeenCalledWith('/');
        expect(logoutMock).toHaveBeenCalledWith({
            beforeMutation: expect.any(Function),
        });
        expect(
            logoutMock.mock.invocationCallOrder[0],
        ).toBeLessThan(
            routerMockRef.current.spies.replace.mock.invocationCallOrder[0]!,
        );
        expect(
            routerMockRef.current.spies.replace.mock.invocationCallOrder[0],
        ).toBeLessThan(
            teardownStartedMock.mock.invocationCallOrder[0]!,
        );

        resolveLogout();
        await act(async () => {
            await pendingLogoutPress;
        });
    });

    it('does not route when custody blocks logout for recovery', async () => {
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        logoutMock.mockImplementationOnce(async () => ({
            kind: 'finish_encryption_setup',
            recovery: {} as never,
        }));
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = getRequestUrl(input);
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse(),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderSettingsView(<AccountScreen />);
        const logoutRow = screen.findRowByTitle('settingsAccount.logout');

        let pendingLogoutPress: Promise<void> | undefined;
        await act(async () => {
            pendingLogoutPress = logoutRow?.props.onPress?.();
            await Promise.resolve();
        });

        expect(logoutMock).toHaveBeenCalledWith({
            beforeMutation: expect.any(Function),
        });
        expect(routerMockRef.current.spies.replace).not.toHaveBeenCalled();
        const modalMock = modalMockRef.current;
        if (!modalMock) {
            throw new Error('Expected account logout modal mock');
        }
        expect(modalMock.spies.show).toHaveBeenCalledTimes(1);

        const modalConfig =
            modalMock.spies.show.mock.calls[0]?.[0] as
                | Readonly<{ onRequestClose: () => void }>
                | undefined;
        modalConfig?.onRequestClose();
        await act(async () => {
            await pendingLogoutPress;
        });
    });

    it('requires typed confirmation before deletion and canonical logout cleanup', async () => {
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        logoutMock.mockImplementationOnce(async (options) => { await options?.beforeMutation?.(); teardownStartedMock(); return { kind: 'completed' }; });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { const url = getRequestUrl(input); if (isFeaturesRequest(url)) return { ok: true, json: async () => createAccountFeaturesResponse() }; throw new Error(`Unexpected fetch: ${url}`); }) as unknown as typeof fetch);
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderSettingsView(<AccountScreen />);
        const modal = modalMockRef.current;
        if (!modal) throw new Error('Expected account modal mock');
        modal.spies.prompt.mockResolvedValueOnce('DELETE');
        const row = screen.findRowByTitle('settingsAccount.deleteAccount');
        expect(row?.props.testID).toBe('settings-account-delete');
        await act(async () => { await row?.props.onPress?.(); });
        expect(modal.spies.prompt).toHaveBeenCalledWith('settingsAccount.deleteAccountConfirmTitle', 'settingsAccount.deleteAccountConfirmBody', expect.objectContaining({ placeholder: 'DELETE' }));
        expect(deleteCurrentAccountMock).toHaveBeenCalledWith(expect.objectContaining({ token: 't' }));
        expect(routerMockRef.current.spies.replace).toHaveBeenCalledWith('/');
        expect(teardownStartedMock).toHaveBeenCalledTimes(1);
    });
});
