import * as React from 'react';
import type { BrowserRecordingCapabilities } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { createBrowserRecordingState } from '@/sync/domains/browser/recording';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            if (key === 'browserRecording.fidelity.pixel') return 'Visual capture';
            if (key === 'browserRecording.fidelity.unavailable') return 'Capture pending';
            if (key === 'browserRecording.fidelity.cdp') return 'Browser capture';
            if (key === 'browserRecording.fidelity.injectedPage') return 'Page capture';
            if (key === 'browserRecording.fidelity.nativeCallback') return 'Native capture';
            if (key === 'browserRecording.fidelity.streamFrame') return 'Stream capture';
            return params ? `${key}:${JSON.stringify(params)}` : key;
        },
    });
});

const broadServerRecordingCapabilities = {
    enabled: true,
    attachmentsEnabled: true,
    available: true,
    supportedCaptureKinds: ['nativeViewCapture', 'cdpScreencast', 'streamFrameCapture'],
    supportedMimeTypes: ['image/png', 'video/webm'],
    supportedAdapterKinds: ['externalUrl', 'chromiumSidecar', 'streamedBrowserSurface', 'simulatorPreview'],
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

function createExternalView(): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target: {
            kind: 'externalUrl',
            targetId: 'external_1',
            url: 'http://127.0.0.1:51542/',
        },
        platform: 'web',
        adapterKind: 'externalUrl',
        engineKind: 'webIframe',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['webIframe'],
        }),
        currentUrl: 'http://127.0.0.1:51542/',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Session Inspector',
        faviconUrl: null,
        loadingState: 'idle',
        loadingProgress: null,
        navigationGeneration: 2,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: 'http://127.0.0.1:51542',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

function createExternalDesktopView(): BrowserControlViewState {
    return {
        ...createExternalView(),
        platform: 'desktop',
        engineKind: 'desktopWebView',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['desktopWebView'],
            desktopWebViewSupport: {
                navigation: true,
                nativeDevtools: true,
                pageInfoDiagnostics: true,
                capture: true,
                goBackForward: true,
                reload: true,
                stop: true,
                recording: true,
                automation: false,
            },
        }),
    };
}

describe('BrowserRecordingControls', () => {
    it('disables web iframe external-url recording when broad server capabilities only include desktop-native capture', async () => {
        const { BrowserRecordingControls } = await import('./BrowserRecordingControls');
        const onStartRecording = vi.fn();

        const screen = await renderScreen(
            <BrowserRecordingControls
                view={createExternalView()}
                profileId="profile_1"
                state={createBrowserRecordingState()}
                recordingCapabilities={broadServerRecordingCapabilities}
                enabled
                isCaptureSourceAvailable={({ captureKind }) => captureKind === 'nativeViewCapture'}
                onStartRecording={onStartRecording}
            />,
        );

        await screen.pressByTestIdAsync('browser-recording-controls-start');

        expect(onStartRecording).not.toHaveBeenCalled();
        expect(screen.findByTestId('browser-recording-controls-start')?.props.accessibilityState)
            .toMatchObject({ disabled: true });
    });

    it('starts desktop external recording with the compatible native capture profile', async () => {
        const { BrowserRecordingControls } = await import('./BrowserRecordingControls');
        const onStartRecording = vi.fn();

        const screen = await renderScreen(
            <BrowserRecordingControls
                view={createExternalDesktopView()}
                profileId="profile_1"
                state={createBrowserRecordingState()}
                recordingCapabilities={broadServerRecordingCapabilities}
                enabled
                isCaptureSourceAvailable={({ captureKind }) => captureKind === 'nativeViewCapture'}
                onStartRecording={onStartRecording}
            />,
        );

        await screen.pressByTestIdAsync('browser-recording-controls-start');

        expect(onStartRecording).toHaveBeenCalledWith(expect.objectContaining({
            adapterKind: 'externalUrl',
            captureKind: 'nativeViewCapture',
            mimeType: 'image/png',
            retentionClass: 'preSend',
        }));
    });

    it('does not advertise desktop native recording without an active reverse-capture handler', async () => {
        const { BrowserRecordingControls } = await import('./BrowserRecordingControls');
        const onStartRecording = vi.fn();

        const screen = await renderScreen(
            <BrowserRecordingControls
                view={createExternalDesktopView()}
                profileId="profile_1"
                state={createBrowserRecordingState()}
                recordingCapabilities={broadServerRecordingCapabilities}
                enabled
                onStartRecording={onStartRecording}
            />,
        );

        await screen.pressByTestIdAsync('browser-recording-controls-start');

        expect(onStartRecording).not.toHaveBeenCalled();
        expect(screen.findByTestId('browser-recording-controls-start')?.props.accessibilityState)
            .toMatchObject({ disabled: true });
        expect(screen.findByTestId('browser-recording-controls-status-capture-unavailable')).toBeTruthy();
    });

    it('renders recording fidelity as product copy instead of raw protocol enum ids', async () => {
        const { BrowserRecordingControls } = await import('./BrowserRecordingControls');

        const screen = await renderScreen(
            <BrowserRecordingControls
                view={createExternalDesktopView()}
                profileId="profile_1"
                state={createBrowserRecordingState()}
                recordingCapabilities={broadServerRecordingCapabilities}
                enabled
                fidelity="streamFrame"
                isCaptureSourceAvailable={({ captureKind }) => captureKind === 'nativeViewCapture'}
                onStartRecording={vi.fn()}
            />,
        );

        const text = screen.getTextContent();
        expect(text).toContain('Stream capture');
        expect(text).not.toContain('"streamFrame"');
        expect(text).not.toContain('(streamFrame)');
    });
});
