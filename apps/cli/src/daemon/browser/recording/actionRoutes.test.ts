import { describe, expect, it, vi } from 'vitest';

import { createBrowserRecordingActionRoutes } from './actionRoutes';
import type { BrowserRecordingRoutes } from './routes';

function stubRoutes(): { routes: BrowserRecordingRoutes; calls: Record<string, ReturnType<typeof vi.fn>> } {
  const calls = {
    startRecording: vi.fn(async () => ({ status: 'started', recording: { recordingId: 'r1' } })),
    stopRecording: vi.fn(async () => ({ status: 'stopped' })),
    cancelRecording: vi.fn(async () => ({ status: 'canceled' })),
    getRecordingStatus: vi.fn(async () => null),
    listRecordingsForView: vi.fn(async () => []),
    cleanupExpiredRecordings: vi.fn(async () => ({ discardedRecordingIds: [] })),
  } as const;
  return {
    calls,
    routes: calls as unknown as BrowserRecordingRoutes,
  };
}

const startInput = {
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
  captureSource: {
    kind: 'machineLiveStream',
    streamFamily: 'simulator.preview',
    sourceId: 'source_1',
  },
} as const;

describe('browser recording action routes (BA-5)', () => {
  it('routes start to startRecording', async () => {
    const { routes, calls } = stubRoutes();
    const owner = createBrowserRecordingActionRoutes({ routes });
    await owner.dispatch('browser.recording.start', startInput);
    expect(calls.startRecording).toHaveBeenCalledOnce();
  });

  it('routes stop/cancel/status/listForView/cleanupExpired to their service-backed methods', async () => {
    const { routes, calls } = stubRoutes();
    const owner = createBrowserRecordingActionRoutes({ routes });
    await owner.dispatch('browser.recording.stop', { recordingId: 'r1', navigationGenerationEnd: 1 });
    await owner.dispatch('browser.recording.cancel', { recordingId: 'r1', reason: 'user_canceled' });
    await owner.dispatch('browser.recording.status', { recordingId: 'r1' });
    await owner.dispatch('browser.recording.listForView', { viewId: 'view_1' });
    await owner.dispatch('browser.recording.cleanupExpired', {});
    expect(calls.stopRecording).toHaveBeenCalledOnce();
    expect(calls.cancelRecording).toHaveBeenCalledOnce();
    expect(calls.getRecordingStatus).toHaveBeenCalledOnce();
    expect(calls.listRecordingsForView).toHaveBeenCalledOnce();
    expect(calls.cleanupExpiredRecordings).toHaveBeenCalledOnce();
  });

  it('maps discard onto the terminal cancel route (shared cancel input contract)', async () => {
    const { routes, calls } = stubRoutes();
    const owner = createBrowserRecordingActionRoutes({ routes });
    await owner.dispatch('browser.recording.discard', { recordingId: 'r1', reason: 'user_discarded' });
    expect(calls.cancelRecording).toHaveBeenCalledOnce();
  });

  it('returns invalid_parameters for a malformed start input', async () => {
    const { routes, calls } = stubRoutes();
    const owner = createBrowserRecordingActionRoutes({ routes });
    await expect(owner.dispatch('browser.recording.start', { browserSessionId: '' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(calls.startRecording).not.toHaveBeenCalled();
  });
});
