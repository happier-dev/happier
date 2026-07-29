import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { useMachineCapabilityInvokeWithAlerts } from './useMachineCapabilityInvokeWithAlerts';

const machineCapabilitiesInvokeMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/capabilities', () => ({
    machineCapabilitiesInvoke: (...args: unknown[]) => machineCapabilitiesInvokeMock(...args),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: (...args: unknown[]) => modalAlertMock(...args),
    },
}));

afterEach(() => {
    standardCleanup();
    machineCapabilitiesInvokeMock.mockReset();
    modalAlertMock.mockReset();
});

describe('useMachineCapabilityInvokeWithAlerts', () => {
    it('returns a successful intermediate result without announcing completion when successMessage is null', async () => {
        machineCapabilitiesInvokeMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    change: {
                        kind: 'reviewRequired',
                        pendingChangeId: 'pending-1',
                    },
                },
            },
        });
        const hook = await renderHook(() => useMachineCapabilityInvokeWithAlerts());

        await act(async () => {
            await hook.getCurrent().invokeWithAlerts({
                machineId: 'machine-1',
                request: {
                    id: 'tool.plugins',
                    method: 'install',
                    params: { pluginId: 'example.plugin', sourceId: 'marketplace:community-npm' },
                },
                alerts: {
                    errorTitle: 'Error',
                    successTitle: 'Success',
                    successMessage: null,
                    unsupportedMessage: () => 'Unavailable',
                },
            });
        });

        expect(modalAlertMock).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not announce a completion after the caller authority is retired', async () => {
        let current = true;
        machineCapabilitiesInvokeMock.mockImplementation(async () => {
            current = false;
            return {
                supported: true,
                response: {
                    ok: true,
                    result: { action: 'pack' },
                },
            };
        });
        const hook = await renderHook(() => useMachineCapabilityInvokeWithAlerts());

        await act(async () => {
            await hook.getCurrent().invokeWithAlerts({
                machineId: 'machine-1',
                request: {
                    id: 'tool.plugins',
                    method: 'pack',
                    params: { pluginId: 'example.plugin' },
                },
                isAuthorityCurrent: () => current,
                alerts: {
                    errorTitle: 'Error',
                    successTitle: 'Success',
                    successMessage: 'Packed',
                    unsupportedMessage: () => 'Unavailable',
                },
            });
        });

        expect(modalAlertMock).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it.each([
        ['an explicit outcome-unknown response', async () => ({
            supported: true,
            response: {
                ok: false,
                error: { code: 'outcomeUnknown', message: 'Commit outcome is unknown' },
            },
        })],
        ['commit-intended transport loss', async () => {
            throw new Error('Connection closed after send');
        }],
    ])('defers %s to the caller reconciliation owner without a false failure alert', async (_label, invoke) => {
        machineCapabilitiesInvokeMock.mockImplementationOnce(invoke);
        const hook = await renderHook(() => useMachineCapabilityInvokeWithAlerts());

        await act(async () => {
            await hook.getCurrent().invokeWithAlerts({
                machineId: 'machine-1',
                request: {
                    id: 'tool.plugins',
                    method: 'uninstall',
                    params: { pluginId: 'example.plugin' },
                },
                alerts: {
                    errorTitle: 'Error',
                    successTitle: 'Success',
                    successMessage: null,
                    deferAmbiguousOutcomeToCaller: true,
                    unsupportedMessage: () => 'Unavailable',
                },
            });
        });

        expect(modalAlertMock).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
