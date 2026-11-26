import { afterEach, expect, it, vi } from 'vitest';
import { COMPUTER_PROVIDER_INSTALLABLE_KEYS } from '@happier-dev/protocol/computer/v1';
import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';

const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { Modal } = await import('@/modal');
const { t } = await import('@/text');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useComputerDriverRepair } = await import('./useComputerDriverRepair');
afterEach(async () => { await standardCleanup(); await account.reset(); rpc.reset(); });

it.each(['daemon-refusal', 'native-install'] as const)('shows the driver repair failure from %s without private installer output', async delivery => {
    const [machine] = rpc.state.machines;
    const scope = await account.restore({ machines: rpc.state.machines, currentAccount: true, waivedActions: ['machines.capabilities.install'] });
    const capabilityId = BUILT_IN_INSTALLABLES_REGISTRY.descriptorsByKey[COMPUTER_PROVIDER_INSTALLABLE_KEYS['agent-desktop']].descriptor.capabilityId;
    const failure = { ok: false, errorCode: 'action_forbidden', error: 'Private driver installer diagnostic',
        requestId: 'computer-repair-refusal', effectAttempted: false,
        failureCause: { phase: 'action.owner', errorClass: 'HttpStatusError', errorCode: 'forbidden', httpStatus: 403 },
    } as const;
    rpc.setResponse(RPC_METHODS.CAPABILITIES_INVOKE, { ok: false, error: { code: failure.errorCode, message: failure.error } });
    if (delivery === 'daemon-refusal') {
        rpc.transformAcknowledgement(RPC_METHODS.CAPABILITIES_INVOKE, (_request, acknowledgement) => ({
            ...acknowledgement, result: failure,
        }));
    }
    const target = { serverId: scope.serverId, sessionId: 'repair-session', machineId: machine!.id };
    if (delivery === 'daemon-refusal') {
        const { machineCapabilitiesInvoke } = await import('@/sync/ops/capabilities');
        expect(await machineCapabilitiesInvoke(target.machineId, { id: capabilityId, method: 'install' },
            { serverId: scope.serverId, accountId: scope.accountId })).toMatchObject({ supported: false, actionFailure: failure });
    }
    const beforeRepair = rpc.state.requests.length;
    const alert = vi.spyOn(Modal, 'alert').mockImplementation(() => undefined);
    const hook = await renderHook(() => {
        const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
        const repair = useComputerDriverRepair(target, binding, () => {}, {
            cause: 'driver_missing', action: 'repair_driver', installHint: { actionId: 'machines.capabilities.install', capabilityId },
        });
        return { repair, ready: binding?.isCurrent() === true };
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
        await act(async () => { hook.getCurrent().repair.repair(); });
        await vi.waitFor(() => expect(rpc.state.requests.slice(beforeRepair).some(request => request.method === RPC_METHODS.CAPABILITIES_INVOKE)).toBe(true));
        await vi.waitFor(() => expect(alert.mock.calls[0]?.[1]).toBe(t('errors.permissionDenied')));
        const details = alert.mock.calls[0]?.[2]?.find(button => button.text === t('approvals.technicalDetails'));
        expect(details).toBeDefined();
        details?.onPress?.();
        if (delivery === 'daemon-refusal') {
            const technicalDetails = alert.mock.calls[1]?.[1];
            // Public Action settlement owns its invocation ID; the underlying RPC ID survives at the Invoke boundary.
            expect(technicalDetails).toMatch(/Request ID: [0-9a-f-]{36}/);
            expect(technicalDetails).toContain('Effect attempted: false');
            expect(technicalDetails).toContain(failure.failureCause.phase);
            expect(technicalDetails).toContain(failure.failureCause.errorCode);
        }
        expect(alert.mock.calls[1]?.[1]).not.toContain(failure.error);
    } finally {
        await hook.unmount();
        alert.mockRestore();
    }
});
