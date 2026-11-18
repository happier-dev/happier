import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { COMPUTER_PROVIDER_INSTALLABLE_KEYS } from '@happier-dev/protocol/computer/v1';
import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';

const boundary = vi.hoisted(() => ({ execute: vi.fn() }));
// The public Action front door is the only mocked execution boundary.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => boundary.execute, createFrontDoorUiActionExecutor: () => boundary.execute }));
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useComputerTargetPicker } = await import('./useComputerTargetPicker');
const { useComputerDriverRepair } = await import('./useComputerDriverRepair');
const { createComputerRuntimeActionExecutor } = await import('@/sync/domains/computer/actions/runtimeActionExecutor');
afterEach(async () => { await standardCleanup(); await account.reset(); boundary.execute.mockReset(); });

it.each(['computer_provider_unavailable', 'action_disabled'] as const)('preserves provider repair or policy refusal through Computer dispatch: %s', async errorCode => {
    const scope = await account.restore({ machines: [], currentAccount: true });
    const capabilityId = BUILT_IN_INSTALLABLES_REGISTRY.descriptorsByKey[COMPUTER_PROVIDER_INSTALLABLE_KEYS['agent-desktop']].descriptor.capabilityId;
    const runtime = createComputerRuntimeActionExecutor({
        executeOnMachine: async () => ({ ok: false, errorCode, error: 'Unavailable',
            provider: 'agent-desktop', capabilityId, installHint: { actionId: 'machines.capabilities.install', capabilityId } }),
        fallback: async () => { throw new Error('Unexpected Action'); },
    });
    boundary.execute.mockResolvedValue({ ok: false, errorCode: 'action_disabled', error: 'Disabled by policy' });
    const { execute } = createActionExecutor({ runtimeActionExecute: runtime } as ActionExecutorDeps);
    const hook = await renderHook(() => {
        const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
        const picker = useComputerTargetPicker({ scope: { serverId: scope.serverId, sessionId: 'repair-session', machineId: 'machine' },
            execute, currentTargetKey: null, onSelected: () => {}, onClose: () => {} });
        const repair = useComputerDriverRepair({ serverId: scope.serverId, sessionId: 'repair-session', machineId: 'machine' },
            binding, picker.retry, picker.recovery);
        return { picker, repair, ready: binding?.isCurrent() === true };
    });
    await vi.waitFor(() => {
        expect(hook.getCurrent().picker.state.kind).toBe('failed');
        expect(hook.getCurrent().ready).toBe(true);
    });
    await act(async () => { hook.getCurrent().repair.repair(); });
    if (errorCode === 'action_disabled') {
        expect(hook.getCurrent().picker.state).toMatchObject({ kind: 'failed', code: errorCode });
        expect(hook.getCurrent().picker.recovery?.action).not.toBe('repair_driver');
        expect(boundary.execute).not.toHaveBeenCalled();
    } else {
        await vi.waitFor(() => expect(boundary.execute).toHaveBeenCalledWith('machines.capabilities.install',
            expect.objectContaining({ capabilityId, method: 'install' }), expect.anything()));
        expect(boundary.execute.mock.calls[0]?.[1]).toMatchObject({ machineId: 'machine', serverId: scope.serverId });
    }
    await hook.unmount();
});
