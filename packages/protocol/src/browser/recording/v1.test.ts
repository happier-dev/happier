import { describe, expect, it } from 'vitest';

describe('browser recording protocol contracts', () => {
  it('parses bounded recording sessions with explicit lifecycle status and outcome reasons', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserRecordingSessionV1Schema.parse({
      v: 1,
      recordingId: 'recording_1',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      profileId: 'profile_1',
      targetKind: 'simulatorPreview',
      adapterKind: 'simulatorPreview',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      startedAtMs: 10_000,
      status: 'recording',
      navigationGenerationStart: 7,
      durationMs: 2_000,
      byteSize: 800_000,
      frameCount: 24,
      fps: 12,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      redactionLevel: 'metadataOnly',
      policyState: 'allowed',
      maxDurationMs: 30_000,
      maxBytes: 16_000_000,
    });

    expect(parsed.status).toBe('recording');
    expect(parsed.renderEngineKind).toBe('streamedSurface');
    expect(parsed.captureKind).toBe('streamFrameCapture');
  });

  it('recognizes lifecycle failure reasons for hidden, parked, suspended, host-lost, closed, unavailable, retention, and permission states', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.BrowserRecordingOutcomeReasonV1Schema.options).toEqual(expect.arrayContaining([
      'view_hidden',
      'view_parked',
      'view_suspended',
      'host_lost',
      'view_closed',
      'capture_unavailable',
      'retention_limit',
      'permission_denied',
    ]));
  });

  it('requires completed and finalized recordings to carry a stored media reference, never inline bytes', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const completed = {
      v: 1,
      recordingId: 'recording_completed',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      profileId: 'profile_1',
      targetKind: 'simulatorPreview',
      adapterKind: 'simulatorPreview',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      startedAtMs: 10_000,
      stoppedAtMs: 12_000,
      status: 'completed',
      outcomeReason: 'user_stopped',
      navigationGenerationStart: 7,
      navigationGenerationEnd: 7,
      durationMs: 2_000,
      byteSize: 800_000,
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
        mediaId: 'media_recording_1',
        mediaKind: 'video',
        mimeType: 'video/webm',
        sizeBytes: 800_000,
      },
    };

    expect(mod.BrowserRecordingSessionV1Schema.parse(completed).mediaRef.mediaId).toBe('media_recording_1');
    expect(mod.BrowserRecordingSessionV1Schema.safeParse({
      ...completed,
      recordingId: 'recording_blank',
      mediaRef: undefined,
    }).success).toBe(false);
    expect(mod.BrowserRecordingSessionV1Schema.safeParse({
      ...completed,
      recordingId: 'recording_inline',
      inlineBase64: 'AAAA',
    }).success).toBe(false);
  });

  it('packages evidence artifacts as references to session media, screenshots, diagnostics, and action timelines', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserEvidenceArtifactV1Schema.parse({
      v: 1,
      artifactId: 'artifact_recording_1',
      artifactKind: 'recording',
      sourceViewId: 'view_1',
      sourceBrowserSessionId: 'browser_session_1',
      sourceNavigationGenerationRange: { start: 7, end: 8 },
      capturedAtMs: 12_000,
      fidelity: 'streamFrame',
      redactionLevel: 'metadataOnly',
      retentionClass: 'preSend',
      expiresAtMs: 42_000,
      mediaRef: {
        refKind: 'sessionMedia',
        mediaId: 'media_recording_1',
        mediaKind: 'video',
        mimeType: 'video/webm',
        sizeBytes: 800_000,
      },
      relatedReferences: [
        { refKind: 'browserContextScreenshot', contextId: 'ctx_screenshot_1', mediaId: 'media_screenshot_1' },
        { refKind: 'browserDiagnosticsBundle', diagnosticsBundleId: 'diagnostics_bundle_1' },
        { refKind: 'browserActionTimeline', timelineId: 'timeline_1', actionIds: ['action_1'] },
      ],
    });

    expect(parsed.relatedReferences).toHaveLength(3);
    expect(JSON.stringify(parsed)).not.toContain('base64');
    expect(mod.BrowserEvidenceArtifactV1Schema.safeParse({
      ...parsed,
      data: 'AAAA',
    }).success).toBe(false);
  });

  it('keeps action chapters bounded redacted metadata, not raw inputs or eval output', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserRecordingActionChapterV1Schema.parse({
      v: 1,
      chapterId: 'chapter_1',
      actionId: 'action_1',
      startOffsetMs: 100,
      endOffsetMs: 450,
      actionKind: 'click',
      status: 'succeeded',
      requesterClass: 'agent',
      targetSummary: 'button[name="Submit"]',
      diagnosticsRefs: ['diagnostic_event_1'],
    });

    expect(parsed.actionKind).toBe('click');
    expect(mod.BrowserRecordingActionChapterV1Schema.safeParse({
      ...parsed,
      rawInputValue: 'hunter2',
    }).success).toBe(false);
  });

  it('defines daemon recording command RPC schemas for the route/broker seam', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const startRequest = mod.DaemonBrowserRecordingStartRequestV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine_1',
        input: {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        profileId: 'profile_1',
        targetKind: 'simulatorPreview',
        adapterKind: 'simulatorPreview',
        renderEngineKind: 'streamedSurface',
        captureKind: 'streamFrameCapture',
        fidelity: 'streamFrame',
        navigationGeneration: 7,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
            policyState: 'allowed',
            mediaTarget: {
              sessionId: 'session_1',
              messageLocalId: 'message_1',
            },
            captureSource: {
              kind: 'machineLiveStream',
              streamFamily: 'simulator.preview',
              sourceId: 'source_1',
            },
        },
    });
    expect(startRequest.input.viewId).toBe('view_1');
    expect(startRequest.input.mediaTarget?.sessionId).toBe('session_1');
    expect(startRequest.input.captureSource?.kind).toBe('machineLiveStream');
    expect(startRequest.input.captureSource?.streamFamily).toBe('simulator.preview');
    expect(mod.DaemonBrowserRecordingStartInputV1Schema.safeParse({
      ...startRequest.input,
      renderEngineKind: undefined,
    }).success).toBe(false);
    expect(mod.DaemonBrowserRecordingStartInputV1Schema.safeParse({
      ...startRequest.input,
      mediaTarget: { sessionId: '', messageLocalId: 'message_1' },
    }).success).toBe(false);
    expect(mod.DaemonBrowserRecordingStartInputV1Schema.safeParse({
      ...startRequest.input,
      captureSource: { kind: 'machineLiveStream', streamFamily: '' },
    }).success).toBe(false);
    expect(mod.DaemonBrowserRecordingStartInputV1Schema.safeParse({
      ...startRequest.input,
      captureSource: { kind: 'machineLiveStream', sourceId: 'source_1' },
    }).success).toBe(false);

    expect(mod.DaemonBrowserRecordingStartResponseV1Schema.parse({
      protocolVersion: 1,
      result: {
        status: 'unavailable',
        reason: {
          code: 'browser_recording_capture_adapter_missing',
          message: 'Browser recording capture adapter is unavailable.',
        },
      },
    }).result.status).toBe('unavailable');

    expect(mod.DaemonBrowserRecordingStopRequestV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine_1',
      recordingId: 'recording_1',
      navigationGenerationEnd: 8,
    }).recordingId).toBe('recording_1');

    expect(mod.DaemonBrowserRecordingStatusResponseV1Schema.parse({
      protocolVersion: 1,
      recording: null,
    }).recording).toBeNull();
    expect(mod.DaemonBrowserRecordingStatusRequestV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine_1',
      recordingId: 'recording_1',
    }).recordingId).toBe('recording_1');
    expect(mod.DaemonBrowserRecordingListRequestV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine_1',
      viewId: 'view_1',
    }).viewId).toBe('view_1');
    expect(mod.DaemonBrowserRecordingCleanupResponseV1Schema.parse({
      protocolVersion: 1,
      result: {
        discardedRecordingIds: ['recording_expired'],
        failedRecordingIds: [],
      },
    }).result.discardedRecordingIds).toEqual(['recording_expired']);
  });
});
