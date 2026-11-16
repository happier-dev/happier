import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IModal } from '@/modal';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

const confirm = vi.hoisted(() => vi.fn<IModal['confirm']>(async () => true));
const prompt = vi.hoisted(() => vi.fn<IModal['prompt']>(async () => 'DELETE'));
const replace = vi.hoisted(() => vi.fn<(path: unknown) => void>());
const alertAsync = vi.hoisted(() => vi.fn<IModal['alertAsync']>(async () => undefined));
const reviewAnswers = vi.hoisted(() => [] as boolean[]);
const show = vi.hoisted(() => vi.fn<IModal['show']>(config => {
    const props = config.props as { onAnswer?: (confirmed: boolean) => void } | undefined;
    if (typeof props?.onAnswer === 'function') {
        queueMicrotask(() => props.onAnswer?.(reviewAnswers.shift() ?? true));
        return 'action-review';
    }
    queueMicrotask(() => config.onRequestClose?.());
    return 'custody-recovery';
}));
installTokenStorageWebPlatformMocks();
installApprovalCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { confirm, prompt, alertAsync, show } }).module,
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { replace } }).module,
});
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: { isModernBarcodeScannerAvailable: false, onModernBarcodeScanned: () => ({ remove() {} }), launchScanner() {}, async dismissScanner() {} },
}));

// Keep cold graph transformation out of per-case deadlines; these are the real
// production owners and the canonical Metro call-time require bridge.
const restoreExecutor = await installRealActionExecutorModuleLoader();
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { default: AccountScreen } = await import('@/app/(app)/settings/account');
afterAll(restoreExecutor);

let homes: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let restoreStorage: (() => void) | undefined;
const credentials = { token: createAccountTokenForTests('account-a', { currentAccount: true }) };

async function mount(waiveDeletion = false, refuseDeletion = false,
    erase?: () => Promise<Response>, retireRoute = false) {
    homes = await serveAccountHomes({ homes: [
        { key: 'other', serverUrl: 'https://other-home.test', accountId: 'account-other', currentAccount: true },
        { key: 'focused', serverUrl: 'https://studio-home.test', accountId: 'account-a', credentials,
            settings: { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                ...(waiveDeletion ? { approvalWaivedSurfaces: { 'account.delete': ['ui'] } } : {}) }) } },
    ], route: request => {
        if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
        if (request.path === '/v1/auth/account/delete') return erase ? erase() : refuseDeletion
            ? Response.json({ error: 'account_erasure_transition_cleanup_pending' }, { status: 409 })
            : Response.json({ status: 'deleted' });
        return undefined;
    } });
    const { storage } = await import('@/sync/domains/state/storage');
    const scope = { serverId: homes.homes.focused!.id, accountId: 'account-a' };
    storage.getState().activateProfileScope(scope);
    await storage.getState().activateSettingsScope(scope);
    let leaveAccountRoute = () => {};
    function AccountRoute() {
        const [visible, setVisible] = React.useState(true);
        leaveAccountRoute = () => setVisible(false);
        return visible ? <AccountScreen /> : null;
    }
    screen = await renderScreen(<AuthProvider initialCredentials={credentials}>
        {retireRoute ? <AccountRoute /> : <AccountScreen />}
    </AuthProvider>);
    if (retireRoute) replace.mockImplementation(() => leaveAccountRoute());
    return { screen, homes };
}

async function storedCredential(key: 'focused' | 'other') {
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const home = homes!.homes[key]!;
    return TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
}

async function waitForDeletionSettlement() {
    // Item's host press handler starts the async action without returning it.
    await waitForHomeGovernance(() => expect(screen?.findAllByTestId('settings-account-delete')
        .some(node => node.props.loading === true)).toBe(false));
}

describe('Settings → Account logout redirect', () => {
    beforeEach(async () => {
        restoreStorage = installLocalStorageMock().restore;
        confirm.mockReset().mockResolvedValue(true);
        prompt.mockReset().mockResolvedValue('DELETE');
        replace.mockReset();
        alertAsync.mockClear();
        show.mockClear();
        reviewAnswers.length = 0;
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockImplementation(confirm);
        vi.mocked(Modal.prompt).mockImplementation(prompt);
        vi.mocked(Modal.alertAsync).mockImplementation(alertAsync);
        vi.mocked(Modal.show).mockImplementation(show);
    });
    afterEach(async () => {
        await screen?.unmount(); screen = undefined;
        await homes?.dispose(); homes = undefined;
        restoreStorage?.(); restoreStorage = undefined;
        vi.restoreAllMocks();
    });

    it('routes after custody authorization and before tearing down auth state', async () => {
        const { screen } = await mount();
        const beforeRemoval = createDeferred<unknown>();
        replace.mockImplementation(() => {
            // Observe custody at the navigation boundary with real Auth lifecycle.
            void storedCredential('focused').then(beforeRemoval.resolve);
        });
        await screen.pressByTestIdAsync('settings-account-logout');
        expect(replace).toHaveBeenCalledWith('/');
        expect(await beforeRemoval.promise).toEqual(credentials);
        await waitForHomeGovernance(async () => expect(await storedCredential('focused')).toBeNull());
        expect(await storedCredential('other')).not.toBeNull();
        expect(confirm).not.toHaveBeenCalled();
    });

    it('offers a separately confirmed action that forgets every local credential', async () => {
        const { screen } = await mount();
        await screen.pressByTestIdAsync('settings-account-forget-all-credentials');
        await waitForHomeGovernance(() => expect(show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ actionId: 'account.credentials.forgetAll' }),
        })));
        await waitForHomeGovernance(async () => expect(await storedCredential('focused')).toBeNull());
        expect(await storedCredential('other')).toBeNull();
        expect(replace).toHaveBeenCalledWith('/');
    });

    it('does not route when custody blocks logout for recovery', async () => {
        const { screen, homes } = await mount();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const home = homes.homes.focused!;
        await expect(TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'proof', secret: 'secret',
            serverId: home.id, serverUrl: home.serverUrl, accountEncryptionFirstKey: {
                accountId: 'account-a', requestDigest: `aemrb1_${'A'.repeat(43)}`, requestJson: '{}', pending: 'pending',
                createdAt: Date.now(), expiresAt: Date.now() + 60_000, migrationSubmissionAttempted: true,
            },
        })).resolves.toBe(true);
        try {
            await screen.pressByTestIdAsync('settings-account-logout');
            await waitForHomeGovernance(() => expect(show).toHaveBeenCalledTimes(1));
            expect(replace).not.toHaveBeenCalled();
            expect(await storedCredential('focused')).toEqual(credentials);
            expect((await import('@/auth/context/currentAuth')).getCurrentAuth()?.isAuthenticated).toBe(true);
        } finally { await TokenStorage.clearPendingExternalAuth(); }
    });

    it('requires typed confirmation before deletion and canonical logout cleanup', async () => {
        const { screen, homes } = await mount();
        reviewAnswers.push(false);
        await screen.pressByTestIdAsync('settings-account-delete');
        await waitForHomeGovernance(() => expect(show).toHaveBeenCalledTimes(1));
        await waitForDeletionSettlement();
        expect(homes.requests.filter(request => request.path === '/v1/auth/account/delete')).toHaveLength(0);
        expect(await storedCredential('focused')).toEqual(credentials);
        await screen.pressByTestIdAsync('settings-account-delete');
        await waitForDeletionSettlement();
        expect(show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({
            actionId: 'account.delete',
            typedConfirmation: expect.objectContaining({ text: 'DELETE', placeholder: 'DELETE' }),
        }) }));
        expect(prompt).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect(homes.requests.filter(request => request.path === '/v1/auth/account/delete')).toHaveLength(1);
        expect(await storedCredential('focused')).toBeNull();
        expect(await storedCredential('other')).not.toBeNull();
        expect(replace).toHaveBeenCalledWith('/');
    });

    it('honors waived Account deletion without a caller confirmation', async () => {
        const { screen, homes } = await mount(true);
        await screen.pressByTestIdAsync('settings-account-delete');
        await waitForDeletionSettlement();
        expect(prompt).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect(homes.requests.filter(request => request.path === '/v1/auth/account/delete')).toHaveLength(1);
        expect(await storedCredential('focused')).toBeNull();
    });

    it('keeps credentials and discloses the Request ID for a confirmed erasure refusal', async () => {
        const { screen } = await mount(true, true);
        const { Modal } = await import('@/modal');
        const alert = vi.mocked(Modal.alert);
        alert.mockClear();
        await screen.pressByTestIdAsync('settings-account-delete');
        await waitForDeletionSettlement();
        expect(await storedCredential('focused')).toEqual(credentials);
        expect(replace).not.toHaveBeenCalled();
        expect(alert).toHaveBeenCalledWith('homeGovernance.changeFailedTitle', 'homeGovernance.errorErasureTransitionCleanupPending',
            expect.arrayContaining([expect.objectContaining({ text: 'approvals.technicalDetails' })]));
        const buttons = alert.mock.calls[0]?.[2];
        buttons?.find(button => button.text === 'approvals.technicalDetails')?.onPress?.();
        const details = alert.mock.calls.at(-1)?.[1];
        expect(JSON.parse(String(details))).toMatchObject({ code: 'account_erasure_transition_cleanup_pending', requestId: expect.any(String) });
    });

    it('retries acknowledged local cleanup without deleting the Account twice', async () => {
        const { screen, homes } = await mount();
        replace.mockImplementationOnce(() => { throw new Error('Navigation unavailable'); });
        alertAsync.mockImplementationOnce(async (_title, _message, buttons) => {
            expect(await storedCredential('focused')).toEqual(credentials);
            buttons?.find(button => button.text === 'common.retry')?.onPress?.();
        });
        await screen.pressByTestIdAsync('settings-account-delete');
        await waitForHomeGovernance(() => expect(alertAsync).toHaveBeenCalledWith('settingsAccount.deleteAccountCleanupFailedTitle',
            'settingsAccount.deleteAccountCleanupFailed', expect.arrayContaining([expect.objectContaining({ text: 'common.retry' })])));
        await waitForDeletionSettlement();
        expect(homes.requests.filter(request => request.path === '/v1/auth/account/delete')).toHaveLength(1);
        expect(await storedCredential('focused')).toBeNull();
        expect(await storedCredential('other')).not.toBeNull();
    });

    it('keeps the person signed in until the Home confirms deletion, including a refused response', async () => {
        const answer = createDeferred<Response>();
        const { screen, homes } = await mount(true, false, () => answer.promise);
        const pending = screen.pressByTestIdAsync('settings-account-delete');
        try {
            await waitForHomeGovernance(() => expect(homes.requests.some(request => request.path === '/v1/auth/account/delete')).toBe(true));
            expect(await storedCredential('focused')).toEqual(credentials);
            expect((await import('@/auth/context/currentAuth')).getCurrentAuth()?.isAuthenticated).toBe(true);
            expect(replace).not.toHaveBeenCalled();
            answer.resolve(Response.json({ error: 'team_owner_transfer_required' }, { status: 409 }));
            await pending;
            await waitForDeletionSettlement();
            expect(await storedCredential('focused')).toEqual(credentials);
            expect(replace).not.toHaveBeenCalled();
            const alert = vi.mocked((await import('@/modal')).Modal.alert);
            await waitForHomeGovernance(() => expect(alert).toHaveBeenCalledWith(
                'homeGovernance.changeFailedTitle', 'homeGovernance.errorTeamOwnerTransferRequired', expect.any(Array)));
        } finally {
            answer.resolve(Response.json({ error: 'team_owner_transfer_required' }, { status: 409 }));
            await pending;
        }
    });

    it('explains an unconfirmed deletion without discarding the local sign-in', async () => {
        const { screen } = await mount(true, false, async () => { throw new TypeError('fetch failed'); });
        const alert = vi.mocked((await import('@/modal')).Modal.alert);
        alert.mockClear();
        await screen.pressByTestIdAsync('settings-account-delete');
        await waitForDeletionSettlement();
        expect(await storedCredential('focused')).toEqual(credentials);
        expect(replace).not.toHaveBeenCalled();
        expect(alert).toHaveBeenCalledWith('settingsAccount.deleteAccountFailedTitle',
            'settingsAccount.deleteAccountFailed', expect.any(Array));
    });

    it('keeps deletion unconfirmed when remote revocation signs this device out before the reply is lost', async () => {
        const { screen } = await mount(true, false, async () => {
            const auth = (await import('@/auth/context/currentAuth')).getCurrentAuth();
            if (!auth) throw new Error('Expected real authenticated Account');
            await auth.logout();
            throw new TypeError('Deletion reply lost after remote revocation');
        });
        const alert = vi.mocked((await import('@/modal')).Modal.alert);
        alert.mockClear();
        await screen.pressByTestIdAsync('settings-account-delete');
        await waitForDeletionSettlement();
        expect(await storedCredential('focused')).toBeNull();
        expect(await storedCredential('other')).not.toBeNull();
        expect(alert).toHaveBeenCalledWith('settingsAccount.deleteAccountFailedTitle',
            'settingsAccount.deleteAccountFailed', expect.any(Array));
    });

    it('does not show a failure after confirmed deletion retires the Account route', async () => {
        const { screen } = await mount(true, false, undefined, true);
        const alert = vi.mocked((await import('@/modal')).Modal.alert);
        alert.mockClear();
        await screen.pressByTestIdAsync('settings-account-delete');
        await waitForHomeGovernance(async () => expect(await storedCredential('focused')).toBeNull());
        expect(replace).toHaveBeenCalledWith('/');
        expect(alert).not.toHaveBeenCalled();
    });

    it('does not show a failure after confirmed retirement with deletion pending', async () => {
        const { screen } = await mount(true, false, async () => Response.json({ status: 'disabled_pending_completion' }), true);
        const alert = vi.mocked((await import('@/modal')).Modal.alert);
        alert.mockClear();
        await screen.pressByTestIdAsync('settings-account-delete');
        await waitForHomeGovernance(() => expect(alertAsync).toHaveBeenCalledWith('homeGovernance.deleteIncompleteTitle', 'settingsAccount.deleteAccountFinishing'));
        expect(await storedCredential('focused')).toBeNull();
        expect(await storedCredential('other')).not.toBeNull();
        expect(replace).toHaveBeenCalledWith('/');
        expect(alertAsync).toHaveBeenCalledWith('homeGovernance.deleteIncompleteTitle', 'settingsAccount.deleteAccountFinishing');
        expect(alert).not.toHaveBeenCalled();
    });

    it('keeps pending deletion distinct while retrying only this device’s sign-out', async () => {
        const { screen, homes } = await mount(true, false, async () => Response.json({ status: 'disabled_pending_completion' }));
        replace.mockImplementationOnce(() => { throw new Error('Navigation unavailable'); });
        alertAsync.mockImplementationOnce(async (_title, _message, buttons) => {
            expect(await storedCredential('focused')).toEqual(credentials);
            buttons?.find(button => button.text === 'common.retry')?.onPress?.();
        });
        await screen.pressByTestIdAsync('settings-account-delete');
        await waitForDeletionSettlement();
        expect(alertAsync).toHaveBeenCalledWith('homeGovernance.deleteIncompleteTitle',
            'settingsAccount.deleteAccountFinishingCleanupFailed', expect.arrayContaining([expect.objectContaining({ text: 'common.retry' })]));
        expect(alertAsync).toHaveBeenCalledWith('homeGovernance.deleteIncompleteTitle', 'settingsAccount.deleteAccountFinishing');
        expect(homes.requests.filter(request => request.path === '/v1/auth/account/delete')).toHaveLength(1);
        expect(await storedCredential('focused')).toBeNull();
        expect(await storedCredential('other')).not.toBeNull();
    });
});
