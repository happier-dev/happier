import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';

import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

type ReactActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const testState = vi.hoisted(() => ({
    activeTabResource: {
        kind: 'simulatorPreview',
        viewerId: 'viewer_1',
        selectedSimulatorId: 'sim_1',
    } as Readonly<Record<string, unknown>>,
    useSimulatorPreviewSessionSurfaceRuntime: vi.fn(),
    runtime: null as Readonly<Record<string, unknown>> | null,
}));

const simulatorPaneProps: Array<Readonly<Record<string, unknown>>> = [];

installSessionDetailsPanelCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
        eyebrow: () => ({}),
        keyHint: () => ({}),
        rowTitle: () => ({}),
        rowMeta: () => ({}),
        pillLabel: () => ({}),
    },
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        openRight: vi.fn(),
        closeRight: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'simulator:preview',
                tabs: [{
                    key: 'simulator:preview',
                    kind: 'simulatorPreview',
                    title: 'Simulator',
                    isPinned: true,
                    isPreview: false,
                    resource: testState.activeTabResource,
                }],
            },
        },
    }),
}));

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: 'machine_1', basePath: '/repo' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server_1',
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => null,
    useLocalSettingMutable: () => [false, vi.fn()],
    useProfile: () => ({ id: 'acct_1' }),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machineContributionRegistryProjectionDescribe: vi.fn(async () => ({
        supported: true,
        projection: {
            v: 2,
            generation: 1,
            familiesById: {},
        },
    })),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

vi.mock('@/sync/domains/local/services/preview/useLocalServicePreviewState', () => ({
    useLocalServicePreviewState: () => null,
}));

vi.mock('@/sync/domains/machines/peer/mediation/observability/usePeerMediationObservabilityStore', () => ({
    usePeerMediationObservabilityStore: () => ({ scopesByKey: {} }),
}));

vi.mock('@/sync/domains/devices/simulator/useSimulatorPreviewRuntime', () => ({
    useSimulatorPreviewSessionSurfaceRuntime: (...args: readonly unknown[]) =>
        testState.useSimulatorPreviewSessionSurfaceRuntime(...args),
}));

vi.mock('@/components/sessions/simulator/SessionSimulatorPreviewPane', () => ({
    SessionSimulatorPreviewPane: (props: Readonly<Record<string, unknown>>) => {
        simulatorPaneProps.push(props);
        return React.createElement('SessionSimulatorPreviewPaneMock', { testID: 'session-simulator-pane' });
    },
}));

async function flushEffects() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

function simulatorRuntime(): SimulatorPreviewSurfaceRuntime {
    return {
        resources: [{
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
            },
        }],
        viewerId: 'viewer_1',
        selectedSimulatorId: 'sim_1',
        viewModel: {
            kind: 'selected',
            viewerId: 'viewer_1',
            devices: [],
            selectedSimulatorId: 'sim_1',
            resource: null,
            stream: {
                phase: 'idle',
                selectedCodec: null,
                activeRenderer: null,
                decodedFrames: 0,
                droppedFrames: 0,
                bufferedBytes: 0,
            },
            codec: { selected: null },
            activeLease: null,
            lease: { state: 'available' },
            controls: {
                canWatch: true,
                canControl: false,
                canRequestKeyframe: true,
                canRequestSnapshot: true,
                canSetQuality: true,
                canSetFps: false,
                canSetScale: false,
                supportedInputKinds: [],
            },
            sidebands: {},
            availability: { state: 'available' },
            diagnostics: [],
        },
        actions: {
            selectDevice: vi.fn(),
            openStream: vi.fn(),
            closeStream: vi.fn(),
            acquireLease: vi.fn(),
            releaseLease: vi.fn(),
            renewLease: vi.fn(),
            sendControl: vi.fn(),
            requestSideband: vi.fn(),
            requestKeyframe: vi.fn(),
            requestSnapshot: vi.fn(),
            lowerQuality: vi.fn(),
            setFps: vi.fn(),
            setScale: vi.fn(),
            rotateLeft: vi.fn(),
            pressHome: vi.fn(),
        },
    };
}

describe('SessionDetailsPanel simulator runtime wiring', () => {
    beforeEach(() => {
        standardCleanup();
        simulatorPaneProps.length = 0;
        testState.activeTabResource = {
            kind: 'simulatorPreview',
            viewerId: 'viewer_1',
            selectedSimulatorId: 'sim_1',
        };
        testState.useSimulatorPreviewSessionSurfaceRuntime.mockReset();
        testState.runtime = simulatorRuntime();
        testState.useSimulatorPreviewSessionSurfaceRuntime.mockReturnValue(testState.runtime);
    });

    it('loads simulator preview runtime for production simulator session tabs', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" nowMs={() => 1_000} />);
        await flushEffects();

        expect(testState.useSimulatorPreviewSessionSurfaceRuntime).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            viewerId: 'session:s1:simulator-preview',
            nowMs: 1_000,
            enabled: true,
        }));
        expect(screen.findByTestId('session-simulator-pane')).toBeTruthy();
        const props = simulatorPaneProps.at(-1);
        expect((props?.viewModel as { selectedSimulatorId?: unknown } | undefined)?.selectedSimulatorId).toBe('sim_1');
        expect(props?.actions).toBe((testState.runtime as { actions?: unknown }).actions);
    });

    it('keeps explicit simulator runtime props as the owner and disables the live hook side effects', async () => {
        const explicitRuntime = simulatorRuntime();
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        await renderScreen(
            <SessionDetailsPanel
                sessionId="s1"
                scopeId="session:s1"
                simulatorPreview={explicitRuntime}
                nowMs={() => 1_000}
            />,
        );
        await flushEffects();

        expect(testState.useSimulatorPreviewSessionSurfaceRuntime).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            viewerId: 'session:s1:simulator-preview',
            enabled: false,
        }));
        const props = simulatorPaneProps.at(-1);
        expect(props?.actions).toBe(explicitRuntime.actions);
    });
});
