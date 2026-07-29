import { describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

const cacheIdentity = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.2.0',
    reactNativeVersion: '0.83.4',
    platform: 'ios',
    channel: 'internal',
    nativeCapabilitiesDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    projectionGeneration: 12,
} as const;

describe('React Native crash-disable report machine RPC client', () => {
    it('sends typed crash-disable reports to the owning daemon', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            ok: true,
            contributionKey: 'acme.preview:native-preview',
            disabled: true,
        });
        const { reportReactNativeCrashDisableViaMachineRpc } = await import('./reactNativeCrashReports');

        await expect(reportReactNativeCrashDisableViaMachineRpc({
            machineId: 'machine-1',
            serverId: 'server-1',
            surfaceId: 'surface_1',
            cacheIdentity,
            disabledReason: 'render_error_threshold',
            crashCount: 2,
            startupFailureCount: 0,
            observedAtMs: 1_000,
            diagnostics: ['threshold_reached'],
        })).resolves.toEqual({
            ok: true,
            disabled: true,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: 'daemon.plugins.ui.reactNativeCrashReports.submit',
            payload: {
                protocolVersion: 1,
                machineId: 'machine-1',
                report: {
                    surfaceId: 'surface_1',
                    cacheIdentity,
                    disabledReason: 'render_error_threshold',
                    crashCount: 2,
                    startupFailureCount: 0,
                    observedAtMs: 1_000,
                    diagnostics: ['threshold_reached'],
                },
            },
        });
    });

    it('returns unavailable when the daemon does not support crash reports yet', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            errorCode: 'RPC_METHOD_NOT_FOUND',
            error: 'Method not found',
        });
        const { reportReactNativeCrashDisableViaMachineRpc } = await import('./reactNativeCrashReports');

        await expect(reportReactNativeCrashDisableViaMachineRpc({
            machineId: 'machine-1',
            surfaceId: 'surface_1',
            cacheIdentity,
            disabledReason: 'startup_ack_timeout_threshold',
            crashCount: 0,
            startupFailureCount: 1,
        })).resolves.toEqual({
            ok: false,
            reason: 'unavailable',
        });
    });
});
