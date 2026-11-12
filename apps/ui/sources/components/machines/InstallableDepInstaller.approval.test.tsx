import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPUTER_CUA_DRIVER_DEP_ID } from '@happier-dev/protocol/installables';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), confirm: vi.fn(async () => false), alert: vi.fn() }));
// Native rendering/dialogs and daemon RPC are system boundaries. The Action
// policy, mounted review and execution lifecycle remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    renderCustomModals: true,
    settleTransientConfirmations: false,
    spies: { confirm: boundary.confirm, alert: boundary.alert },
}).module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { InstallableDepInstaller } = await import('./InstallableDepInstaller');
const { useComputerDriverRepair } = await import('@/components/computer/useComputerDriverRepair');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { ModalProvider } = await import('@/modal');

async function addInstallerHome(policy: 'Allowed' | 'Ask-first') {
    const profileId = await harness.addHome({ name: 'Installer Home', serverUrl: 'https://installer-policy.test',
        serverIdentityId: 'srv_installer_policy', accountId: 'alice', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(profileId);
    const scope = { serverId, accountId: 'alice' };
    const settings = { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.capabilities.install': ['ui'] } }) };
    storage.setState({ settingsScope: scope, profileScope: scope, settings: { ...storage.getState().settings, ...settings } });
    harness.answer(profileId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    if (policy === 'Ask-first') await harness.requireUiApproval(profileId, 'machines.capabilities.install');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected the admitted Account lifetime');
    return { profileId, serverId, lifetime };
}

describe('install and Computer repair share configurable Action approval', () => {
    beforeEach(async () => { await harness.reset(); boundary.rpc.mockReset(); boundary.confirm.mockClear(); boundary.alert.mockClear(); });
    afterEach(() => standardCleanup());

    it.each([
        { caller: 'repair', policy: 'Allowed' }, { caller: 'repair', policy: 'Ask-first' },
        { caller: 'installer', policy: 'Allowed' }, { caller: 'installer', policy: 'Ask-first' },
    ] as const)('$caller honors $policy with no leaf-owned confirmation or approval bypass', async ({ caller, policy }) => {
        const { profileId, serverId, lifetime } = await addInstallerHome(policy);
        boundary.rpc.mockResolvedValue({ ok: true, result: { logPath: null } });
        const refresh = vi.fn();
        const hook = await renderHook(() => ({ binding: useServerCredentialAccountScopeBinding(serverId),
            repair: useComputerDriverRepair({ serverId, machineId: 'machine', sessionId: 'session' }, lifetime, refresh) }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding.binding?.isCurrent()).toBe(true));
        const screen = caller === 'installer' ? await renderSettingsView(<InstallableDepInstaller
            machineId="machine" serverId={serverId} enabled groupTitle="Dependencies" depId={COMPUTER_CUA_DRIVER_DEP_ID}
            depTitle="Native driver" depIconName="wrench" depStatus={null} capabilitiesStatus="loaded"
            installLabels={{ install: 'Install', update: 'Update', reinstall: 'Reinstall' }}
            installModal={{ installTitle: 'Install', updateTitle: 'Update', reinstallTitle: 'Reinstall', description: 'Native driver' }}
            refreshStatus={refresh} />) : null;
        const modalScreen = policy === 'Ask-first' ? await renderScreen(<ModalProvider />) : null;
        await flushHookEffects({ cycles: 4 });
        await act(async () => { if (screen) screen.pressRowByTitle('Install'); else hook.getCurrent().repair.repair(); });
        expect(boundary.confirm).not.toHaveBeenCalled();
        expect(boundary.alert.mock.calls.some(args => Array.isArray(args[2]))).toBe(false);
        if (policy === 'Ask-first') {
            if (!modalScreen) throw new Error('Expected the mounted confirmation review');
            await vi.waitFor(() => expect(modalScreen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
            expect(harness.artifacts(profileId).list()).toEqual([]);
            expect(boundary.rpc).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
            await modalScreen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
        }
        await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalled());
        if (caller === 'installer' && policy === 'Allowed') expect(boundary.alert).toHaveBeenCalledWith('common.success', 'deps.installed');
        expect(boundary.rpc.mock.calls).toHaveLength(1);
        expect(boundary.rpc.mock.calls[0]?.[0]).toMatchObject({ serverId, machineId: 'machine',
            method: RPC_METHODS.CAPABILITIES_INVOKE, payload: { id: COMPUTER_CUA_DRIVER_DEP_ID, method: 'install' } });
        expect(harness.artifacts(profileId).list()).toEqual([]);
        await modalScreen?.unmount();
        await screen?.unmount();
        await hook.unmount();
    });

    it('distinguishes a failed capability invocation from an unsupported capability', async () => {
        const { serverId, lifetime } = await addInstallerHome('Allowed');
        boundary.rpc.mockResolvedValue({ error: 'daemon failure' });
        const refresh = vi.fn();
        const hook = await renderHook(() => ({ binding: useServerCredentialAccountScopeBinding(serverId),
            repair: useComputerDriverRepair({ serverId, machineId: 'machine', sessionId: 'session' }, lifetime, refresh) }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding.binding?.isCurrent()).toBe(true));
        await act(async () => hook.getCurrent().repair.repair());
        await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalled());
        expect(boundary.alert).toHaveBeenCalledWith('common.error', 'deps.installFailed');
        expect(boundary.alert).not.toHaveBeenCalledWith('common.error', 'deps.installNotSupported');
        await hook.unmount();
    });
});
