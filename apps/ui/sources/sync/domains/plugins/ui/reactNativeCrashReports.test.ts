import { describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

const token = {
    mount: {
        kind: 'destination',
        destination: {
            pluginId: 'acme.preview',
            localId: 'preview-destination',
        },
    },
    renderer: {
        pluginId: 'acme.preview',
        localId: 'native-preview',
    },
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    crashStateEpoch: 4,
} as const;

describe('React Native crash-state machine RPC client', () => {
    it('sends one exact failure occurrence to the daemon and returns its current binding state', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            ok: true,
            token,
            disabled: false,
        });
        const { submitReactNativeCrashReportViaMachineRpc } = await import('./reactNativeCrashReports');

        await expect(submitReactNativeCrashReportViaMachineRpc({
            machineId: 'machine-1',
            serverId: 'server-1',
            report: {
                kind: 'reportFailure',
                token,
                failureOccurrenceId: '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
                failure: 'render_error',
            },
        })).resolves.toEqual({
            ok: true,
            token,
            disabled: false,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: 'daemon.plugins.ui.reactNativeCrashReports.submit',
            payload: {
                protocolVersion: 1,
                machineId: 'machine-1',
                report: {
                    kind: 'reportFailure',
                    token,
                    failureOccurrenceId: '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
                    failure: 'render_error',
                },
            },
        });
    });

    it('preserves the exact binding token for an explicit daemon reset', async () => {
        const resetToken = { ...token, crashStateEpoch: 5 } as const;
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            ok: true,
            token: resetToken,
            disabled: false,
        });
        const { submitReactNativeCrashReportViaMachineRpc } = await import('./reactNativeCrashReports');

        await expect(submitReactNativeCrashReportViaMachineRpc({
            machineId: 'machine-1',
            report: { kind: 'reset', token },
        })).resolves.toEqual({
            ok: true,
            token: resetToken,
            disabled: false,
        });
    });

    it('returns unavailable when the daemon does not support crash reports', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            errorCode: 'RPC_METHOD_NOT_FOUND',
            error: 'Method not found',
        });
        const { submitReactNativeCrashReportViaMachineRpc } = await import('./reactNativeCrashReports');

        await expect(submitReactNativeCrashReportViaMachineRpc({
            machineId: 'machine-1',
            report: { kind: 'reset', token },
        })).resolves.toEqual({
            ok: false,
            reason: 'unavailable',
        });
    });
});
