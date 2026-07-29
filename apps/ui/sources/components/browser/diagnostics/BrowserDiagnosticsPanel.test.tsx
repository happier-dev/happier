import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

type BrowserDiagnosticsPanelModule = Readonly<{
    BrowserDiagnosticsPanel?: React.ComponentType<{
        diagnostics: unknown;
        interaction?: unknown;
        testID?: string;
    }>;
}>;

async function loadBrowserDiagnosticsPanelModule(): Promise<BrowserDiagnosticsPanelModule | null> {
    const path = './BrowserDiagnosticsPanel';
    return import(path) as Promise<BrowserDiagnosticsPanelModule | null>;
}

const availablePreviewProxyDiagnostics = {
    status: 'available',
    sourceKind: 'previewProxy',
    fidelity: 'previewProxy',
    trusted: true,
    attribution: 'traffic_for_preview_all_views',
    activeFlowCount: 1,
    families: [
        {
            family: 'network',
            status: 'available',
            fidelity: 'previewProxy',
            trusted: true,
        },
        {
            family: 'console',
            status: 'unavailable',
            fidelity: 'unavailable',
            trusted: false,
            reasonCode: 'unsupported_fidelity',
        },
    ],
    flows: [
        {
            flowId: 'tunnel_1',
            family: 'network',
            fidelity: 'previewProxy',
            trusted: true,
            lifecycleState: 'active',
            method: 'GET',
            path: '/dashboard',
            statusCode: 200,
            bytesIn: 128,
            bytesOut: 256,
            messagesIn: 2,
            messagesOut: 3,
            activeSubstreams: 1,
            lastActivityAtMs: 1_500,
        },
    ],
} as const;

describe('BrowserDiagnosticsPanel', () => {
    it('renders previewProxy flow diagnostics with fidelity and attribution state', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();

        expect(mod?.BrowserDiagnosticsPanel).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsPanel) return;

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsPanel
                diagnostics={availablePreviewProxyDiagnostics}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-fidelity-previewProxy')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-active-flow-count')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-flow-tunnel_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-family-console-unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('/dashboard');
        expect(screen.getTextContent()).toContain('200');
    });

    it('renders unavailable preview diagnostics without pretending a network table exists', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();

        expect(mod?.BrowserDiagnosticsPanel).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsPanel) return;

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsPanel
                diagnostics={{
                    status: 'unavailable',
                    sourceKind: 'previewProxy',
                    fidelity: 'unavailable',
                    trusted: true,
                    attribution: 'traffic_for_preview_all_views',
                    unavailableReasonCode: 'observability_unavailable',
                    activeFlowCount: 0,
                    families: [],
                    flows: [],
                }}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-unavailable')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-empty')).toBeTruthy();
    });

    it('renders injected/native browser diagnostics from the shared host projection', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();

        expect(mod?.BrowserDiagnosticsPanel).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsPanel) return;

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsPanel
                diagnostics={{
                    status: 'available',
                    sourceKind: 'browserDiagnostics',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    fidelity: 'injectedPage',
                    trusted: false,
                    eventCount: 2,
                    families: [
                        {
                            family: 'console',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'pageInfo',
                            status: 'available',
                            fidelity: 'nativeCallback',
                            trusted: true,
                        },
                    ],
                    events: [
                        {
                            eventId: 'evt_console_1',
                            family: 'console',
                            kind: 'console.entry',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_000,
                            summary: 'ready',
                        },
                        {
                            eventId: 'evt_page_1',
                            family: 'pageInfo',
                            kind: 'pageInfo.snapshot',
                            fidelity: 'nativeCallback',
                            trusted: true,
                            capturedAtMs: 2_100,
                            summary: 'https://example.test/',
                        },
                    ],
                }}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-fidelity-injectedPage')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-family-console')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-family-pageInfo')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-event-evt_console_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-event-evt_page_1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('ready');
        expect(screen.getTextContent()).toContain('https://example.test/');
    });

    it('renders family-specific browser diagnostics rows without exposing storage values', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();

        expect(mod?.BrowserDiagnosticsPanel).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsPanel) return;

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsPanel
                diagnostics={{
                    status: 'available',
                    sourceKind: 'browserDiagnostics',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    fidelity: 'injectedPage',
                    trusted: false,
                    eventCount: 6,
                    families: [
                        {
                            family: 'console',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'network',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'elements',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'resources',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'storage',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'pageInfo',
                            status: 'available',
                            fidelity: 'nativeCallback',
                            trusted: true,
                        },
                    ],
                    events: [
                        {
                            eventId: 'evt_console_1',
                            family: 'console',
                            kind: 'console.entry',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_000,
                            summary: 'console metadata captured',
                        },
                        {
                            eventId: 'evt_network_1',
                            family: 'network',
                            kind: 'network.response',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_100,
                            summary: 'GET /api/session',
                        },
                        {
                            eventId: 'evt_elements_1',
                            family: 'elements',
                            kind: 'elements.snapshot',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_200,
                            summary: 'main#app',
                        },
                        {
                            eventId: 'evt_resources_1',
                            family: 'resources',
                            kind: 'resources.snapshot',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_300,
                            summary: 'script.js',
                        },
                        {
                            eventId: 'evt_storage_1',
                            family: 'storage',
                            kind: 'storage.availability',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_400,
                            summary: 'cookie sid=secret localStorage token=secret',
                        },
                        {
                            eventId: 'evt_page_1',
                            family: 'pageInfo',
                            kind: 'pageInfo.snapshot',
                            fidelity: 'nativeCallback',
                            trusted: true,
                            capturedAtMs: 2_500,
                            summary: 'https://example.test/app',
                        },
                    ],
                }}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-console-row-evt_console_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-console-detail-evt_console_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-row-evt_network_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-detail-evt_network_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-elements-row-evt_elements_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-resources-row-evt_resources_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-storage-row-evt_storage_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-storage-detail-evt_storage_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-pageInfo-row-evt_page_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-pageInfo-detail-evt_page_1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('GET /api/session');
        expect(screen.getTextContent()).toContain('https://example.test/app');
        expect(screen.getTextContent()).not.toContain('sid=secret');
        expect(screen.getTextContent()).not.toContain('token=secret');
    });

    it('surfaces the local-owner console text in the console panel (DEV-2)', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();
        if (!mod?.BrowserDiagnosticsPanel) return;

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsPanel
                diagnostics={{
                    status: 'available',
                    sourceKind: 'browserDiagnostics',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    fidelity: 'injectedPage',
                    trusted: false,
                    eventCount: 1,
                    families: [
                        {
                            family: 'console',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                    ],
                    events: [
                        {
                            eventId: 'evt_console_text_1',
                            family: 'console',
                            kind: 'console.entry',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_000,
                            detail: {
                                fields: [
                                    { key: 'level', value: 'log' },
                                    { key: 'text', value: 'owner visible console output' },
                                ],
                            },
                        },
                    ],
                }}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-console-row-evt_console_text_1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('owner visible console output');
    });

    it('renders product diagnostics panels with family availability and redacted metadata', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();

        expect(mod?.BrowserDiagnosticsPanel).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsPanel) return;

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsPanel
                diagnostics={{
                    status: 'available',
                    sourceKind: 'browserDiagnostics',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    fidelity: 'injectedPage',
                    trusted: false,
                    eventCount: 5,
                    families: [
                        {
                            family: 'console',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'network',
                            status: 'unavailable',
                            fidelity: 'unavailable',
                            trusted: false,
                            reasonCode: 'unsupported_fidelity',
                        },
                        {
                            family: 'elements',
                            status: 'stale',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'resources',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'storage',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'pageInfo',
                            status: 'available',
                            fidelity: 'nativeCallback',
                            trusted: true,
                        },
                    ],
                    events: [
                        {
                            eventId: 'evt_console_1',
                            family: 'console',
                            kind: 'console.entry',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_000,
                            summary: 'console metadata captured',
                        },
                        {
                            eventId: 'evt_elements_1',
                            family: 'elements',
                            kind: 'collector.degraded',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_100,
                            summary: 'cross-origin subtree unavailable',
                        },
                        {
                            eventId: 'evt_resources_1',
                            family: 'resources',
                            kind: 'resources.snapshot',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_200,
                            summary: 'scripts: 4; images: 2',
                        },
                        {
                            eventId: 'evt_storage_1',
                            family: 'storage',
                            kind: 'storage.availability',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_300,
                            summary: 'localStorage keys: 3; cookie count: 2; sid=secret; token=secret; response body=secret',
                        },
                        {
                            eventId: 'evt_page_1',
                            family: 'pageInfo',
                            kind: 'pageInfo.snapshot',
                            fidelity: 'nativeCallback',
                            trusted: true,
                            capturedAtMs: 2_400,
                            summary: 'https://example.test/app',
                        },
                    ],
                }}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-console-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-unavailable')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-fidelity-unavailable')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-elements-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-elements-partial')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-resources-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-storage-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-pageInfo-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-console-row-evt_console_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-resources-row-evt_resources_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-storage-row-evt_storage_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-pageInfo-row-evt_page_1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('localStorage keys: 3');
        expect(screen.getTextContent()).toContain('cookie count: 2');
        expect(screen.getTextContent()).not.toContain('sid=secret');
        expect(screen.getTextContent()).not.toContain('token=secret');
        expect(screen.getTextContent()).not.toContain('body=secret');
    });

    it('renders owner-only diagnostics interaction controls and picker actions explicitly', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();

        expect(mod?.BrowserDiagnosticsPanel).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsPanel) return;

        let enableCount = 0;
        let pickerCount = 0;
        const screen = await renderScreen(
            <mod.BrowserDiagnosticsPanel
                diagnostics={{
                    status: 'available',
                    sourceKind: 'browserDiagnostics',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    fidelity: 'injectedPage',
                    trusted: false,
                    eventCount: 0,
                    families: [],
                    events: [],
                }}
                interaction={{
                    state: 'disabled',
                    ownerOnly: true,
                    canEnable: true,
                    onEnableInteraction: () => {
                        enableCount += 1;
                    },
                }}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-interaction-disabled')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-interaction-enable')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-picker-start')).toBeNull();

        screen.pressByTestId('browser-diagnostics-interaction-enable');
        expect(enableCount).toBe(1);

        await screen.update(
            <mod.BrowserDiagnosticsPanel
                diagnostics={{
                    status: 'available',
                    sourceKind: 'browserDiagnostics',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    fidelity: 'injectedPage',
                    trusted: false,
                    eventCount: 0,
                    families: [],
                    events: [],
                }}
                interaction={{
                    state: 'enabled',
                    ownerOnly: true,
                    pickerState: 'idle',
                    onStartElementPicker: () => {
                        pickerCount += 1;
                    },
                }}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-interaction-enabled')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-picker-start')).toBeTruthy();
        screen.pressByTestId('browser-diagnostics-picker-start');
        expect(pickerCount).toBe(1);
    });

    it('renders the performance vitals panel and capability metadata without leaking values', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();

        expect(mod?.BrowserDiagnosticsPanel).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsPanel) return;

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsPanel
                diagnostics={{
                    status: 'available',
                    sourceKind: 'browserDiagnostics',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    fidelity: 'injectedPage',
                    trusted: false,
                    eventCount: 3,
                    families: [
                        {
                            family: 'network',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'pageInfo',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                        {
                            family: 'performance',
                            status: 'available',
                            fidelity: 'injectedPage',
                            trusted: false,
                        },
                    ],
                    events: [
                        {
                            eventId: 'evt_ws_1',
                            family: 'network',
                            kind: 'network.websocketSummary',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_000,
                            summary: 'state: open; framesSent: 3; framesReceived: 4; messageCount: 7',
                        },
                        {
                            eventId: 'evt_perf_1',
                            family: 'performance',
                            kind: 'performance.vitals',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_100,
                            summary: 'lcpMs: 1200; clsScore: 0.05; inpMs: 80',
                        },
                        {
                            eventId: 'evt_caps_1',
                            family: 'pageInfo',
                            kind: 'pageInfo.capabilities',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 2_200,
                            summary: 'serviceWorker: yes; webgl: yes; webrtc: no',
                        },
                    ],
                }}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-performance-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-performance-row-evt_perf_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-row-evt_ws_1')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-pageInfo-row-evt_caps_1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('lcpMs: 1200');
        expect(screen.getTextContent()).toContain('framesSent: 3');
        expect(screen.getTextContent()).toContain('serviceWorker: yes');
        expect(screen.getTextContent()).not.toContain('secret');
    });

    it('renders typed family-specific detail bodies (network scalars, storage keys, resource entries) for the local owner', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();
        expect(mod?.BrowserDiagnosticsPanel).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsPanel) return;
        const Panel = mod.BrowserDiagnosticsPanel;

        const screen = await renderScreen(
            <Panel
                diagnostics={{
                    status: 'available',
                    sourceKind: 'browserDiagnostics',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    fidelity: 'cdp',
                    trusted: true,
                    eventCount: 3,
                    families: [
                        { family: 'network', status: 'available', fidelity: 'cdp', trusted: true },
                        { family: 'storage', status: 'available', fidelity: 'injectedPage', trusted: false },
                        { family: 'resources', status: 'available', fidelity: 'injectedPage', trusted: false },
                    ],
                    events: [
                        {
                            eventId: 'evt_net_1',
                            family: 'network',
                            kind: 'network.response',
                            fidelity: 'cdp',
                            trusted: true,
                            capturedAtMs: 3_000,
                            summary: 'GET https://example.test/api',
                            detail: {
                                fields: [
                                    { key: 'method', value: 'GET' },
                                    { key: 'statusCode', value: 200 },
                                    { key: 'durationMs', value: 42 },
                                ],
                            },
                        },
                        {
                            eventId: 'evt_storage_1',
                            family: 'storage',
                            kind: 'storage.keyInventory',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 3_100,
                            summary: 'localStorage: 2 keys',
                            detail: {
                                fields: [{ key: 'storageType', value: 'localStorage' }, { key: 'keyCount', value: 2 }],
                                keys: ['theme', 'lastRoute'],
                            },
                        },
                        {
                            eventId: 'evt_res_1',
                            family: 'resources',
                            kind: 'resources.snapshot',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 3_200,
                            detail: {
                                fields: [],
                                entries: [{ name: 'app.js', initiatorType: 'script', durationMs: 12 }],
                            },
                        },
                    ],
                }}
                testID="browser-diagnostics"
            />,
        );

        // Network: typed scalar field rows (not just the collapsed summary).
        expect(screen.findByTestId('browser-diagnostics-network-row-evt_net_1-field-method')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-row-evt_net_1-field-statusCode')).toBeTruthy();
        // Storage: the key inventory list renders the actual key names.
        expect(screen.findByTestId('browser-diagnostics-storage-row-evt_storage_1-keys')).toBeTruthy();
        expect(screen.getTextContent()).toContain('theme');
        expect(screen.getTextContent()).toContain('lastRoute');
        // Resources: the resource entry renders name + initiator + timing.
        expect(screen.findByTestId('browser-diagnostics-resources-row-evt_res_1-entries')).toBeTruthy();
        expect(screen.getTextContent()).toContain('app.js');
    });

    it('renders distinct devtools bodies for console, network, websocket, elements, storage, performance, and page data', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();
        expect(mod?.BrowserDiagnosticsPanel).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsPanel) return;
        const Panel = mod.BrowserDiagnosticsPanel;

        const screen = await renderScreen(
            <Panel
                diagnostics={{
                    status: 'available',
                    sourceKind: 'browserDiagnostics',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    fidelity: 'cdp',
                    trusted: true,
                    eventCount: 7,
                    families: [
                        { family: 'console', status: 'available', fidelity: 'injectedPage', trusted: false },
                        { family: 'network', status: 'available', fidelity: 'cdp', trusted: true },
                        { family: 'elements', status: 'available', fidelity: 'injectedPage', trusted: false },
                        { family: 'storage', status: 'available', fidelity: 'injectedPage', trusted: false },
                        { family: 'performance', status: 'available', fidelity: 'injectedPage', trusted: false },
                        { family: 'pageInfo', status: 'available', fidelity: 'injectedPage', trusted: false },
                    ],
                    events: [
                        {
                            eventId: 'evt_console_text',
                            family: 'console',
                            kind: 'console.entry',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 3_000,
                            detail: {
                                fields: [
                                    { key: 'level', value: 'warn' },
                                    { key: 'argCount', value: 2 },
                                    { key: 'text', value: 'owner visible warning' },
                                ],
                            },
                        },
                        {
                            eventId: 'evt_net_response',
                            family: 'network',
                            kind: 'network.response',
                            fidelity: 'cdp',
                            trusted: true,
                            capturedAtMs: 3_100,
                            detail: {
                                fields: [
                                    { key: 'method', value: 'POST' },
                                    { key: 'url', value: 'https://example.test/api/session' },
                                    { key: 'statusCode', value: 201 },
                                    { key: 'durationMs', value: 42 },
                                    { key: 'responseBytes', value: 2048 },
                                    { key: 'requestHeaders', value: 'content-type: application/json' },
                                    { key: 'responseHeaders', value: 'x-request-id: res-1' },
                                    { key: 'requestBodyText', value: 'owner request body' },
                                    { key: 'responseBodyText', value: 'owner response body' },
                                ],
                            },
                        },
                        {
                            eventId: 'evt_ws_summary',
                            family: 'network',
                            kind: 'network.websocketSummary',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 3_200,
                            detail: {
                                fields: [
                                    { key: 'socketId', value: 'ws_1' },
                                    { key: 'state', value: 'open' },
                                    { key: 'framesSent', value: 3 },
                                    { key: 'framesReceived', value: 4 },
                                    { key: 'messageCount', value: 7 },
                                ],
                            },
                        },
                        {
                            eventId: 'evt_element_pick',
                            family: 'elements',
                            kind: 'elements.pickerState',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 3_300,
                            detail: {
                                fields: [
                                    { key: 'state', value: 'selected' },
                                    { key: 'selectorPath', value: 'main > button.primary' },
                                    { key: 'backendNodeRef', value: 'node_42' },
                                    { key: 'rectAvailable', value: true },
                                    { key: 'accessibleNameAvailable', value: true },
                                ],
                            },
                        },
                        {
                            eventId: 'evt_storage_keys',
                            family: 'storage',
                            kind: 'storage.keyInventory',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 3_400,
                            detail: {
                                fields: [
                                    { key: 'storageType', value: 'localStorage' },
                                    { key: 'keyCount', value: 2 },
                                ],
                                keys: ['theme', 'lastRoute'],
                                storageEntries: [
                                    { key: 'theme', value: 'dark', valueTruncated: false },
                                    { key: 'lastRoute', value: '/settings', valueTruncated: false },
                                ],
                            },
                        },
                        {
                            eventId: 'evt_perf',
                            family: 'performance',
                            kind: 'performance.vitals',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 3_500,
                            detail: {
                                fields: [
                                    { key: 'lcpMs', value: 1200 },
                                    { key: 'clsScore', value: 0.05 },
                                    { key: 'inpMs', value: 80 },
                                ],
                            },
                        },
                        {
                            eventId: 'evt_caps',
                            family: 'pageInfo',
                            kind: 'pageInfo.capabilities',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 3_600,
                            detail: {
                                fields: [
                                    { key: 'serviceWorker', value: true },
                                    { key: 'webgl', value: false },
                                ],
                            },
                        },
                    ],
                }}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-console-entry-evt_console_text-text')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-request-evt_net_response-method')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-request-evt_net_response-status')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-request-evt_net_response-url')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-request-evt_net_response-duration')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-request-evt_net_response-requestHeaders')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-request-evt_net_response-responseBodyText')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-network-websocket-evt_ws_summary-metric-framesSent')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-elements-selection-evt_element_pick-selector')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-storage-key-evt_storage_keys-0')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-storage-entry-evt_storage_keys-0')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-performance-metric-evt_perf-lcpMs')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-pageInfo-field-evt_caps-serviceWorker')).toBeTruthy();
    });

    it('scrubs sensitive summary clauses before using them in network request cells', async () => {
        const mod = await loadBrowserDiagnosticsPanelModule();
        expect(mod?.BrowserDiagnosticsPanel).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsPanel) return;
        const Panel = mod.BrowserDiagnosticsPanel;

        const screen = await renderScreen(
            <Panel
                diagnostics={{
                    status: 'available',
                    sourceKind: 'browserDiagnostics',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    fidelity: 'injectedPage',
                    trusted: false,
                    eventCount: 1,
                    families: [
                        { family: 'network', status: 'available', fidelity: 'injectedPage', trusted: false },
                    ],
                    events: [
                        {
                            eventId: 'evt_net_sensitive',
                            family: 'network',
                            kind: 'network.response',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 3_000,
                            summary: 'url=https://example.test/api?token=secret; method: GET',
                            detail: {
                                fields: [
                                    { key: 'method', value: 'GET' },
                                    { key: 'statusCode', value: 200 },
                                ],
                            },
                        },
                    ],
                }}
                testID="browser-diagnostics"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-network-request-evt_net_sensitive-url')).toBeTruthy();
        expect(screen.getTextContent()).toContain('method: GET');
        expect(screen.getTextContent()).not.toContain('token=secret');
    });
});
