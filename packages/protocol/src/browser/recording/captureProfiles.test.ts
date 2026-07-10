import { describe, expect, it } from 'vitest';

import type { BrowserRecordingCapabilities } from '../../features/payload/capabilities/browserCapabilities.js';

import {
  resolveBrowserRecordingCaptureProfile,
  resolveBrowserRecordingProfileUnavailableReason,
} from './captureProfiles.js';

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

describe('browser recording capture profiles', () => {
  it('selects the first compatible capture/mime tuple for each adapter instead of the first flattened capability value', () => {
    expect(resolveBrowserRecordingCaptureProfile({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'externalUrl',
      renderEngineKind: 'desktopWebView',
      captureSourceAvailable: true,
      retentionClass: 'preSend',
    })).toMatchObject({
      captureKind: 'nativeViewCapture',
      mimeType: 'image/png',
      retentionClass: 'preSend',
    });

    expect(resolveBrowserRecordingCaptureProfile({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'chromiumSidecar',
      retentionClass: 'preSend',
    })).toMatchObject({
      captureKind: 'cdpScreencast',
      mimeType: 'video/webm',
      retentionClass: 'preSend',
    });

    expect(resolveBrowserRecordingCaptureProfile({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'simulatorPreview',
      captureSourceAvailable: true,
      retentionClass: 'preSend',
    })).toMatchObject({
      captureKind: 'streamFrameCapture',
      mimeType: 'video/webm',
      retentionClass: 'preSend',
    });
  });

  it('rejects impossible cross-products from merged capability lists', () => {
    expect(resolveBrowserRecordingProfileUnavailableReason({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'externalUrl',
      captureKind: 'cdpScreencast',
      mimeType: 'image/jpeg',
      retentionClass: 'preSend',
    })).toBe('capture');

    expect(resolveBrowserRecordingProfileUnavailableReason({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'chromiumSidecar',
      captureKind: 'cdpScreencast',
      mimeType: 'image/png',
      retentionClass: 'preSend',
    })).toBe('mime');
  });

  it('rejects profiles whose required runtime source or render engine is unavailable', () => {
    expect(resolveBrowserRecordingCaptureProfile({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'externalUrl',
      captureKind: 'nativeViewCapture',
      mimeType: 'image/png',
      retentionClass: 'preSend',
    })).toBeNull();

    expect(resolveBrowserRecordingProfileUnavailableReason({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'externalUrl',
      captureKind: 'nativeViewCapture',
      mimeType: 'image/png',
      retentionClass: 'preSend',
    })).toBe('engine');

    expect(resolveBrowserRecordingProfileUnavailableReason({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'simulatorPreview',
      captureKind: 'streamFrameCapture',
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSourceAvailable: false,
    })).toBe('source');

    expect(resolveBrowserRecordingProfileUnavailableReason({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'externalUrl',
      captureKind: 'nativeViewCapture',
      mimeType: 'image/png',
      retentionClass: 'preSend',
      renderEngineKind: 'webIframe',
    })).toBe('engine');
  });

  it('requires active source truth for desktop native view capture', () => {
    expect(resolveBrowserRecordingCaptureProfile({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'externalUrl',
      renderEngineKind: 'desktopWebView',
      captureKind: 'nativeViewCapture',
      mimeType: 'image/png',
      retentionClass: 'preSend',
      captureSourceAvailable: false,
    })).toBeNull();

    expect(resolveBrowserRecordingProfileUnavailableReason({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'externalUrl',
      renderEngineKind: 'desktopWebView',
      captureKind: 'nativeViewCapture',
      mimeType: 'image/png',
      retentionClass: 'preSend',
      captureSourceAvailable: false,
    })).toBe('source');

    expect(resolveBrowserRecordingCaptureProfile({
      recordingCapabilities: broadServerRecordingCapabilities,
      adapterKind: 'externalUrl',
      renderEngineKind: 'desktopWebView',
      captureKind: 'nativeViewCapture',
      mimeType: 'image/png',
      retentionClass: 'preSend',
      captureSourceAvailable: true,
    })).toMatchObject({
      captureKind: 'nativeViewCapture',
      mimeType: 'image/png',
      retentionClass: 'preSend',
    });
  });

  it('does not treat local-preview iframes as stream-frame producer-backed recording sources', () => {
    const regressedLocalPreviewCapabilities = {
      ...broadServerRecordingCapabilities,
      supportedAdapterKinds: ['localPreview', ...broadServerRecordingCapabilities.supportedAdapterKinds],
    } satisfies BrowserRecordingCapabilities;

    expect(resolveBrowserRecordingCaptureProfile({
      recordingCapabilities: regressedLocalPreviewCapabilities,
      adapterKind: 'localPreview',
      retentionClass: 'preSend',
      captureSourceAvailable: true,
    })).toBeNull();

    expect(resolveBrowserRecordingProfileUnavailableReason({
      recordingCapabilities: regressedLocalPreviewCapabilities,
      adapterKind: 'localPreview',
      captureKind: 'streamFrameCapture',
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSourceAvailable: true,
    })).toBe('capture');
  });
});
