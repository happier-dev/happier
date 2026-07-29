import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createBrowserRecordingAttachToComposer } from './attachToComposer';
import type { BrowserRecordingRoutes } from './routes';

function createFinalizedRecording(
  overrides: Partial<BrowserRecordingSessionV1> = {},
): BrowserRecordingSessionV1 {
  return {
    v: 1,
    recordingId: 'browser_recording_view_1_1_1000',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'localServicePreview',
    adapterKind: 'localPreview',
    renderEngineKind: 'streamedSurface',
    captureKind: 'streamFrameCapture',
    fidelity: 'streamFrame',
    startedAtMs: 1000,
    stoppedAtMs: 3000,
    status: 'finalized',
    outcomeReason: 'user_stopped',
    navigationGenerationStart: 1,
    durationMs: 2000,
    byteSize: 1234,
    frameCount: 24,
    fps: 12,
    mimeType: 'video/webm',
    retentionClass: 'preSend',
    redactionLevel: 'metadataOnly',
    policyState: 'allowed',
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    mediaRef: {
      refKind: 'sessionMedia',
      mediaId: 'media_1',
      mediaKind: 'video',
      mimeType: 'video/webm',
      sizeBytes: 1234,
    },
    actionChapters: [],
    relatedReferences: [],
    ...overrides,
  };
}

function createRoutes(recording: BrowserRecordingSessionV1 | null): BrowserRecordingRoutes {
  return {
    startRecording: async () => { throw new Error('unused'); },
    stopRecording: async () => { throw new Error('unused'); },
    cancelRecording: async () => { throw new Error('unused'); },
    getRecordingStatus: async () => recording,
    listRecordingsForView: async () => (recording ? [recording] : []),
    cleanupExpiredRecordings: async () => { throw new Error('unused'); },
  };
}

describe('createBrowserRecordingAttachToComposer', () => {
  it('attaches a finalized recording mediaRef to the composer attach owner', async () => {
    const recording = createFinalizedRecording();
    let attachedWith: unknown = null;
    const attach = createBrowserRecordingAttachToComposer({
      routes: createRoutes(recording),
      attachToComposer: async (input) => {
        attachedWith = input;
        return { ok: true as const, attachmentId: 'attachment_1' };
      },
    });

    const result = await attach({ recordingId: recording.recordingId, sessionId: 'session_1' });

    expect(result).toMatchObject({ ok: true, attachmentId: 'attachment_1' });
    expect(attachedWith).toMatchObject({
      recordingId: recording.recordingId,
      mediaRef: recording.mediaRef,
    });
  });

  it('fails closed when the recording is missing', async () => {
    const attach = createBrowserRecordingAttachToComposer({
      routes: createRoutes(null),
      attachToComposer: async () => { throw new Error('should not attach'); },
    });

    const result = await attach({ recordingId: 'missing' });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'runtime_action_disabled',
    });
    expect(result.ok ? '' : result.error).toContain('browser_recording_missing');
  });

  it('fails closed when the recording is not in a terminal state', async () => {
    const recording = createFinalizedRecording({ status: 'recording', outcomeReason: undefined, mediaRef: undefined });
    const attach = createBrowserRecordingAttachToComposer({
      routes: createRoutes(recording),
      attachToComposer: async () => { throw new Error('should not attach'); },
    });

    const result = await attach({ recordingId: recording.recordingId });

    expect(result).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    expect(result.ok ? '' : result.error).toContain('browser_recording_not_finalized');
  });

  it('fails closed when the recording has no media reference', async () => {
    // A discarded recording has no mediaRef; resolve a finalized-shaped recording but strip mediaRef
    // via the routes returning a session that is terminal yet media-less is impossible per schema,
    // so simulate via a completed recording missing the ref by overriding getRecordingStatus.
    const recording = createFinalizedRecording();
    const routes: BrowserRecordingRoutes = {
      ...createRoutes(recording),
      getRecordingStatus: async () => ({ ...recording, mediaRef: undefined } as BrowserRecordingSessionV1),
    };
    const attach = createBrowserRecordingAttachToComposer({
      routes,
      attachToComposer: async () => { throw new Error('should not attach'); },
    });

    const result = await attach({ recordingId: recording.recordingId });

    expect(result).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    expect(result.ok ? '' : result.error).toContain('browser_recording_media_missing');
  });
});
