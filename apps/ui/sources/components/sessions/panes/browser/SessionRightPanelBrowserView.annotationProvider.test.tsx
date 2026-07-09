import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const browserSurfaceHostSpy = vi.hoisted(() => vi.fn());

const sessionRuntimeState = vi.hoisted(() => ({
    runtime: null as Record<string, unknown> | null,
    preferredServerId: 'server_1' as string | null,
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/browser/surfaces', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => {
        browserSurfaceHostSpy(props);
        return React.createElement('BrowserSurfaceHostMock', {
            ...props,
            testID: props.testID ?? 'session-rightpanel-browser',
        });
    },
}));

vi.mock('@/components/browser/surfaces/useBrowserSurfaceHostProps', () => ({
    useBrowserSurfaceHostProps: () => ({
        browserSessionId: 'browser_session_1',
        platform: 'web',
        initialBrowserState: {
            sessionsById: {},
            viewsById: {},
            currentTarget: null,
        },
        surfaceKey: 'surface_1',
        presentationSlotId: 'slot_1',
        launchpadRows: [],
        launchpadRefreshStatus: 'idle',
        launchpadRefreshError: null,
        localServicePreviewState: null,
        localServicePreviewServerId: 'server_1',
        onLifecycleChange: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: 'machine_1' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => sessionRuntimeState.preferredServerId,
}));

vi.mock('@/sync/domains/browser/control', () => ({
    useBrowserDaemonControlTransport: () => vi.fn(),
}));

vi.mock('@/components/sessions/browser/sessionBrowserContextRuntime', () => ({
    useSessionBrowserContextRuntimeContext: () => sessionRuntimeState.runtime,
}));

describe('SessionRightPanelBrowserView annotation provider', () => {
    beforeEach(() => {
        browserSurfaceHostSpy.mockClear();
        sessionRuntimeState.preferredServerId = 'server_1';
        sessionRuntimeState.runtime = {
            state: {
                itemsById: {},
                itemOrder: [],
                attachmentsById: {},
                attachmentOrder: [],
                navigationGenerationByViewId: {},
                activeAnnotationByViewId: {},
                annotationDraftByViewId: {},
            },
            browserShellContext: {
                state: {
                    itemsById: {},
                    itemOrder: [],
                    attachmentsById: {},
                    attachmentOrder: [],
                    navigationGenerationByViewId: {},
                    activeAnnotationByViewId: {},
                    annotationDraftByViewId: {},
                },
                contextCapabilities: {
                    enabled: true,
                    available: true,
                    supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
                    supportedAdapterKinds: ['chromiumSidecar'],
                    screenshot: { supported: true, requiresAttachmentUploads: true },
                    text: { maxSelectionChars: 2048, maxSummaryChars: 8192 },
                    disabledReasons: [],
                    policyDeniedReasons: [],
                },
                enabled: true,
                attachmentsUploadsEnabled: true,
                annotationCaptureProvider: null,
                onStateChange: vi.fn(),
            },
            composerContext: {
                state: {
                    itemsById: {},
                    itemOrder: [],
                    attachmentsById: {},
                    attachmentOrder: [],
                    navigationGenerationByViewId: {},
                    activeAnnotationByViewId: {},
                    annotationDraftByViewId: {},
                },
                onRemoveAttachment: vi.fn(),
            },
        };
    });

    it('threads managed-Chromium annotation capture through the BrowserShell context provider', async () => {
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');

        const screen = await renderScreen(<SessionRightPanelBrowserView sessionId="session_1" />);
        const host = screen.findByTestId('session-rightpanel-browser');
        const browserContext = host?.props.browserContext as {
            annotationCaptureProvider?: { available?: boolean };
        } | undefined;

        expect(browserContext?.annotationCaptureProvider?.available).toBe(true);
    });

    it('keeps managed annotation capture available when the active server scope is implicit', async () => {
        sessionRuntimeState.preferredServerId = null;
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');

        const screen = await renderScreen(<SessionRightPanelBrowserView sessionId="session_1" />);
        const host = screen.findByTestId('session-rightpanel-browser');
        const browserContext = host?.props.browserContext as {
            annotationCaptureProvider?: { available?: boolean };
        } | undefined;

        expect(browserContext?.annotationCaptureProvider?.available).toBe(true);
    });

    it('mounts the session recording product model into the browser host', async () => {
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');

        const screen = await renderScreen(<SessionRightPanelBrowserView sessionId="session_1" />);
        const host = screen.findByTestId('session-rightpanel-browser');

        expect(host?.props.browserRecording?.state).toBeTruthy();
        expect(host?.props.browserRecording?.recordingCapabilities).toBeTruthy();
    });

    it('enables the route-stable browser keep-alive portal for the production right panel host', async () => {
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');

        const screen = await renderScreen(<SessionRightPanelBrowserView sessionId="session_1" />);
        const host = screen.findByTestId('session-rightpanel-browser');

        expect(host?.props.presentationSlotId).toBe('slot_1');
        expect(host?.props.keepAliveAboveRouter).toBe(true);
    });
});
