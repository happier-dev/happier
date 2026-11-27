import { afterEach, expect, it, vi } from 'vitest';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import {
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';

const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { machineCapabilitiesDetect } = await import('@/sync/ops/capabilities');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useInstallableDepInstall } = await import('./useInstallableDepInstall');
afterEach(async () => {
    await standardCleanup();
    await account.reset();
    rpc.reset();
});

it.each([true, false])('refreshes installed state with one detect request after installation (version check=%s)', async (versionCheck) => {
    const machine = rpc.state.machines[0]!;
    const scope = await account.restore({ machines: rpc.state.machines, currentAccount: true, waivedActions: ['machines.capabilities.install'] });
    rpc.setResponse(RPC_METHODS.CAPABILITIES_INVOKE, { ok: true, result: {} });
    const installed = { installed: true, installedVersion: '1.0.0' };
    const detected = versionCheck ? { ...installed, latestVersionCheck: { ok: true, latestVersion: '1.0.0', label: null } } : installed;
    rpc.setResponse(RPC_METHODS.CAPABILITIES_DETECT, {
        protocolVersion: 1, results: { [CODEX_ACP_DEP_ID]: { ok: true, checkedAt: Date.now(), data: detected } },
    });
    const versionParams = { includeLatestVersion: true, onlyIfInstalled: true };
    const detects: ReturnType<typeof machineCapabilitiesDetect>[] = [];
    const refresh = (params?: { includeLatestVersion: boolean; onlyIfInstalled: boolean }) => {
        detects.push(machineCapabilitiesDetect(machine.id, { requests: [{ id: CODEX_ACP_DEP_ID, ...(params ? { params } : {}) }] }, scope));
    };
    const hook = await renderHook(() => {
        const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
        const installer = useInstallableDepInstall({
            machineId: machine.id, serverId: scope.serverId, depId: CODEX_ACP_DEP_ID,
            depStatus: null, refreshStatus: () => refresh(),
            ...(versionCheck ? { refreshLatestVersion: () => refresh(versionParams) } : {}),
        });
        return { installer, ready: binding?.isCurrent() === true };
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
        const before = rpc.state.requests.length;
        await act(async () => { await hook.getCurrent().installer.run(); });
        const responses = await Promise.all(detects);
        const requests = rpc.state.requests.slice(before);
        expect(requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_INVOKE)).toHaveLength(1);
        expect(requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)).toMatchObject([
            { payload: { requests: [{ id: CODEX_ACP_DEP_ID, ...(versionCheck ? { params: versionParams } : {}) }] } },
        ]);
        expect(responses).toMatchObject([{ supported: true, response: { results: { [CODEX_ACP_DEP_ID]: { ok: true, data: detected } } } }]);
    } finally {
        await hook.unmount();
    }
});
