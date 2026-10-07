import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    DaemonSimulatorPreviewSnapshotRequestV1Schema, DaemonSimulatorPreviewSnapshotResponseV1Schema,
    DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES, SimulatorPreviewSnapshotV1Schema,
} from '@happier-dev/protocol';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createMachineFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { SimulatorPreviewSnapshotClientInput } from '@/sync/domains/devices/simulator/machineRpc';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
const snapshot = SimulatorPreviewSnapshotV1Schema.parse({
    v: 1, machineId: 'machine-1', generatedAt: 1_000, refreshState: 'idle',
    resources: ['sim_1', 'sim_2'].map((simulatorId) => ({
        v: 1, simulatorId, platform: 'ios', deviceId: `device_${simulatorId}`,
        displayName: `iPhone ${simulatorId}`, capture: {
            status: 'available', sourceId: `source_${simulatorId}`,
            supportedCodecs: ['image.mjpeg'], inputMode: 'exclusive',
        },
    })),
});
const rpcRequests: Array<{ method: string; params: unknown }> = [];
const runtime = installSessionPaneRuntimeTestHarness({
    features: () => createRootLayoutFeaturesResponse({
        features: { devices: { simulatorPreview: { enabled: true } } },
        capabilities: { devices: { simulatorPreview: {
            ...DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
            enabled: true, available: true, availableDevices: snapshot.resources,
        } } },
    }),
    configureSocket: (socket) => {
        // Deliver the remote handshake through the real listeners and replace only its wire.
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true;
            socket.id = 'simulator-viewer-socket';
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.spyOn(socket, 'disconnect').mockImplementation(() => {
            socket.connected = false;
            for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
            return socket;
        });
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
            if (event !== 'rpc-call') throw new Error(`Unexpected simulator transport event: ${event}`);
            const request = z.object({ method: z.string(), params: z.unknown() }).passthrough().parse(payload);
            const method = request.method.slice(request.method.indexOf(':') + 1);
            rpcRequests.push({ method, params: request.params });
            if (method === RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT) {
                const input = DaemonSimulatorPreviewSnapshotRequestV1Schema.parse(request.params);
                expect(input.machineId).toBe('machine-1');
                return { ok: true, result: DaemonSimulatorPreviewSnapshotResponseV1Schema.parse({ protocolVersion: 1, snapshot }) };
            }
            return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
    },
});
beforeEach(() => {
    rpcRequests.length = 0;
    storage.getState().applySettingsLocal({ experiments: true });
    storage.getState().applyMachines([createMachineFixture({ activeAt: Date.now() })]);
});
const nowMs = () => 1_000;
const simulatorTab = {
    key: 'simulator:preview', kind: 'simulatorPreview', title: 'Simulator',
    resource: { kind: 'simulatorPreview', viewerId: 'viewer_1', selectedSimulatorId: 'sim_1' },
};

describe('SessionDetailsPanel simulator runtime wiring', () => {
    it('renders the live daemon snapshot and preserves device selection through real actions', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionSimulatorPreviewPane } = await import('@/components/sessions/simulator/SessionSimulatorPreviewPane');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" nowMs={nowMs} />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(simulatorTab, { intent: 'pinned' }));
        await flushHookEffects({ cycles: 30 });
        const initial = screen.tree.findByType(SessionSimulatorPreviewPane);
        expect(initial.props.viewModel.devices.map((device: { simulatorId: string }) => device.simulatorId)).toEqual(['sim_1', 'sim_2']);
        expect(initial.props.viewModel.selectedSimulatorId).toBe('sim_1');
        expect(rpcRequests.some(request => request.method === RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT)).toBe(true);
        await screen.pressByTestIdAsync('session-simulator:s1-preview-picker-device:sim_2');
        expect(screen.tree.findByType(SessionSimulatorPreviewPane).props.viewModel.selectedSimulatorId).toBe('sim_2');
    });

    it('uses a supplied canonical runtime without duplicating the live daemon side effects', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionSimulatorPreviewPane } = await import('@/components/sessions/simulator/SessionSimulatorPreviewPane');
        const { useSimulatorPreviewSessionSurfaceRuntime } = await import('@/sync/domains/devices/simulator/useSimulatorPreviewRuntime');
        const requested: SimulatorPreviewSnapshotClientInput[] = [];
        // This host owns an explicit runtime and substitutes the daemon snapshot RPC port.
        const snapshotClient = async (input: SimulatorPreviewSnapshotClientInput) => {
            requested.push(input);
            return { ok: true as const, snapshot };
        };
        function ControlledPanel() {
            const explicit = useSimulatorPreviewSessionSurfaceRuntime({
                machineId: 'machine-1', serverId: runtime.serverId, viewerId: 'explicit-viewer',
                selectedSimulatorId: 'sim_1', nowMs, snapshotClient,
            });
            return <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1"
                nowMs={nowMs} simulatorPreview={explicit} />;
        }
        const screen = await renderScreen(<runtime.Wrapper><ControlledPanel /></runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(simulatorTab, { intent: 'pinned' }));
        await flushHookEffects({ cycles: 30 });
        expect(requested).toEqual(expect.arrayContaining([expect.objectContaining({
            machineId: 'machine-1', serverId: runtime.serverId,
        })]));
        const pane = screen.tree.findByType(SessionSimulatorPreviewPane);
        expect(pane.props.viewModel.viewerId).toBe('explicit-viewer');
        expect(pane.props.viewModel.selectedSimulatorId).toBe('sim_1');
        await screen.pressByTestIdAsync('session-simulator:s1-preview-picker-device:sim_2');
        expect(screen.tree.findByType(SessionSimulatorPreviewPane).props.viewModel.selectedSimulatorId).toBe('sim_2');
        expect(rpcRequests.filter(request => request.method === RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT)).toEqual([]);
    });
});
