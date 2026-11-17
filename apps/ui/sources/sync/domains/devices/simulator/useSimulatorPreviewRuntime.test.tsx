import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { SimulatorDeviceResourceV1 } from '@happier-dev/protocol/devices/simulator/v1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const testState = vi.hoisted(() => ({
    useFeatureDetails: vi.fn(),
    useFeatureDecision: vi.fn(),
    machineRpcWithServerScope: vi.fn(),
}));

vi.mock('@/hooks/server/useFeatureDetails', () => ({
    useFeatureDetails: (...args: readonly unknown[]) => testState.useFeatureDetails(...args),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (...args: readonly unknown[]) => testState.useFeatureDecision(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) => testState.machineRpcWithServerScope(...args),
}));

const browser = await installBrowserRuntimeForTests({ url: 'https://simulator-preview.test/' });
let hostVisible = true;
Object.defineProperty(browser.document, 'visibilityState', { configurable: true,
    get: () => hostVisible ? 'visible' : 'hidden' });
beforeEach(() => {
    browser.activate();
    hostVisible = true;
    browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
});
afterAll(() => browser.restore());

const availableResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'sim_1',
    platform: 'ios',
    deviceId: 'device_1',
    displayName: 'iPhone 16',
    capture: {
        status: 'available',
        sourceId: 'source_1',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: {
            requestKeyframe: false,
            snapshot: false,
            setQuality: false,
            setFps: false,
            setScale: false,
        },
    },
};

function simulatorPreviewDecision(state: 'enabled' | 'disabled') {
    return {
        featureId: 'devices.simulatorPreview',
        state,
        blockedBy: state === 'enabled' ? null : 'server',
        blockerCode: state === 'enabled' ? 'none' : 'feature_disabled',
        diagnostics: [],
        evaluatedAt: 1_000,
        scope: { scopeKind: 'runtime' },
    };
}

describe('useSimulatorPreviewSessionSurfaceRuntime', () => {
    afterEach(() => {
        vi.useRealTimers();
        testState.useFeatureDetails.mockReset();
        testState.useFeatureDecision.mockReset();
        testState.machineRpcWithServerScope.mockReset();
        standardCleanup();
    });

    it.each(['layout', 'host'] as const)('releases snapshot demand while %s is hidden and refreshes on return', async hiddenOwner => {
        vi.useFakeTimers();
        testState.useFeatureDecision.mockReturnValue(simulatorPreviewDecision('enabled'));
        testState.useFeatureDetails.mockReturnValue({
            enabled: true, available: true, supportedPlatforms: ['ios'], availableDevices: [],
            captureSupported: true, inputSupported: true, sidebandKinds: [], disabledReasons: [],
        });
        let displayName = availableResource.displayName;
        const snapshotSignals: Array<AbortSignal | undefined> = [];
        testState.machineRpcWithServerScope.mockImplementation(async (request: { signal?: AbortSignal }) => {
            snapshotSignals.push(request.signal);
            return { protocolVersion: 1, snapshot: {
                v: 1, machineId: 'machine_1', generatedAt: Date.now(), refreshState: 'idle',
                resources: [{ ...availableResource, displayName }], diagnostics: [],
            } };
        });
        let presented = true;
        const mod = await import('./useSimulatorPreviewRuntime');
        const hook = await renderHook(() => mod.useSimulatorPreviewSessionSurfaceRuntime({
            machineId: 'machine_1', serverId: 'server_1', viewerId: 'viewer_1', selectedSimulatorId: 'sim_1',
        }), { wrapper: props => <PluginSurfaceFocusEligibilityProvider active={presented}>
            {props.children}
        </PluginSurfaceFocusEligibilityProvider> });
        try {
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(snapshotSignals).toHaveLength(1);
            expect(hook.getCurrent().resources?.[0]?.displayName).toBe(displayName);
            const retainedResources = hook.getCurrent().resources;
            if (hiddenOwner === 'layout') {
                presented = false;
                await hook.rerender();
            } else {
                await act(async () => {
                    hostVisible = false;
                    browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
                });
            }
            testState.machineRpcWithServerScope.mockClear();
            await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
            expect(testState.machineRpcWithServerScope).not.toHaveBeenCalled();
            expect(snapshotSignals[0]?.aborted).toBe(true);
            expect(hook.getCurrent().resources).toBe(retainedResources);
            displayName = 'Updated simulator';
            if (hiddenOwner === 'layout') {
                presented = true;
                await hook.rerender();
            } else {
                await act(async () => {
                    hostVisible = true;
                    browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
                });
            }
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(testState.machineRpcWithServerScope).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().resources?.[0]?.displayName).toBe(displayName);
        } finally {
            await hook.unmount();
            const reads = snapshotSignals.length;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(snapshotSignals).toHaveLength(reads);
        }
    });

    it('retains a selected stream through a failed snapshot and accepts recovery or authoritative removal', async () => {
        vi.useFakeTimers();
        testState.useFeatureDecision.mockReturnValue(simulatorPreviewDecision('enabled'));
        testState.useFeatureDetails.mockReturnValue({
            enabled: true, available: true, supportedPlatforms: ['ios'], availableDevices: [],
            captureSupported: true, inputSupported: true, sidebandKinds: [], disabledReasons: [],
        });
        let refreshState: 'idle' | 'error' = 'idle';
        let resources: readonly SimulatorDeviceResourceV1[] = [availableResource];
        // The daemon RPC is the network boundary; state, selection, and stream projection stay real.
        testState.machineRpcWithServerScope.mockImplementation(async () => ({
            protocolVersion: 1, snapshot: {
                v: 1, machineId: 'machine_1', generatedAt: Date.now(), refreshState,
                resources, diagnostics: [],
            },
        }));
        const mod = await import('./useSimulatorPreviewRuntime');
        const hook = await renderHook(() => mod.useSimulatorPreviewSessionSurfaceRuntime({
            machineId: 'machine_1', serverId: 'server_1', viewerId: 'viewer_1', selectedSimulatorId: 'sim_1',
            previewStatesBySimulatorId: { sim_1: {
                phase: 'reconnecting',
                lastFrame: {
                    v: 1, streamId: 'stream_1', sequence: 1, timestampMs: 1_000,
                    payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64',
                    payloadBase64: 'AQID', payloadSizeBytes: 3,
                },
            } },
        }));
        try {
            await flushHookEffects({ cycles: 2, turns: 2 });
            const selectedStream = hook.getCurrent().viewModel?.stream;
            expect(selectedStream?.lastFrameUrl).toBe('data:image/jpeg;base64,AQID');
            expect(hook.getCurrent().selectedSimulatorId).toBe('sim_1');
            refreshState = 'error';
            resources = [];
            await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
            expect(hook.getCurrent().viewModel).toMatchObject({ kind: 'selected', resource: availableResource });
            expect(hook.getCurrent().viewModel?.stream).toEqual(selectedStream);
            refreshState = 'idle';
            resources = [{ ...availableResource, displayName: 'Recovered simulator' }];
            await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
            expect(hook.getCurrent().viewModel?.resource?.displayName).toBe('Recovered simulator');
            resources = [];
            await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
            expect(hook.getCurrent().viewModel).toMatchObject({ kind: 'empty', resource: null });
        } finally {
            await hook.unmount();
        }
    });

    it('projects server simulator capabilities into a runtime and dispatches typed API events', async () => {
        testState.useFeatureDecision.mockReturnValue(simulatorPreviewDecision('enabled'));
        testState.useFeatureDetails.mockReturnValue({
            enabled: true,
            available: true,
            supportedPlatforms: ['ios'],
            availableDevices: [availableResource],
            captureSupported: true,
            inputSupported: true,
            sidebandKinds: ['capture_health'],
            disabledReasons: [],
        });
        const dispatch = vi.fn();
        const mod = await import('./useSimulatorPreviewRuntime');

        const hook = await renderHook(() => mod.useSimulatorPreviewSessionSurfaceRuntime({
            serverId: 'server_1',
            viewerId: 'viewer_1',
            selectedSimulatorId: 'sim_1',
            dispatch,
            nowMs: () => 1_000,
        }));

        expect(testState.useFeatureDetails).toHaveBeenCalledWith(expect.objectContaining({
            featureId: 'devices.simulatorPreview',
            scope: { scopeKind: 'spawn', serverId: 'server_1' },
        }));
        expect(hook.getCurrent().viewModel?.selectedSimulatorId).toBe('sim_1');
        expect(hook.getCurrent().resources).toEqual([availableResource]);

        await act(async () => {
            await hook.getCurrent().actions?.openStream?.();
        });
        await hook.getCurrent().actions?.requestSideband?.('capture_health');

        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'simulator.stream.open',
        }));
        expect(dispatch).toHaveBeenCalledWith({
            type: 'simulator.sideband.request',
            simulatorId: 'sim_1',
            kind: 'capture_health',
        });
    });

    it('maps browser target device ids back to simulator ids before building actions', async () => {
        testState.useFeatureDecision.mockReturnValue(simulatorPreviewDecision('enabled'));
        testState.useFeatureDetails.mockReturnValue({
            enabled: true,
            available: true,
            supportedPlatforms: ['ios'],
            availableDevices: [availableResource],
            captureSupported: true,
            inputSupported: true,
            sidebandKinds: [],
            disabledReasons: [],
        });
        const dispatch = vi.fn();
        const mod = await import('./useSimulatorPreviewRuntime');

        const hook = await renderHook(() => mod.useSimulatorPreviewSessionSurfaceRuntime({
            viewerId: 'viewer_1',
            selectedDeviceId: 'device_1',
            dispatch,
        }));

        expect(hook.getCurrent().viewModel?.selectedSimulatorId).toBe('sim_1');
        await hook.getCurrent().actions?.openStream?.();
        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'simulator.stream.open',
        }));
    });

    it.each([true, false])('loads daemon simulator snapshots with server capability enabled=%s', async capabilityEnabled => {
        testState.useFeatureDecision.mockReturnValue(simulatorPreviewDecision('enabled'));
        testState.useFeatureDetails.mockReturnValue({
            enabled: capabilityEnabled,
            available: capabilityEnabled,
            supportedPlatforms: ['ios'],
            availableDevices: [],
            captureSupported: true,
            inputSupported: true,
            sidebandKinds: ['capture_health'],
            disabledReasons: [],
        });
        testState.machineRpcWithServerScope.mockImplementation(async (params: { method?: string; payload?: unknown }) => {
            if (params.method === 'daemon.devices.simulator.preview.snapshot') {
                return {
                    protocolVersion: 1,
                    snapshot: {
                        v: 1,
                        machineId: 'machine_1',
                        generatedAt: 1_000,
                        refreshState: 'idle',
                        resources: [availableResource],
                        diagnostics: [],
                    },
                };
            }
            if (params.method === 'daemon.devices.simulator.preview.action') {
                return {
                    protocolVersion: 1,
                    result: {
                        v: 1,
                        eventType: 'simulator.stream.open',
                        status: 'accepted',
                        diagnostics: [],
                    },
                };
            }
            throw new Error(`unexpected method ${params.method}`);
        });
        const mod = await import('./useSimulatorPreviewRuntime');

        const hook = await renderHook(() => mod.useSimulatorPreviewSessionSurfaceRuntime({
            machineId: 'machine_1',
            serverId: 'server_1',
            viewerId: 'viewer_1',
            selectedSimulatorId: 'sim_1',
            refreshIntervalMs: null,
            nowMs: () => 1_000,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(testState.machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: 'daemon.devices.simulator.preview.snapshot',
            payload: { machineId: 'machine_1' },
        }));
        expect(hook.getCurrent().resources).toEqual([availableResource]);
        expect(hook.getCurrent().viewModel?.selectedSimulatorId).toBe('sim_1');

        testState.machineRpcWithServerScope.mockClear();
        await hook.getCurrent().actions?.openStream?.();
        expect(testState.machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('fails closed when the canonical simulator feature decision is disabled even if capabilities claim availability', async () => {
        testState.useFeatureDecision.mockReturnValue(simulatorPreviewDecision('disabled'));
        testState.useFeatureDetails.mockReturnValue({
            enabled: true,
            available: true,
            supportedPlatforms: ['ios'],
            availableDevices: [availableResource],
            captureSupported: true,
            inputSupported: true,
            sidebandKinds: ['capture_health'],
            disabledReasons: [],
        });
        const actionClient = vi.fn(async () => ({
            ok: true as const,
            result: {
                v: 1 as const,
                eventType: 'simulator.stream.open' as const,
                status: 'accepted' as const,
                diagnostics: [],
            },
        }));
        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: {
                v: 1 as const,
                machineId: 'machine_1',
                generatedAt: 1_000,
                refreshState: 'idle' as const,
                resources: [availableResource],
                diagnostics: [],
            },
        }));
        const mod = await import('./useSimulatorPreviewRuntime');

        const hook = await renderHook(() => mod.useSimulatorPreviewSessionSurfaceRuntime({
            machineId: 'machine_1',
            serverId: 'server_1',
            viewerId: 'viewer_1',
            selectedSimulatorId: 'sim_1',
            refreshIntervalMs: null,
            nowMs: () => 1_000,
            snapshotClient,
            actionClient,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(testState.useFeatureDecision).toHaveBeenCalledWith(
            'devices.simulatorPreview',
            { scopeKind: 'spawn', serverId: 'server_1' },
        );
        expect(snapshotClient).not.toHaveBeenCalled();
        expect(hook.getCurrent().resources).toEqual([]);
        expect(hook.getCurrent().viewModel?.kind).toBe('empty');

        await hook.getCurrent().actions?.openStream?.();

        expect(actionClient).not.toHaveBeenCalled();
    });
});
