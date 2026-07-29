import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

type ReactActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const testState = vi.hoisted(() => ({
    platformOs: 'ios' as 'ios' | 'android' | 'web',
    activeTabResource: {
        kind: 'pluginSessionSurface',
        surfaceId: 'sessionSurface:acme.preview:preview-pane',
    } as Readonly<Record<string, unknown>>,
    machineContributionRegistryProjectionDescribe: vi.fn(),
    useLocalServicePreviewState: vi.fn(),
    usePeerMediationObservabilityStore: vi.fn(),
    useFeatureDecision: vi.fn(),
}));

const reactNativeSurfaceProps: Array<Readonly<Record<string, unknown>>> = [];

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return testState.platformOs;
                },
                select: (values: Record<string, unknown>) => values[testState.platformOs] ?? values.default,
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
                activeTabKey: 'plugin:preview',
                tabs: [
                    {
                        key: 'plugin:preview',
                        kind: 'pluginSessionSurface',
                        title: 'Preview',
                        isPinned: true,
                        isPreview: false,
                        resource: testState.activeTabResource,
                    },
                ],
            },
        },
    }),
}));

vi.mock('@/components/plugins/reactNative/PluginReactNativeSurface', () => ({
    PluginReactNativeSurface: (props: Readonly<Record<string, unknown>>) => {
        reactNativeSurfaceProps.push(props);
        return React.createElement('PluginReactNativeSurfaceMock', { testID: 'plugin-rn-surface' });
    },
}));

vi.mock('@/components/sessions/localServices/LocalServicePreviewFrame', () => ({
    LocalServicePreviewFrame: (props: Readonly<Record<string, unknown>>) =>
        React.createElement('LocalServicePreviewFrame', { ...props, testID: props.testID }),
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
    useLocalSetting: () => null,
    useLocalSettingMutable: () => [false, vi.fn()],
    useProfile: () => ({ id: 'acct_1' }),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machineContributionRegistryProjectionDescribe: (...args: readonly unknown[]) =>
        testState.machineContributionRegistryProjectionDescribe(...args),
}));

vi.mock('@/sync/domains/local/services/preview/useLocalServicePreviewState', () => ({
    useLocalServicePreviewState: (...args: readonly unknown[]) =>
        testState.useLocalServicePreviewState(...args),
}));

vi.mock('@/sync/domains/machines/peer/mediation/observability/usePeerMediationObservabilityStore', () => ({
    usePeerMediationObservabilityStore: (...args: readonly unknown[]) =>
        testState.usePeerMediationObservabilityStore(...args),
}));

function daemonPluginUiProjection(entriesById: Readonly<Record<string, unknown>>) {
    return {
        v: 2,
        generation: 10,
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById,
            },
        },
    };
}

function reactNativeProjectionEntries() {
    return {
        'reactNativeBundle:acme.preview:native-preview': {
            id: 'reactNativeBundle:acme.preview:native-preview',
            pluginId: 'acme.preview',
            contributionKind: 'reactNativeBundle',
            contributionId: 'native-preview',
            runtime: {
                state: 'loadable',
                decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                loadPolicy: { source: 'installedArtifact', featureEnabled: true, loaderBackendAvailable: true },
                cacheKey: 'cache_1',
            },
        },
        'sessionSurface:acme.preview:preview-pane': {
            id: 'sessionSurface:acme.preview:preview-pane',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'preview-pane',
            placement: 'session.preview',
            target: { kind: 'session', sessionIdPath: '/session/id' },
            renderer: {
                kind: 'reactNative',
                contributionId: 'reactNativeBundle:acme.preview:native-preview',
            },
            display: { titleKey: 'title' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
    };
}

function localPreviewProjection(): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        surfacePlacementsByPlacement: {
            'session.preview': [{
                id: 'sessionSurface:acme.preview:preview-pane',
                pluginId: 'acme.preview',
                contributionKind: 'surfacePlacement',
                descriptorId: 'preview-pane',
                placement: 'session.preview',
                target: { kind: 'session', sessionIdPath: '/session/id' },
                renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
                display: { titleKey: 'title' },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            }],
        },
    };
}

async function flushEffects() {
    await flushHookEffects({ cycles: 8, turns: 3 });
}

describe('SessionDetailsPanel plugin runtime wiring', () => {
    beforeEach(() => {
        standardCleanup();
        reactNativeSurfaceProps.length = 0;
        testState.platformOs = 'ios';
        testState.activeTabResource = {
            kind: 'pluginSessionSurface',
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
        };
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

    it('loads plugin UI projection for production renders and keeps native platform explicit for RN surfaces', async () => {
        testState.machineContributionRegistryProjectionDescribe.mockResolvedValue({
            supported: true,
            projection: daemonPluginUiProjection(reactNativeProjectionEntries()),
        });
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        await flushEffects();

        expect(testState.machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith(
            'machine_1',
            expect.objectContaining({ serverId: 'server_1' }),
        );
        expect(screen.findByTestId('plugin-rn-surface')).toBeTruthy();
        const props = reactNativeSurfaceProps.at(-1);
        expect((props?.surface as { platform?: unknown } | undefined)?.platform).toBe('ios');
        expect((props?.decision as { state?: unknown } | undefined)?.state).toBe('load');
    });

    it('routes explicit preview state, PMS observability, and caller platform into local preview plugin surfaces', async () => {
        testState.platformOs = 'ios';
        const browserTarget = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 's1',
            machineId: 'machine_1',
        } as const;
        testState.activeTabResource = {
            kind: 'pluginSessionSurface',
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
            browserTarget,
        };
        const { applyLocalServicePreviewSnapshot, createLocalServicePreviewState } = await import('@/sync/domains/local/services/preview/store');
        const {
            applyPeerMediationObservabilitySnapshot,
            createPeerMediationObservabilityUiStore,
        } = await import('@/sync/domains/machines/peer/mediation/observability/store');
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: 'preview_1',
                accessUrl: 'http://127.0.0.1:5173/',
                expiresAt: 3_000,
                diagnostics: [],
                resource: {
                    previewId: 'preview_1',
                    sessionId: 's1',
                    machineId: 'machine_1',
                    owner: { kind: 'session', id: 's1' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' },
                    display: { title: 'Preview', addressLabel: 'localhost:5173' },
                    originMode: 'host',
                    browserTarget,
                },
            }],
            diagnostics: [],
        });
        const observabilityScope = {
            kind: 'machine',
            accountId: 'acct_1',
            machineId: 'machine_1',
        } as const;
        const observabilityState = applyPeerMediationObservabilitySnapshot(
            createPeerMediationObservabilityUiStore(),
            {
                source: 'server',
                snapshot: {
                    v: 1,
                    scope: observabilityScope,
                    sequence: 1,
                    capturedAtMs: 1_500,
                    flows: [{
                        flow: {
                            flowId: 'tunnel_1',
                            flowKind: 'tcp_tunnel',
                            routeKind: 'server_relay',
                            tunnelId: 'tunnel_1',
                            productRef: { kind: 'preview', id: 'preview_1', redacted: false },
                        },
                        lifecycleState: 'active',
                        startedAtMs: 1_100,
                        lastActivityAtMs: 1_400,
                        bytesIn: 10,
                        bytesOut: 20,
                        framesIn: 0,
                        framesOut: 0,
                        messagesIn: 0,
                        messagesOut: 0,
                        activeSubstreams: 1,
                    }],
                },
            },
        );
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        const screen = await renderScreen(
            <SessionDetailsPanel
                sessionId="s1"
                scopeId="session:s1"
                pluginUiProjection={localPreviewProjection()}
                localServicePreviewState={previewState}
                peerMediationObservabilityState={observabilityState}
                peerMediationObservabilityScope={observabilityScope}
                platform="web"
                nowMs={() => 2_000}
            />,
        );
        await flushEffects();

        expect(screen.findByTestId('session-browser-pane-view-frame')).toBeTruthy();
        expect(screen.findByTestId('session-browser-pane-supplemental-diagnostics')).toBeTruthy();
    });

    it('uses canonical live preview and PMS observability stores when production callers do not pass state props', async () => {
        testState.platformOs = 'web';
        const browserTarget = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 's1',
            machineId: 'machine_1',
        } as const;
        testState.activeTabResource = {
            kind: 'pluginSessionSurface',
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
            browserTarget,
        };
        const { applyLocalServicePreviewSnapshot, createLocalServicePreviewState } = await import('@/sync/domains/local/services/preview/store');
        const {
            applyPeerMediationObservabilitySnapshot,
            createPeerMediationObservabilityUiStore,
        } = await import('@/sync/domains/machines/peer/mediation/observability/store');
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: 'preview_1',
                accessUrl: 'http://127.0.0.1:5173/',
                expiresAt: 3_000,
                diagnostics: [],
                resource: {
                    previewId: 'preview_1',
                    sessionId: 's1',
                    machineId: 'machine_1',
                    owner: { kind: 'session', id: 's1' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' },
                    display: { title: 'Preview', addressLabel: 'localhost:5173' },
                    originMode: 'host',
                    browserTarget,
                },
            }],
            diagnostics: [],
        });
        const observabilityScope = {
            kind: 'machine',
            accountId: 'acct_1',
            machineId: 'machine_1',
        } as const;
        const observabilityState = applyPeerMediationObservabilitySnapshot(
            createPeerMediationObservabilityUiStore(),
            {
                source: 'server',
                snapshot: {
                    v: 1,
                    scope: observabilityScope,
                    sequence: 1,
                    capturedAtMs: 1_500,
                    flows: [{
                        flow: {
                            flowId: 'tunnel_1',
                            flowKind: 'tcp_tunnel',
                            routeKind: 'server_relay',
                            tunnelId: 'tunnel_1',
                            productRef: { kind: 'preview', id: 'preview_1', redacted: false },
                        },
                        lifecycleState: 'active',
                        startedAtMs: 1_100,
                        lastActivityAtMs: 1_400,
                        bytesIn: 10,
                        bytesOut: 20,
                        framesIn: 0,
                        framesOut: 0,
                        messagesIn: 0,
                        messagesOut: 0,
                        activeSubstreams: 1,
                    }],
                },
            },
        );
        testState.usePeerMediationObservabilityStore.mockReturnValue(observabilityState);
        testState.useLocalServicePreviewState.mockReturnValue(previewState);
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        const screen = await renderScreen(
            <SessionDetailsPanel
                sessionId="s1"
                scopeId="session:s1"
                pluginUiProjection={localPreviewProjection()}
                nowMs={() => 2_000}
            />,
        );
        await flushEffects();

        expect(testState.useLocalServicePreviewState).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            enabled: true,
        }));
        expect(testState.usePeerMediationObservabilityStore).toHaveBeenCalledWith(expect.objectContaining({
            scope: observabilityScope,
            source: 'server',
            serverId: 'server_1',
            enabled: true,
        }));
        expect(screen.findByTestId('session-browser-pane-view-frame')).toBeTruthy();
        expect(screen.findByTestId('session-browser-pane-supplemental-diagnostics')).toBeTruthy();
    });

});
