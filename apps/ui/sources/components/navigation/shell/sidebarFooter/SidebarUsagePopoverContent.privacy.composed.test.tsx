import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installConnectedServicesCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module,
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
setRuntimeFetch(home.request);
await loadSyncSingletonForTests();
// Load the real composition once, after its network boundary. Cold module
// transformation belongs to collection, rather than an interaction's timeout.
const { SidebarUsagePopoverContent, SidebarUsagePopoverView } = await import('./SidebarUsagePopoverContent');
const { renderUsageFrame } = await import('@/components/dev/connectedServices/usageFrames');
const { storage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { Modal, ModalProvider } = await import('@/modal');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const restoreExecutorLoader = await installRealActionExecutorModuleLoader();

afterEach(async () => { await standardCleanup(); await home.reset(); });
afterAll(() => { restoreExecutorLoader(); resetRuntimeFetch(); });

describe('Usage identity privacy through real Action wiring', () => {
    it.each((['rail', 'dev-frame'] as const).flatMap(surface =>
        (['direct', 'confirm', 'cancel'] as const).map(consent => ({ surface, consent }))))(
        'routes the $surface own press through $consent consent without an approval Artifact', async ({ surface, consent }) => {
            setRuntimeFetch(home.request);
            const serverId = await home.addHome({ name: 'Usage privacy', serverUrl: 'https://usage-privacy-admission.test',
                accountId: 'privacy-owner', currentAccount: true });
            const credentials = await TokenStorage.getCredentialsForServerUrl('https://usage-privacy-admission.test', { serverId });
            if (!credentials) throw new Error('Expected the admitted Home credentials');
            const connection = await restoreServerAccountForTest({ serverUrl: 'https://usage-privacy-admission.test',
                accountId: 'privacy-owner', credentials, request: home.request });
            if (consent !== 'direct') await home.requireUiApproval(serverId, 'connectedServices.identityPrivacy.set');
            vi.mocked(Modal.show).mockClear();
            const previousRuntime = getAppliedActiveServerSnapshot();
            const previousAvailable = isAppliedActiveServerRuntimeAvailable();
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const previousHidden = storage.getState().localSettings.hideConnectedAccountIdentities;
            storage.getState().applyLocalSettings({ hideConnectedAccountIdentities: false }, { source: 'ui' });
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><ModalProvider>
                {surface === 'rail' ? <SidebarUsagePopoverContent close={() => {}} maxHeight={520} /> : renderUsageFrame('U1')}
            </ModalProvider></InjectedAuthProvider>);
            try {
                await flushHookEffects();
                // Deliberate Ask waits for the person's native confirmation, never
                // a deferred request to approve their own press.
                await act(async () => { screen.pressByTestId('usage-popover-privacy'); });
                if (consent !== 'direct') {
                    await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).toBeTruthy());
                    expect(home.artifacts(serverId).list()).toHaveLength(0);
                    expect(storage.getState().localSettings.hideConnectedAccountIdentities).toBe(false);
                    expect(screen.findAllByType(SidebarUsagePopoverView)[0]?.props.privacy.hidden).toBe(false);
                    await screen.pressByTestIdAsync(`actions.confirmation-review.decision-${consent === 'confirm' ? 'approve' : 'reject'}`);
                }
                await expect.poll(async () => {
                    await flushHookEffects();
                    return storage.getState().localSettings.hideConnectedAccountIdentities;
                }).toBe(consent !== 'cancel');
                expect(screen.findAllByType(SidebarUsagePopoverView)[0]?.props.privacy.hidden).toBe(consent !== 'cancel');
                expect(Modal.show).toHaveBeenCalledTimes(consent === 'direct' ? 0 : 1);
                expect(home.artifacts(serverId).list()).toHaveLength(0);
            } finally {
                Modal.hideAll();
                await screen.unmount();
                storage.getState().applyLocalSettings({ hideConnectedAccountIdentities: previousHidden }, { source: 'ui' });
                publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable);
                await connection.dispose();
            }
        },
    );
});
