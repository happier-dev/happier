import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type {
    BrowserPreviewProxyDiagnosticsProjection,
    BrowserViewDiagnosticsProjection,
} from '@/sync/domains/browser/diagnostics';

import type { BrowserDiagnosticsInteractionControls } from './BrowserDiagnosticsInteractionPanel';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const reducedMotionRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionRef.value,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

type BrowserDiagnosticsDrawerModule = Readonly<{
    BrowserDiagnosticsDrawer?: React.ComponentType<{
        diagnostics: unknown;
        interaction?: BrowserDiagnosticsInteractionControls;
        testID?: string;
    }>;
}>;

async function loadDrawer(): Promise<BrowserDiagnosticsDrawerModule | null> {
    const path = './BrowserDiagnosticsDrawer';
    return import(path) as Promise<BrowserDiagnosticsDrawerModule | null>;
}

const hostDiagnostics: BrowserViewDiagnosticsProjection = {
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
            family: 'elements',
            status: 'available',
            fidelity: 'injectedPage',
            trusted: false,
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
            kind: 'elements.snapshot',
            fidelity: 'injectedPage',
            trusted: false,
            capturedAtMs: 2_100,
            summary: 'main#app',
        },
    ],
};

function hostDiagnosticsFor(viewId: string): BrowserViewDiagnosticsProjection {
    return { ...hostDiagnostics, viewId };
}

describe('BrowserDiagnosticsDrawer', () => {
    it('toggles between expanded and collapsed drawer states and can close to a peek', async () => {
        const mod = await loadDrawer();
        expect(mod?.BrowserDiagnosticsDrawer).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsDrawer) return;

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsDrawer
                diagnostics={hostDiagnosticsFor('view_toggle')}
                testID="browser-diagnostics-drawer"
            />,
        );

        // Default open: expanded; body and section tabs visible.
        expect(screen.findByTestId('browser-diagnostics-drawer-container-expanded')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body')).toBeTruthy();

        // Collapse to the peek-height state.
        await screen.pressByTestIdAsync('browser-diagnostics-drawer-collapse');
        expect(screen.findByTestId('browser-diagnostics-drawer-container-collapsed')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body')).toBeTruthy();

        // Expand again back to full.
        await screen.pressByTestIdAsync('browser-diagnostics-drawer-expand');
        expect(screen.findByTestId('browser-diagnostics-drawer-container-expanded')).toBeTruthy();

        // Close hides the body, keeping only the handle/peek + reopen affordance.
        await screen.pressByTestIdAsync('browser-diagnostics-drawer-close');
        expect(screen.findByTestId('browser-diagnostics-drawer-container-closed')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body')).toBeNull();
        expect(screen.findByTestId('browser-diagnostics-drawer-open')).toBeTruthy();
    });

    it('renders one section tab per present family and shows a single family at a time', async () => {
        const mod = await loadDrawer();
        expect(mod?.BrowserDiagnosticsDrawer).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsDrawer) return;

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsDrawer
                diagnostics={hostDiagnosticsFor('view_tabs')}
                testID="browser-diagnostics-drawer"
            />,
        );

        // A tab per present family.
        expect(screen.findByTestId('browser-diagnostics-drawer-tab-console')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-tab-elements')).toBeTruthy();
        // No tab for absent families.
        expect(screen.findByTestId('browser-diagnostics-drawer-tab-network')).toBeNull();

        // Default section is the first family (console). Only console panel renders.
        expect(screen.findByTestId('browser-diagnostics-drawer-body-console-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-elements-panel')).toBeNull();
        // Active-family fidelity badge is present (no fidelity regression).
        expect(screen.findByTestId('browser-diagnostics-drawer-body-fidelity-injectedPage')).toBeTruthy();

        // Switching to elements shows the elements panel and hides console.
        await screen.pressByTestIdAsync('browser-diagnostics-drawer-tab-elements');
        expect(screen.findByTestId('browser-diagnostics-drawer-body-elements-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-console-panel')).toBeNull();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-fidelity-injectedPage')).toBeTruthy();
    });

    it('routes page errors through a console-grade section and persists the active section per view', async () => {
        const mod = await loadDrawer();
        expect(mod?.BrowserDiagnosticsDrawer).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsDrawer) return;

        const diagnostics: BrowserViewDiagnosticsProjection = {
            ...hostDiagnostics,
            viewId: 'view_page_errors',
            eventCount: 2,
            families: [
                { family: 'console', status: 'available', fidelity: 'injectedPage', trusted: false },
                { family: 'pageError', status: 'available', fidelity: 'injectedPage', trusted: false },
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
                    eventId: 'evt_page_error_1',
                    family: 'pageError',
                    kind: 'pageError.thrown',
                    fidelity: 'injectedPage',
                    trusted: false,
                    capturedAtMs: 2_100,
                    summary: 'TypeError: failed',
                    detail: {
                        fields: [{ key: 'message', value: 'TypeError: failed' }],
                    },
                },
            ],
        };

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsDrawer
                diagnostics={diagnostics}
                testID="browser-diagnostics-drawer"
            />,
        );

        await screen.pressByTestIdAsync('browser-diagnostics-drawer-tab-pageError');
        expect(screen.findByTestId('browser-diagnostics-drawer-body-pageError-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-console-panel')).toBeNull();
        expect(screen.getTextContent()).not.toContain('pageError - page.error');

        await screen.unmount();

        const remounted = await renderScreen(
            <mod.BrowserDiagnosticsDrawer
                diagnostics={{
                    ...diagnostics,
                    navigationGeneration: 3,
                    events: [{
                        eventId: 'evt_page_error_2',
                        family: 'pageError',
                        kind: 'pageError.thrown',
                        fidelity: 'injectedPage',
                        trusted: false,
                        capturedAtMs: 3_100,
                        summary: 'ReferenceError: missing',
                    }],
                }}
                testID="browser-diagnostics-drawer"
            />,
        );

        expect(remounted.findByTestId('browser-diagnostics-drawer-body-pageError-panel')).toBeTruthy();
        expect(remounted.findByTestId('browser-diagnostics-drawer-body-console-panel')).toBeNull();
    });

    it('surfaces the trusted element picker only on the Elements section', async () => {
        const mod = await loadDrawer();
        expect(mod?.BrowserDiagnosticsDrawer).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsDrawer) return;

        let startCount = 0;
        const enabledIdle: BrowserDiagnosticsInteractionControls = {
            state: 'enabled',
            ownerOnly: true,
            pickerState: 'idle',
            onStartElementPicker: () => {
                startCount += 1;
            },
        };

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsDrawer
                diagnostics={hostDiagnosticsFor('view_picker')}
                interaction={enabledIdle}
                testID="browser-diagnostics-drawer"
            />,
        );

        // Console section: the picker affordance is not shown.
        expect(screen.findByTestId('browser-diagnostics-drawer-body-picker-start')).toBeNull();

        // Switch to Elements: the start-picker affordance becomes reachable.
        await screen.pressByTestIdAsync('browser-diagnostics-drawer-tab-elements');
        expect(screen.findByTestId('browser-diagnostics-drawer-body-picker-start')).toBeTruthy();
        screen.pressByTestId('browser-diagnostics-drawer-body-picker-start');
        expect(startCount).toBe(1);
    });

    it('surfaces the eval console on Console and keeps the element picker isolated to Elements', async () => {
        const mod = await loadDrawer();
        expect(mod?.BrowserDiagnosticsDrawer).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsDrawer) return;

        let startCount = 0;
        const onSubmitExpression = vi.fn(() => true);
        const enabledWithEval: BrowserDiagnosticsInteractionControls = {
            state: 'enabled',
            ownerOnly: true,
            pickerState: 'idle',
            onStartElementPicker: () => {
                startCount += 1;
            },
            evalConsole: {
                entries: [],
                objectProperties: {},
                onSubmitExpression,
                onExpandObject: vi.fn(() => true),
            },
        };

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsDrawer
                diagnostics={hostDiagnosticsFor('view_eval')}
                interaction={enabledWithEval}
                testID="browser-diagnostics-drawer"
            />,
        );

        // Console section: eval is reachable, but the element picker is not.
        expect(screen.findByTestId('browser-diagnostics-drawer-body-eval-console')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-picker-start')).toBeNull();

        // Elements section: picker is reachable, but the console REPL is not duplicated here.
        await screen.pressByTestIdAsync('browser-diagnostics-drawer-tab-elements');
        expect(screen.findByTestId('browser-diagnostics-drawer-body-picker-start')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-eval-console')).toBeNull();
        screen.pressByTestId('browser-diagnostics-drawer-body-picker-start');
        expect(startCount).toBe(1);
    });

    it('keeps the picker ungated when interaction is disabled (fail-closed)', async () => {
        const mod = await loadDrawer();
        expect(mod?.BrowserDiagnosticsDrawer).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsDrawer) return;

        const disabled: BrowserDiagnosticsInteractionControls = {
            state: 'disabled',
            ownerOnly: true,
            canEnable: true,
            pickerState: 'idle',
            onEnableInteraction: () => undefined,
        };

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsDrawer
                diagnostics={hostDiagnosticsFor('view_disabled_picker')}
                interaction={disabled}
                testID="browser-diagnostics-drawer"
            />,
        );

        await screen.pressByTestIdAsync('browser-diagnostics-drawer-tab-elements');
        // No start-picker affordance while interaction is disabled.
        expect(screen.findByTestId('browser-diagnostics-drawer-body-picker-start')).toBeNull();
        // The enable-interaction affordance is the only control surfaced.
        expect(screen.findByTestId('browser-diagnostics-drawer-body-interaction-enable')).toBeTruthy();
    });

    it('renders the preview-proxy projection as a single section without family tabs', async () => {
        const mod = await loadDrawer();
        expect(mod?.BrowserDiagnosticsDrawer).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsDrawer) return;

        const previewProxy: BrowserPreviewProxyDiagnosticsProjection = {
            status: 'available',
            sourceKind: 'previewProxy',
            fidelity: 'previewProxy',
            trusted: true,
            attribution: 'traffic_for_preview_all_views',
            activeFlowCount: 1,
            families: [],
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
        };

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsDrawer
                diagnostics={previewProxy}
                testID="browser-diagnostics-drawer"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-drawer-body')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-fidelity-previewProxy')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-flow-tunnel_1')).toBeTruthy();
    });

    it('keeps the active performance section and drawer state across diagnostics refreshes', async () => {
        const mod = await loadDrawer();
        expect(mod?.BrowserDiagnosticsDrawer).toBeTypeOf('function');
        if (!mod?.BrowserDiagnosticsDrawer) return;

        const diagnostics: BrowserViewDiagnosticsProjection = {
            status: 'available',
            sourceKind: 'browserDiagnostics',
            browserSessionId: 'browser_session_1',
            viewId: 'view_performance',
            navigationGeneration: 2,
            fidelity: 'injectedPage',
            trusted: false,
            eventCount: 2,
            families: [
                { family: 'console', status: 'available', fidelity: 'injectedPage', trusted: false },
                { family: 'performance', status: 'available', fidelity: 'injectedPage', trusted: false },
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
                    eventId: 'evt_perf_1',
                    family: 'performance',
                    kind: 'performance.vitals',
                    fidelity: 'injectedPage',
                    trusted: false,
                    capturedAtMs: 2_100,
                    detail: {
                        fields: [{ key: 'lcpMs', value: 1200 }],
                    },
                },
            ],
        };

        const screen = await renderScreen(
            <mod.BrowserDiagnosticsDrawer
                diagnostics={diagnostics}
                testID="browser-diagnostics-drawer"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-drawer-tab-performance')).toBeTruthy();
        await screen.pressByTestIdAsync('browser-diagnostics-drawer-tab-performance');
        expect(screen.findByTestId('browser-diagnostics-drawer-body-performance-panel')).toBeTruthy();

        await screen.pressByTestIdAsync('browser-diagnostics-drawer-collapse');
        expect(screen.findByTestId('browser-diagnostics-drawer-container-collapsed')).toBeTruthy();

        await screen.update(
            <mod.BrowserDiagnosticsDrawer
                diagnostics={{
                    ...diagnostics,
                    navigationGeneration: 3,
                    eventCount: 1,
                    events: [
                        {
                            eventId: 'evt_perf_2',
                            family: 'performance',
                            kind: 'performance.vitals',
                            fidelity: 'injectedPage',
                            trusted: false,
                            capturedAtMs: 3_100,
                            detail: {
                                fields: [{ key: 'lcpMs', value: 980 }],
                            },
                        },
                    ],
                }}
                testID="browser-diagnostics-drawer"
            />,
        );

        expect(screen.findByTestId('browser-diagnostics-drawer-container-collapsed')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-performance-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-console-panel')).toBeNull();
        expect(screen.findByTestId('browser-diagnostics-drawer-body-performance-metric-evt_perf_2-lcpMs')).toBeTruthy();
    });
});
