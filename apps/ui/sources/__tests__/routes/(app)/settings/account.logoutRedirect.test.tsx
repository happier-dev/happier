import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest } from './account.testHelpers';
import {
    getAccountSettingsRouteRouterMockRef,
    installAccountSettingsRouteModuleMocks,
} from './accountSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type LogoutOptions = Readonly<{
    beforeMutation?: () => void;
    scope?: 'focused-home' | 'all-credentials';
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
const removeRunnerCreatorCustodyForAccountMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
let deletionConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

installAccountSettingsRouteModuleMocks({
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Readonly<{ home?: string }>) => (
                params?.home ? `${key}:${params.home}` : key
            ),
        });
    },
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

vi.mock('@/auth/context/AuthContext', async importOriginal => {
    const actual = await importOriginal<typeof import('@/auth/context/AuthContext')>();
    const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    return { ...actual, useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
        logout: logoutMock,
    }) };
});

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
vi.mock('@/sync/api/account/deleteCurrentAccount', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/api/account/deleteCurrentAccount')>(), deleteCurrentAccount: deleteCurrentAccountMock,
}));
vi.mock('@/sync/domains/ephemeralRunner/runnerCreatorDraftRemoval', () => ({
    removeRunnerCreatorCustodyForAccount: removeRunnerCreatorCustodyForAccountMock,
}));

vi.mock('@/components/account/ProviderIdentityItems', () => ({
    ProviderIdentityItems: () => null,
}));

const routerMockRef = getAccountSettingsRouteRouterMockRef();

// Loaded only after the route mocks above are registered: the real store's import graph reaches
// modules (such as the first-key credential lifecycle) that must bind the mocked `@/modal`.
let storage: typeof import('@/sync/domains/state/storageStore')['storage'];
beforeAll(async () => {
    await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
    ({ storage } = await import('@/sync/domains/state/storageStore'));
});

async function activateDeletionTestScope(): Promise<void> {
    const serverProfiles = await import('@/sync/domains/server/serverProfiles');
    deletionConnection = await restoreServerAccountForTest({ serverUrl: 'https://deletion-home.example.test', accountId: 'account-a',
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    });
    storage.getState().activateProfileScope({ serverId: serverProfiles.resolveServerProfileScopeIdForIdentifier(deletionConnection.home.id), accountId: 'account-a' });
}

describe('Settings → Account logout redirect', () => {
    afterEach(async () => {
        await deletionConnection?.dispose(); deletionConnection = null;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        logoutMock.mockClear();
        deleteCurrentAccountMock.mockClear();
        removeRunnerCreatorCustodyForAccountMock.mockReset().mockResolvedValue(undefined);
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
        const serverProfiles = await import('@/sync/domains/server/serverProfiles');
        const focusedHome = await serverProfiles.upsertServerProfile({
            serverUrl: 'https://studio-home.example.test',
            name: 'Studio Home',
            source: 'manual',
        });
        await serverProfiles.setActiveServerId(focusedHome.id);
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

        const logoutRow = screen.findByTestId('settings-account-logout');
        expect(logoutRow).toBeTruthy();

        let pendingLogoutPress: Promise<void> | undefined;
        await act(async () => {
            pendingLogoutPress = logoutRow?.props.onPress?.();
            await Promise.resolve();
        });

        expect(routerMockRef.current.spies.replace).toHaveBeenCalledWith('/');
        expect(logoutMock).toHaveBeenCalledWith({
            beforeMutation: expect.any(Function),
        });
        expect(modalMockRef.current?.spies.confirm).toHaveBeenCalledWith(
            'settingsAccount.logoutHome:Studio Home',
            'settingsAccount.logoutHomeConfirm:Studio Home',
            expect.objectContaining({
                confirmText: 'settingsAccount.logoutHome:Studio Home',
                destructive: true,
            }),
        );
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
        const logoutRow = screen.findByTestId('settings-account-logout');
        expect(logoutRow).toBeTruthy();

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

    it('offers a separately confirmed action that forgets every local credential', async () => {
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = getRequestUrl(input);
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse(),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as unknown as typeof fetch);
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderSettingsView(<AccountScreen />);

        const forgetAllRow = screen.findByTestId('settings-account-forget-all-credentials');
        expect(forgetAllRow).not.toBeNull();
        await act(async () => {
            await forgetAllRow?.props.onPress?.();
        });

        expect(modalMockRef.current?.spies.confirm).toHaveBeenCalledWith(
            'settingsAccount.forgetAllCredentials',
            'settingsAccount.forgetAllCredentialsConfirm',
            expect.objectContaining({
                confirmText: 'settingsAccount.forgetAllCredentials',
                destructive: true,
            }),
        );
        expect(logoutMock).toHaveBeenCalledWith({
            scope: 'all-credentials',
            beforeMutation: expect.any(Function),
        });
        expect(routerMockRef.current.spies.replace).toHaveBeenCalledWith('/');
    });

    it('requires typed confirmation before deletion and canonical logout cleanup', async () => {
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        await activateDeletionTestScope();
        logoutMock.mockImplementationOnce(async (options) => { await options?.beforeMutation?.(); teardownStartedMock(); return { kind: 'completed' }; });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { const url = getRequestUrl(input); if (isFeaturesRequest(url)) return { ok: true, json: async () => createAccountFeaturesResponse() }; throw new Error(`Unexpected fetch: ${url}`); }) as unknown as typeof fetch);
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderSettingsView(<AccountScreen />);
        const modal = modalMockRef.current;
        if (!modal) throw new Error('Expected account modal mock');
        modal.spies.prompt.mockResolvedValueOnce('DELETE');
        const row = screen.findRowByTitle('settingsAccount.deleteAccountEllipsis');
        expect(row?.props.testID).toBe('settings-account-delete');
        await act(async () => { await row?.props.onPress?.(); });
        expect(modal.spies.prompt).toHaveBeenCalledWith('settingsAccount.deleteAccountConfirmTitle', 'settingsAccount.deleteAccountConfirmBody', expect.objectContaining({ placeholder: 'DELETE' }));
        expect(deleteCurrentAccountMock).toHaveBeenCalledWith(expect.objectContaining({ token: createAccountTokenForTests('account-a', { currentAccount: true }) }), expect.objectContaining({ request: expect.any(Function) }));
        expect(routerMockRef.current.spies.replace).toHaveBeenCalledWith('/');
        expect(teardownStartedMock).toHaveBeenCalledTimes(1);
    });

    it('retries only acknowledged local Runner erasure before removing credentials', async () => {
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        await activateDeletionTestScope();
        removeRunnerCreatorCustodyForAccountMock
            .mockRejectedValueOnce(new Error('protected storage busy'))
            .mockResolvedValueOnce(undefined);
        logoutMock.mockImplementation(async (options) => {
            await options?.beforeMutation?.();
            teardownStartedMock();
            return { kind: 'completed' };
        });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = getRequestUrl(input);
            if (isFeaturesRequest(url)) return { ok: true, json: async () => createAccountFeaturesResponse() };
            throw new Error(`Unexpected fetch: ${url}`);
        }) as unknown as typeof fetch);
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderSettingsView(<AccountScreen />);
        const modal = modalMockRef.current;
        if (!modal) throw new Error('Expected account modal mock');
        modal.spies.prompt.mockResolvedValueOnce('DELETE');
        modal.spies.alertAsync.mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'common.retry')?.onPress?.();
        });

        await act(async () => { await screen.findRowByTitle('settingsAccount.deleteAccountEllipsis')?.props.onPress?.(); });

        expect(deleteCurrentAccountMock).toHaveBeenCalledOnce();
        expect(removeRunnerCreatorCustodyForAccountMock).toHaveBeenCalledTimes(2);
        expect(logoutMock).toHaveBeenCalledTimes(2);
        expect(teardownStartedMock).toHaveBeenCalledOnce();
        expect(modal.spies.alertAsync).toHaveBeenCalledWith(
            'settingsAccount.deleteAccountCleanupFailedTitle',
            'settingsAccount.deleteAccountCleanupFailed',
            expect.arrayContaining([expect.objectContaining({ text: 'common.retry' })]),
        );
    });
});
