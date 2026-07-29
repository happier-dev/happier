import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { ServerScopedMachineLiveStreamRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket';

const testState = vi.hoisted(() => ({
    useFeatureDecision: vi.fn(),
    resolveSocket: vi.fn(),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (...args: readonly unknown[]) => testState.useFeatureDecision(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket', () => ({
    resolveServerScopedMachineLiveStreamRelaySocket: (
        ...args: readonly unknown[]
    ) => testState.resolveSocket(...args),
}));

function fakeSocket(disconnect: () => void): ServerScopedMachineLiveStreamRelaySocket {
    return {
        scopeUserId: 'user_1',
        machineId: 'daemon_1',
        viewerId: 'user_1',
        socketId: 'viewer-socket-1',
        sendEnvelope: vi.fn(),
        onEnvelope: vi.fn(() => () => {}),
        disconnect,
    };
}

describe('useSimulatorLiveStreamRelaySocket', () => {
    afterEach(() => {
        testState.useFeatureDecision.mockReset();
        testState.resolveSocket.mockReset();
        standardCleanup();
    });

    it('resolves the relay socket when the feature is enabled and a machine id is present', async () => {
        testState.useFeatureDecision.mockReturnValue({ state: 'enabled' });
        const disconnect = vi.fn();
        testState.resolveSocket.mockResolvedValue(fakeSocket(disconnect));
        const mod = await import('./useSimulatorLiveStreamRelaySocket');

        const hook = await renderHook(() => mod.useSimulatorLiveStreamRelaySocket({
            machineId: 'daemon_1',
            serverId: 'server_1',
        }));

        expect(testState.resolveSocket).toHaveBeenCalledWith({ machineId: 'daemon_1', serverId: 'server_1' });
        expect(hook.getCurrent()?.machineId).toBe('daemon_1');

        await hook.unmount();
        expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('stays null and opens no socket while the feature gate is disabled', async () => {
        testState.useFeatureDecision.mockReturnValue({ state: 'disabled' });
        const mod = await import('./useSimulatorLiveStreamRelaySocket');

        const hook = await renderHook(() => mod.useSimulatorLiveStreamRelaySocket({
            machineId: 'daemon_1',
            serverId: 'server_1',
        }));

        expect(hook.getCurrent()).toBeNull();
        expect(testState.resolveSocket).not.toHaveBeenCalled();
    });

    it('stays null when no machine id is available even if the gate is enabled', async () => {
        testState.useFeatureDecision.mockReturnValue({ state: 'enabled' });
        const mod = await import('./useSimulatorLiveStreamRelaySocket');

        const hook = await renderHook(() => mod.useSimulatorLiveStreamRelaySocket({
            machineId: null,
            serverId: 'server_1',
        }));

        expect(hook.getCurrent()).toBeNull();
        expect(testState.resolveSocket).not.toHaveBeenCalled();
    });
});
