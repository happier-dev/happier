import * as React from 'react';
import type { BrowserRecordingCapabilities } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

// The host browser surface (`BrowserDetailsSurface` → `BrowserSurfaceHost`) gates its rendered
// view-frame, recording controls, and supplemental diagnostics on the runtime `browser.*` feature
// decisions. Production callers thread an enabled decision through their feature-snapshot wiring
// (see `SessionDetailsPanel.pluginRuntimeWiring.test.tsx`); this registry-level unit test renders
// the pane without that wiring, so the real hook would fail-closed and the data-bearing children
// would never mount. Mock the canonical decision hook to the enabled runtime contract the host
// expects so the migrated browser-pane passthrough is exercised end-to-end.
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: unknown, scope: unknown) => ({
        featureId,
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
        evaluatedAt: 1,
        scope: scope ?? { scopeKind: 'runtime' },
    }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('TextInput', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const tab = {
    key: 'plugin:preview',
    kind: 'pluginSessionSurface',
    title: 'Preview',
    isPinned: true,
    isPreview: false,
    resource: {
        kind: 'pluginSessionSurface',
        surfaceId: 'sessionSurface:acme.preview:preview-pane',
    },
} as const;

const recordingCapabilities = {
    enabled: true,
    attachmentsEnabled: true,
    available: true,
    supportedCaptureKinds: ['streamFrameCapture'],
    supportedMimeTypes: ['video/webm'],
    supportedAdapterKinds: ['localPreview'],
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    maxFps: 12,
    audioSupported: false,
    cursorOverlaySupported: true,
    actionTimelineChaptersSupported: true,
    supportedRetentionClasses: ['preSend', 'attached'],
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

describe('plugin session surface registry', () => {
    it('routes simulator preview resources through the simulator session pane', async () => {
        const { renderSessionSurfaceTab } = await import('./sessionSurfaces');
        const node = renderSessionSurfaceTab({
            sessionId: 'session_1',
            tab: {
                key: 'simulator:preview',
                kind: 'simulatorPreview',
                title: 'Simulator',
                isPinned: true,
                isPreview: false,
                resource: {
                    kind: 'simulatorPreview',
                    viewerId: 'viewer_1',
                },
            },
        } as never);

        const screen = await renderScreen(<>{node}</>);

        expect(screen.findByTestId('session-simulator:session_1')).toBeTruthy();
        expect(screen.findByTestId('session-simulator:session_1-preview-picker-empty')).toBeTruthy();
    });

    it('routes host preview placeholders with local-service browser targets through the preview pane', async () => {
        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const {
            applyLocalServicePreviewSnapshot,
            createLocalServicePreviewState,
        } = await import('@/sync/domains/local/services/preview/store');
        const browserTarget = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
        } as const;
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: 'preview_1',
                accessUrl: 'https://preview-1.preview.happier.test/',
                expiresAt: 2_000,
                diagnostics: [],
                resource: {
                    previewId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine_1',
                    owner: { kind: 'session', id: 'session_1' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' },
                    display: { title: 'Dashboard', addressLabel: 'localhost:5173' },
                    originMode: 'host',
                    browserTarget,
                },
            }],
            diagnostics: [],
        });
        const node = renderPluginSessionSurfaceTab({
            tab: {
                ...tab,
                resource: {
                    ...tab.resource,
                    browserTarget,
                },
            },
            pluginUiProjection: {
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
            },
            localServicePreviewState: previewState,
            platform: 'web',
            nowMs: () => 1_000,
        } as never);

        const screen = await renderScreen(<>{node}</>);
        await flushHookEffects({ cycles: 8, turns: 3 });

        expect(screen.findByTestId('session-browser-pane')).toBeTruthy();
        expect(screen.findByTestId('session-browser-pane-view-frame')?.props.src).toBe(
            'https://preview-1.preview.happier.test/',
        );
    });

    it('passes session-owned browser recording state into host preview placeholders', async () => {
        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const { createBrowserRecordingState } = await import('@/sync/domains/browser/recording');
        const {
            applyLocalServicePreviewSnapshot,
            createLocalServicePreviewState,
        } = await import('@/sync/domains/local/services/preview/store');
        const browserTarget = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
        } as const;
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: 'preview_1',
                accessUrl: 'https://preview-1.preview.happier.test/',
                expiresAt: 2_000,
                diagnostics: [],
                resource: {
                    previewId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine_1',
                    owner: { kind: 'session', id: 'session_1' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' },
                    display: { title: 'Dashboard', addressLabel: 'localhost:5173' },
                    originMode: 'host',
                    browserTarget,
                },
            }],
            diagnostics: [],
        });
        const node = renderPluginSessionSurfaceTab({
            tab: {
                ...tab,
                resource: {
                    ...tab.resource,
                    browserTarget,
                },
            },
            pluginUiProjection: {
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
            },
            localServicePreviewState: previewState,
            platform: 'web',
            browserRecording: {
                state: createBrowserRecordingState(),
                recordingCapabilities,
                enabled: true,
                nowMs: () => 1_000,
            },
            nowMs: () => 1_000,
        } as never);

        const screen = await renderScreen(<>{node}</>);
        await flushHookEffects({ cycles: 8, turns: 3 });

        expect(screen.findByTestId('session-browser-pane-recording-start')).toBeTruthy();
    });

    it('passes PMS observability preview diagnostics into host preview placeholders', async () => {
        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const {
            applyLocalServicePreviewSnapshot,
            createLocalServicePreviewState,
        } = await import('@/sync/domains/local/services/preview/store');
        const {
            applyPeerMediationObservabilitySnapshot,
            createPeerMediationObservabilityUiStore,
        } = await import('@/sync/domains/machines/peer/mediation/observability/store');
        const browserTarget = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
        } as const;
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: 'preview_1',
                accessUrl: 'https://preview-1.preview.happier.test/',
                expiresAt: 2_000,
                diagnostics: [],
                resource: {
                    previewId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine_1',
                    owner: { kind: 'session', id: 'session_1' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' },
                    display: { title: 'Dashboard', addressLabel: 'localhost:5173' },
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
        const node = renderPluginSessionSurfaceTab({
            tab: {
                ...tab,
                resource: {
                    ...tab.resource,
                    browserTarget,
                },
            },
            pluginUiProjection: {
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
            },
            localServicePreviewState: previewState,
            peerMediationObservabilityState: observabilityState,
            peerMediationObservabilityScope: observabilityScope,
            platform: 'web',
            productModels: {},
            nowMs: () => 1_000,
        } as never);

        const screen = await renderScreen(<>{node}</>);
        await flushHookEffects({ cycles: 8, turns: 3 });

        expect(screen.findByTestId('session-browser-pane')).toBeTruthy();
        expect(screen.findByTestId('session-browser-pane-supplemental-diagnostics')).toBeTruthy();
        // The supplemental-diagnostics drawer renders its preview-proxy flow rows through the
        // body panel (`${drawerTestID}-body`), so the per-flow row is keyed under `-body-flow-`.
        expect(screen.findByTestId('session-browser-pane-supplemental-diagnostics-body-flow-tunnel_1')).toBeTruthy();
    });

    it('routes hosted-web renderer references through the hosted-web fallback pane', async () => {
        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const {
            applyLocalServicePreviewSnapshot,
            createLocalServicePreviewState,
        } = await import('@/sync/domains/local/services/preview/store');
        const browserTarget = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
        } as const;
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: 'preview_1',
                accessUrl: 'https://preview-1.preview.happier.test/plugin/acme/',
                expiresAt: 2_000,
                diagnostics: [],
                resource: {
                    previewId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine_1',
                    owner: { kind: 'session', id: 'session_1' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' },
                    display: { title: 'Plugin UI', addressLabel: 'localhost:5173' },
                    originMode: 'host',
                    browserTarget,
                },
            }],
            diagnostics: [],
        });
        const node = renderPluginSessionSurfaceTab({
            tab: {
                ...tab,
                resource: {
                    ...tab.resource,
                    browserTarget,
                },
            },
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                hostedWebById: {
                    'hostedWeb:acme.preview:preview-web': {
                        id: 'hostedWeb:acme.preview:preview-web',
                        pluginId: 'acme.preview',
                        contributionKind: 'hostedWeb',
                        contributionId: 'preview-web',
                        sandbox: { scripts: true },
                        security: {},
                        runtime: {
                            state: 'available',
                            diagnostics: [],
                            decision: {
                                state: 'render',
                                reason: 'available',
                                diagnostics: [],
                            },
                        },
                    },
                },
                surfacePlacementsByPlacement: {
                    'session.preview': [{
                        id: 'sessionSurface:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'preview-pane',
                        placement: 'session.preview',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                        browserTarget,
                        renderer: { kind: 'hostedWeb', contributionId: 'hostedWeb:acme.preview:preview-web' },
                        display: { titleKey: 'title' },
                        availability: { state: 'available', reason: 'available', diagnostics: [] },
                    }],
                },
            },
            localServicePreviewState: previewState,
            platform: 'web',
            nowMs: () => 1_000,
        });

        const screen = await renderScreen(<>{node}</>);

        expect(screen.findByTestId('plugin-hosted-web-frame')?.props.src).toBe(
            'https://preview-1.preview.happier.test/plugin/acme/',
        );
    });

    it('routes React Native renderer references through the RN compatibility fallback', async () => {
        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const node = renderPluginSessionSurfaceTab({
            tab,
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                reactNativeBundlesById: {
                    'reactNativeBundle:acme.preview:native-preview': {
                        id: 'reactNativeBundle:acme.preview:native-preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'reactNativeBundle',
                        contributionId: 'native-preview',
                    },
                },
                surfacePlacementsByPlacement: {
                    'session.preview': [{
                        id: 'sessionSurface:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'preview-pane',
                        placement: 'session.preview',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                        renderer: { kind: 'reactNative', contributionId: 'reactNativeBundle:acme.preview:native-preview' },
                        display: { titleKey: 'title' },
                        availability: { state: 'available', reason: 'available', diagnostics: [] },
                    }],
                },
            },
        });

        const screen = await renderScreen(<>{node}</>);

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
    });

    it('does not render plugin session surfaces with deferred policy until the host can evaluate it', async () => {
        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const node = renderPluginSessionSurfaceTab({
            tab,
            pluginUiProjection: {
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
                        visibility: { operand: 'platform.is', value: 'web' },
                    }],
                },
            },
        });

        expect(node).toBeNull();
    });
});
