import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

type ReactActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const testState = vi.hoisted(() => ({
    machineContributionRegistryProjectionDescribe: vi.fn(),
    useLocalServicePreviewState: vi.fn(),
    usePeerMediationObservabilityStore: vi.fn(),
    useFeatureDecision: vi.fn(),
}));

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (values: Record<string, unknown>) => values.web ?? values.default,
            },
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            ActivityIndicator: 'ActivityIndicator',
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => null,
            useLocalSettingMutable: () => [false, vi.fn()],
            useEndpointStatus: () => 'online',
            useMachineCliDetectionTarget: () => ({ daemonStateVersion: 10, isOnline: true }),
        });
    },
});

vi.mock('@/constants/Typography', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/constants/Typography')>()),
    Typography: {
        default: () => ({}),
        mono: () => ({}),
        eyebrow: () => ({}),
        keyHint: () => ({}),
        rowTitle: () => ({}),
        rowMeta: () => ({}),
        pillLabel: () => ({}),
        // Consumed by `projectPluginUiTheme` for the mounted surface's semantic
        // theme; the real module exports it.
        timestamp: () => ({}),
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
                isOpen: false,
                activeTabKey: null,
                tabs: [],
            },
        },
    }),
}));

vi.mock('@/components/browser/diagnostics', () => ({
    BrowserDiagnosticsDrawer: (props: Readonly<Record<string, unknown>>) => React.createElement('BrowserDiagnosticsDrawer', {
        testID: props.testID ?? 'browser-diagnostics-drawer',
    }),
    BrowserDiagnosticsPanel: (props: Readonly<Record<string, unknown>>) => React.createElement('BrowserDiagnosticsPanel', {
        testID: props.testID ?? 'browser-diagnostics',
    }),
    useBrowserDiagnosticsRuntime: () => ({
        state: { viewsByKey: {} },
    }),
}));

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: 'machine_1', basePath: '/repo' }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (...args: readonly unknown[]) => testState.useFeatureDecision(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server_1',
}));

vi.mock('@/sync/store/hooks', () => ({
    useActiveServerAccountScope: () => null,
    useLocalSetting: () => null,
    useLocalSettingMutable: () => [false, vi.fn()],
    useProfile: () => ({ id: 'acct_1' }),
}));

// The daemon RPC boundary. `machinePluginUiResourceRead` and
// `machinePluginStructuredMessageActionExecute` belong to the same boundary and
// are reached by the mounted surface's bound controller (§3.1), so a partial
// mock of this module would fail the mount rather than the assertion.
vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machineContributionRegistryProjectionDescribe: (...args: readonly unknown[]) =>
        testState.machineContributionRegistryProjectionDescribe(...args),
    machinePluginUiResourceRead: async () => ({ supported: false, reason: 'not-supported' }),
    machinePluginStructuredMessageActionExecute: async () => ({ supported: false, reason: 'not-supported' }),
    machinePluginSettingsGet: async () => ({ supported: false, reason: 'not-supported' }),
    machinePluginSettingsSet: async () => ({ supported: false, reason: 'not-supported' }),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

vi.mock('@/sync/domains/local/services/preview/useLocalServicePreviewState', () => ({
    useLocalServicePreviewState: (...args: readonly unknown[]) =>
        testState.useLocalServicePreviewState(...args),
}));

vi.mock('@/sync/domains/machines/peer/mediation/observability/usePeerMediationObservabilityStore', () => ({
    usePeerMediationObservabilityStore: (...args: readonly unknown[]) =>
        testState.usePeerMediationObservabilityStore(...args),
}));

async function flushEffects() {
    await flushHookEffects({ cycles: 8, turns: 3 });
}

describe('SessionDetailsPanel plugin runtime wiring', () => {
    beforeEach(() => {
        standardCleanup();
        testState.machineContributionRegistryProjectionDescribe.mockReset();
        testState.machineContributionRegistryProjectionDescribe.mockResolvedValue({
            supported: false,
            reason: 'not-supported',
        });
        testState.useLocalServicePreviewState.mockReset();
        testState.useLocalServicePreviewState.mockReturnValue(null);
        testState.usePeerMediationObservabilityStore.mockReset();
        testState.usePeerMediationObservabilityStore.mockReturnValue({ scopesByKey: {} });
        testState.useFeatureDecision.mockReset();
        testState.useFeatureDecision.mockImplementation((featureId: unknown, scope: unknown) => ({
            featureId,
            state: 'enabled',
            blockedBy: null,
            blockerCode: 'none',
            diagnostics: [],
            evaluatedAt: 1,
            scope: scope ?? { scopeKind: 'runtime' },
        }));
    });

    it('uses one registered AppPane snapshot without another projection request', async () => {
        // This assertion is about the canonical snapshot passed to the panel,
        // rather than plugin-surface rendering itself.
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        await renderScreen(
            <SessionDetailsPanel
                sessionId="s1"
                scopeId="session:s1"
                paneSurfaceScope={{
                    targetKind: 'session',
                    sessionId: 's1',
                    machineId: 'machine-from-pane-driver',
                    serverId: 'server-from-pane-driver',
                    pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
                    projectionPhase: 'establishing',
                    interactionEnabled: false,
                    platform: 'web',
                }}
            />,
        );
        await flushEffects();

        expect(testState.machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
        expect(testState.useLocalServicePreviewState).toHaveBeenCalledWith({
            machineId: 'machine-from-pane-driver',
            serverId: 'server-from-pane-driver',
            enabled: true,
        });
    });

    it('fails closed when a driver scope belongs to another session', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        await renderScreen(
            <SessionDetailsPanel
                sessionId="s1"
                scopeId="session:s1"
                paneSurfaceScope={{
                    targetKind: 'session',
                    sessionId: 's2',
                    machineId: 'machine-from-wrong-session',
                    serverId: 'server-from-wrong-session',
                    pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
                    projectionPhase: 'current',
                    interactionEnabled: true,
                    platform: 'web',
                }}
            />,
        );
        await flushEffects();

        expect(testState.useLocalServicePreviewState).toHaveBeenCalledWith({
            machineId: null,
            serverId: null,
            enabled: true,
        });
        expect(testState.usePeerMediationObservabilityStore).toHaveBeenCalledWith({
            scope: null,
            source: 'server',
            serverId: null,
            enabled: true,
        });
    });

});
