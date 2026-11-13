import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import {
    DaemonSimulatorPreviewSnapshotRequestV1Schema, DaemonSimulatorPreviewSnapshotResponseV1Schema, SimulatorPreviewSnapshotV1Schema,
} from '@happier-dev/protocol/devices/simulator/runtimeV1';
import {
    DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES} from '@happier-dev/protocol/features/payload/capabilities/deviceCapabilities';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
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
        features: {
            devices: { enabled: true, simulatorPreview: { enabled: true } },
            machines: { liveStream: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } } },
            browser: { enabled: true, viewTargets: { enabled: true } },
        },
        capabilities: { devices: { simulatorPreview: {
            ...DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
            enabled: true, available: true, availableDevices: snapshot.resources,
        } } },
    }),
    rpc: async (method, params) => {
        rpcRequests.push({ method, params });
        if (method === RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT) {
            const input = DaemonSimulatorPreviewSnapshotRequestV1Schema.parse(params);
            expect(input.machineId).toBe('machine-1');
            return DaemonSimulatorPreviewSnapshotResponseV1Schema.parse({ protocolVersion: 1, snapshot });
        }
        throw new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND);
    },
});
beforeEach(async () => {
    rpcRequests.length = 0;
    storage.getState().applySettingsLocal({ experiments: true });
    storage.getState().applyMachines([createMachineFixture({ storageMode: 'plain', activeAt: Date.now() })], true, { sourceServerId: runtime.serverId });
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('@/sync/domains/features/featureDecisionRuntime');
    const features = await getServerFeaturesSnapshot({ serverId: runtime.serverId });
    expect(resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'devices.simulatorPreview',
        settings: storage.getState().settings, snapshot: features,
        scope: { scopeKind: 'spawn', serverId: runtime.serverId },
    })).toMatchObject({ state: 'enabled' });
});
const nowMs = () => 1_000;
const simulatorTab = {
    key: 'simulator:preview', kind: 'simulatorPreview', title: 'Simulator',
    resource: { kind: 'simulatorPreview', viewerId: 'viewer_1', selectedSimulatorId: 'sim_1' },
};

// Compile the real graph during collection, after its boundaries are installed, so a cold import is not
// charged to the first test's deadline.
await import('./SessionDetailsPanel');

describe('SessionDetailsPanel simulator runtime wiring', () => {
    it('renders the Session opener\'s Simulator tab from the live daemon snapshot', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionSimulatorPreviewPane } = await import('@/components/sessions/simulator/SessionSimulatorPreviewPane');
        const { createSimulatorPreviewDetailsTab } = await import('@/components/sessions/simulator/simulatorPreviewDetailsTab');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" nowMs={nowMs} />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createSimulatorPreviewDetailsTab({ title: 'Simulator' }), { intent: 'pinned' }));
        await waitForHomeGovernance(() => expect(
            screen.tree.findByType(SessionSimulatorPreviewPane).props.viewModel.devices
                .map((device: { simulatorId: string }) => device.simulatorId),
        ).toEqual(['sim_1', 'sim_2']));
    });

    it('renders the live daemon snapshot and preserves device selection through real actions', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionSimulatorPreviewPane } = await import('@/components/sessions/simulator/SessionSimulatorPreviewPane');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" nowMs={nowMs} />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(simulatorTab, { intent: 'pinned' }));
        await waitForHomeGovernance(() => expect(
            screen.tree.findByType(SessionSimulatorPreviewPane).props.viewModel.devices
                .map((device: { simulatorId: string }) => device.simulatorId),
        ).toEqual(['sim_1', 'sim_2']));
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
        await waitForHomeGovernance(() => expect(requested).toEqual(expect.arrayContaining([expect.objectContaining({
            machineId: 'machine-1', serverId: runtime.serverId,
        })])));
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
