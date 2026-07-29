import type { DaemonBrowserRecordingStartInputV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  resolveBrowserRecordingStartContext,
  resolveBrowserRecordingStreamFrameStartContext,
} from './startContext';

function createStartInput(
  overrides: Partial<DaemonBrowserRecordingStartInputV1> = {},
): DaemonBrowserRecordingStartInputV1 {
  return {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'simulatorPreview',
    adapterKind: 'simulatorPreview',
    renderEngineKind: 'streamedSurface',
    captureKind: 'streamFrameCapture',
    fidelity: 'streamFrame',
    navigationGeneration: 1,
    mimeType: 'video/webm',
    retentionClass: 'preSend',
    ...overrides,
  };
}

describe('resolveBrowserRecordingStreamFrameStartContext', () => {
  it('enables stream-frame recording with a live-stream registry present', () => {
    const context = resolveBrowserRecordingStreamFrameStartContext({
      hasLiveStreamCaptureRegistry: true,
    })(createStartInput());

    expect(context.browserRecordingEnabled).toBe(true);
    expect(context.recordingCapabilities.enabled).toBe(true);
    expect(context.recordingCapabilities.available).toBe(true);
    expect(context.recordingCapabilities.supportedCaptureKinds).toEqual(['streamFrameCapture']);
    expect(context.recordingCapabilities.supportedMimeTypes).toEqual(['video/webm']);
    expect(context.recordingCapabilities.supportedCaptureKinds).not.toContain('nativeViewCapture');
    expect(context.recordingCapabilities.supportedCaptureKinds).not.toContain('webContentsCapture');
  });

  it('stays fail-closed when no live-stream registry exists (no producer)', () => {
    const context = resolveBrowserRecordingStreamFrameStartContext({
      hasLiveStreamCaptureRegistry: false,
    })(createStartInput());

    expect(context.browserRecordingEnabled).toBe(false);
    expect(context.recordingCapabilities.enabled).toBe(false);
    expect(context.recordingCapabilities.available).toBe(false);
    expect(context.recordingCapabilities.disabledReasons.length).toBeGreaterThan(0);
  });

  it('scopes supported adapters to producer-backed stream surfaces only (never localPreview/chromiumSidecar/hostedPlugin)', () => {
    const context = resolveBrowserRecordingStreamFrameStartContext({
      hasLiveStreamCaptureRegistry: true,
    })(createStartInput());

    // Only streamed/simulator live surfaces — never local iframe previews, desktop webview engines,
    // or plugin/sidecar chrome.
    expect(context.recordingCapabilities.supportedAdapterKinds).toEqual(
      expect.arrayContaining(['streamedBrowserSurface', 'simulatorPreview']),
    );
    expect(context.recordingCapabilities.supportedAdapterKinds).not.toContain('localPreview');
    expect(context.recordingCapabilities.supportedAdapterKinds).not.toContain('chromiumSidecar');
    expect(context.recordingCapabilities.supportedAdapterKinds).not.toContain('hostedPlugin');
  });
});

describe('resolveBrowserRecordingStartContext (composed producer matrix)', () => {
  it('stays fail-closed when neither producer is wired', () => {
    const context = resolveBrowserRecordingStartContext({
      hasLiveStreamCaptureRegistry: false,
      hasNativeViewCapture: false,
    })(createStartInput());

    expect(context.browserRecordingEnabled).toBe(false);
    expect(context.recordingCapabilities.available).toBe(false);
    expect(context.recordingCapabilities.supportedCaptureKinds).toEqual([]);
  });

  it('enables ONLY the desktop nativeViewCapture cell when only the native producer is bound', () => {
    const context = resolveBrowserRecordingStartContext({
      hasLiveStreamCaptureRegistry: false,
      hasNativeViewCapture: true,
    })(createStartInput({
      captureKind: 'nativeViewCapture',
      adapterKind: 'externalUrl',
      renderEngineKind: 'desktopWebView',
      mimeType: 'image/png',
    }));

    expect(context.browserRecordingEnabled).toBe(true);
    expect(context.recordingCapabilities.available).toBe(true);
    expect(context.recordingCapabilities.supportedCaptureKinds).toEqual(['nativeViewCapture']);
    expect(context.recordingCapabilities.supportedMimeTypes).toEqual(['image/png']);
    expect(context.recordingCapabilities.supportedAdapterKinds).toEqual(['externalUrl']);
    expect(context.captureSourceAvailable).toBe(true);
    // BRW-15: the native producer never advertises the stream-frame capture kind.
    expect(context.recordingCapabilities.supportedCaptureKinds).not.toContain('streamFrameCapture');
  });

  it('enables ONLY the managed-Chromium cdpScreencast cell when only the sidecar producer is bound', () => {
    const context = resolveBrowserRecordingStartContext({
      hasLiveStreamCaptureRegistry: false,
      hasNativeViewCapture: false,
      hasCdpScreencast: true,
    })(createStartInput({
      targetKind: 'externalUrl',
      adapterKind: 'chromiumSidecar',
      renderEngineKind: 'unavailable',
      captureKind: 'cdpScreencast',
      fidelity: 'cdp',
    }));

    expect(context.browserRecordingEnabled).toBe(true);
    expect(context.recordingCapabilities.available).toBe(true);
    expect(context.recordingCapabilities.supportedCaptureKinds).toEqual(['cdpScreencast']);
    expect(context.recordingCapabilities.supportedMimeTypes).toEqual(['video/webm']);
    expect(context.recordingCapabilities.supportedAdapterKinds).toEqual(['chromiumSidecar']);
    expect(context.recordingCapabilities.supportedCaptureKinds).not.toContain('streamFrameCapture');
    expect(context.recordingCapabilities.supportedCaptureKinds).not.toContain('nativeViewCapture');
  });

  it('advertises the honest union when ALL producers are wired (each scoped to its own kind/adapter/mime)', () => {
    const context = resolveBrowserRecordingStartContext({
      hasLiveStreamCaptureRegistry: true,
      hasNativeViewCapture: true,
      hasCdpScreencast: true,
    })(createStartInput());

    expect(context.browserRecordingEnabled).toBe(true);
    expect(context.recordingCapabilities.supportedCaptureKinds).toEqual(
      expect.arrayContaining(['streamFrameCapture', 'nativeViewCapture', 'cdpScreencast']),
    );
    expect(context.recordingCapabilities.supportedMimeTypes).toEqual(
      expect.arrayContaining(['video/webm', 'image/png']),
    );
    expect(context.recordingCapabilities.supportedAdapterKinds).toEqual(
      expect.arrayContaining(['streamedBrowserSurface', 'simulatorPreview', 'externalUrl', 'chromiumSidecar']),
    );
    expect(context.recordingCapabilities.supportedAdapterKinds).not.toContain('localPreview');
    // Never surface an unbacked desktop producer just because the stream producer is present.
    expect(context.recordingCapabilities.supportedCaptureKinds).not.toContain('webContentsCapture');
  });
});
