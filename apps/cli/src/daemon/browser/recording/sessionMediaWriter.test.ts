import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { describe, expect, it } from 'vitest';

const webmBytes = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]),
  Buffer.from('browser recording bytes', 'utf8'),
]);

const recording = {
  v: 1,
  recordingId: 'browser_recording_1',
  browserSessionId: 'browser_session_1',
  viewId: 'view_1',
  profileId: 'profile_1',
  targetKind: 'localServicePreview',
  adapterKind: 'localPreview',
  renderEngineKind: 'streamedSurface',
  captureKind: 'streamFrameCapture',
  fidelity: 'streamFrame',
  startedAtMs: 10_000,
  stoppedAtMs: 12_000,
  status: 'finalized',
  outcomeReason: 'user_stopped',
  navigationGenerationStart: 7,
  navigationGenerationEnd: 8,
  durationMs: 2_000,
  byteSize: webmBytes.byteLength,
  frameCount: 24,
  fps: 12,
  mimeType: 'video/webm',
  retentionClass: 'preSend',
  redactionLevel: 'metadataOnly',
  policyState: 'allowed',
  maxDurationMs: 30_000,
  maxBytes: 16_000_000,
  actionChapters: [],
  relatedReferences: [],
} satisfies BrowserRecordingSessionV1;

function recordingWithId(recordingId: string): BrowserRecordingSessionV1 {
  return {
    ...recording,
    recordingId,
  };
}

describe('browser recording session-media writer', () => {
  it('persists captured local video artifacts through the canonical session-media owner and discards them durably', async () => {
    const { createBrowserRecordingSessionMediaWriter } = await import('./sessionMediaWriter');
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-recording-writer-'));
    const captureDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-recording-capture-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const sourcePath = join(captureDirectory, 'recording.webm');
      await writeFile(sourcePath, webmBytes);
      const writer = createBrowserRecordingSessionMediaWriter({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        resolveSessionMediaTarget: () => ({
          sessionId: 'session_1',
          messageLocalId: 'browser-recording-1',
        }),
      });

      const mediaRef = await writer.persistRecording({
        recording,
        artifact: {
          durationMs: 2_000,
          byteSize: webmBytes.byteLength,
          frameCount: 24,
          fps: 12,
          mimeType: 'video/webm',
          source: {
            kind: 'local-file',
            path: sourcePath,
            mimeType: 'video/webm',
            fileNameHint: 'recording.webm',
          },
        },
      });

      expect(mediaRef).toMatchObject({
        refKind: 'sessionMedia',
        mediaKind: 'video',
        mimeType: 'video/webm',
        sizeBytes: webmBytes.byteLength,
      });
      const persistedPath = resolve(
        workingDirectory,
        '.happier',
        'uploads',
        'artifacts',
        'session_1',
        'browser-recording-1',
      );
      const persistedFiles = await readFile(resolve(persistedPath, `${mediaRef.mediaId.slice(0, 12)}-recording.webm`)).catch(() => null);
      expect(persistedFiles).toEqual(webmBytes);

      await writer.discardRecording({
        recording: {
          ...recording,
          mediaRef,
        },
        reason: 'user_discarded',
      });

      await expect(stat(persistedPath)).resolves.toBeTruthy();
      await expect(readFile(resolve(persistedPath, `${mediaRef.mediaId.slice(0, 12)}-recording.webm`))).rejects.toThrow();
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(captureDirectory, { recursive: true, force: true });
    }
  });

  it('tracks duplicate-content recording files by recording identity, not shared media hash', async () => {
    const { createBrowserRecordingSessionMediaWriter } = await import('./sessionMediaWriter');
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-recording-writer-dupe-'));
    const captureDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-recording-capture-dupe-'));

    try {
      const sourcePathA = join(captureDirectory, 'recording-a.webm');
      const sourcePathB = join(captureDirectory, 'recording-b.webm');
      await writeFile(sourcePathA, webmBytes);
      await writeFile(sourcePathB, webmBytes);
      const writer = createBrowserRecordingSessionMediaWriter({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        resolveSessionMediaTarget: (targetRecording) => ({
          sessionId: targetRecording.recordingId === 'recording_a' ? 'session_a' : 'session_b',
          messageLocalId: targetRecording.recordingId === 'recording_a' ? 'message_a' : 'message_b',
        }),
      });
      const recordingA = recordingWithId('recording_a');
      const recordingB = recordingWithId('recording_b');

      const mediaRefA = await writer.persistRecording({
        recording: recordingA,
        artifact: {
          durationMs: 2_000,
          byteSize: webmBytes.byteLength,
          frameCount: 24,
          fps: 12,
          mimeType: 'video/webm',
          source: {
            kind: 'local-file',
            path: sourcePathA,
            mimeType: 'video/webm',
            fileNameHint: 'recording.webm',
          },
        },
      });
      const mediaRefB = await writer.persistRecording({
        recording: recordingB,
        artifact: {
          durationMs: 2_000,
          byteSize: webmBytes.byteLength,
          frameCount: 24,
          fps: 12,
          mimeType: 'video/webm',
          source: {
            kind: 'local-file',
            path: sourcePathB,
            mimeType: 'video/webm',
            fileNameHint: 'recording.webm',
          },
        },
      });
      expect(mediaRefA.mediaId).toBe(mediaRefB.mediaId);
      const fileName = `${mediaRefA.mediaId.slice(0, 12)}-recording.webm`;
      const persistedA = resolve(workingDirectory, '.happier', 'uploads', 'artifacts', 'session_a', 'message_a', fileName);
      const persistedB = resolve(workingDirectory, '.happier', 'uploads', 'artifacts', 'session_b', 'message_b', fileName);
      await expect(readFile(persistedA)).resolves.toEqual(webmBytes);
      await expect(readFile(persistedB)).resolves.toEqual(webmBytes);

      await writer.discardRecording({
        recording: { ...recordingA, mediaRef: mediaRefA },
        reason: 'user_discarded',
      });

      await expect(readFile(persistedA)).rejects.toThrow();
      await expect(readFile(persistedB)).resolves.toEqual(webmBytes);

      await writer.discardRecording({
        recording: { ...recordingB, mediaRef: mediaRefB },
        reason: 'user_discarded',
      });
      await expect(readFile(persistedB)).rejects.toThrow();
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(captureDirectory, { recursive: true, force: true });
    }
  });
});
