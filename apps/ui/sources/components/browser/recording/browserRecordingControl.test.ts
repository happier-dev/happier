import type { BrowserRecordingCapabilities } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { createBrowserRecordingState } from '@/sync/domains/browser/recording';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
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

describe('resolveBrowserRecordingControl', () => {
    it('refuses web iframe external-url recording when the only capture the server offers is desktop-native', async () => {
        const { resolveBrowserRecordingControl } = await import('./browserRecordingControl');
        const control = resolveBrowserRecordingControl({
            view: createExternalView(),
            profileId: 'profile_1',
            state: createBrowserRecordingState(),
            recordingCapabilities: broadServerRecordingCapabilities,
            enabled: true,
            isCaptureSourceAvailable: ({ captureKind }) => captureKind === 'nativeViewCapture',
        });
        expect(control.startRequest).toBeNull();
        expect(control.unavailable?.message).toBeTruthy();
    });

    it('starts desktop external recording with the compatible native capture profile', async () => {
        const { resolveBrowserRecordingControl } = await import('./browserRecordingControl');
        const control = resolveBrowserRecordingControl({
            view: createExternalDesktopView(),
            profileId: 'profile_1',
            state: createBrowserRecordingState(),
            recordingCapabilities: broadServerRecordingCapabilities,
            enabled: true,
            isCaptureSourceAvailable: ({ captureKind }) => captureKind === 'nativeViewCapture',
        });
        expect(control.unavailable).toBeNull();
        expect(control.startRequest).toMatchObject({
            adapterKind: 'externalUrl',
            captureKind: 'nativeViewCapture',
            mimeType: 'image/png',
            retentionClass: 'preSend',
        });
    });

    it('does not offer desktop native recording without an active reverse-capture handler', async () => {
        const { resolveBrowserRecordingControl } = await import('./browserRecordingControl');
        const control = resolveBrowserRecordingControl({
            view: createExternalDesktopView(),
            profileId: 'profile_1',
            state: createBrowserRecordingState(),
            recordingCapabilities: broadServerRecordingCapabilities,
            enabled: true,
        });
        expect(control.startRequest).toBeNull();
        expect(control.unavailable?.policyState).toBe('captureUnavailable');
    });
});
