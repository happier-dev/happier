import { rm } from 'node:fs/promises';

import {
  BrowserEvidenceSessionMediaReferenceV1Schema,
  type BrowserEvidenceSessionMediaReferenceV1,
  type BrowserRecordingSessionV1,
} from '@happier-dev/protocol';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import {
  persistSessionMedia,
  type PersistSessionMediaResult,
} from '@/session/media/persistSessionMedia';
import type { SessionMediaIngestionSource } from '@/session/media/_types';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

import type {
  BrowserRecordingCapturedArtifact,
  BrowserRecordingMediaWriter,
} from './service';

export type BrowserRecordingSessionMediaTarget = Readonly<{
  sessionId: string;
  messageLocalId: string;
}>;

export type BrowserRecordingSessionMediaWriterOptions = Readonly<{
  workingDirectory: string;
  pathAllowanceRegistry: TransferPathAllowanceRegistry;
  accessPolicy?: FilesystemAccessPolicy;
  sourceAccessPolicy?: FilesystemAccessPolicy;
  resolveSessionMediaTarget(recording: BrowserRecordingSessionV1): BrowserRecordingSessionMediaTarget;
  persistMedia?: typeof persistSessionMedia;
}>;

function buildSessionMediaSource(artifact: BrowserRecordingCapturedArtifact): Extract<
  SessionMediaIngestionSource,
  { kind: 'local-file' | 'local-uri' }
> {
  return {
    ...artifact.source,
    mimeType: artifact.source.mimeType ?? artifact.mimeType,
    fileNameHint: artifact.source.fileNameHint ?? 'browser-recording.webm',
  };
}

function convertPersistedItemToMediaRef(
  result: Extract<PersistSessionMediaResult, { success: true }>,
): BrowserEvidenceSessionMediaReferenceV1 {
  return BrowserEvidenceSessionMediaReferenceV1Schema.parse({
    refKind: 'sessionMedia',
    mediaId: result.item.id,
    mediaKind: result.item.mediaKind,
    mimeType: result.item.mimeType,
    sizeBytes: result.item.sizeBytes,
  });
}

export function createBrowserRecordingSessionMediaWriter(
  options: BrowserRecordingSessionMediaWriterOptions,
): BrowserRecordingMediaWriter {
  const accessPolicy = options.accessPolicy ?? { kind: 'osUser' as const };
  const sourceAccessPolicy = options.sourceAccessPolicy ?? { kind: 'osUser' as const };
  const persistMedia = options.persistMedia ?? persistSessionMedia;
  const workspacePathByRecordingId = new Map<string, string>();

  return {
    async persistRecording({ recording, artifact }) {
      const target = options.resolveSessionMediaTarget(recording);
      const persisted = await persistMedia({
        workingDirectory: options.workingDirectory,
        accessPolicy,
        sourceAccessPolicy,
        pathAllowanceRegistry: options.pathAllowanceRegistry,
        maxBytes: recording.maxBytes,
        input: {
          sessionId: target.sessionId,
          messageLocalId: target.messageLocalId,
          role: 'output',
          category: 'tool-artifact',
          source: buildSessionMediaSource(artifact),
          origin: {
            source: 'tool-output',
            toolCallId: recording.recordingId,
          },
          suggestedName: artifact.source.fileNameHint ?? 'browser-recording.webm',
          createdAtMs: recording.stoppedAtMs ?? recording.startedAtMs,
        },
      });
      if (!persisted.success) {
        throw new Error(`Browser recording media persistence failed: ${persisted.code}`);
      }
      const mediaRef = convertPersistedItemToMediaRef(persisted);
      workspacePathByRecordingId.set(recording.recordingId, persisted.item.path);
      return mediaRef;
    },

    async discardRecording({ recording }) {
      if (!recording.mediaRef) return;
      const workspacePath = workspacePathByRecordingId.get(recording.recordingId);
      if (!workspacePath) {
        throw new Error('Browser recording media path is unavailable for discard.');
      }
      const authorized = authorizeFilesystemPath({
        targetPath: workspacePath,
        defaultDirectory: options.workingDirectory,
        accessPolicy,
      });
      if (!authorized.valid) {
        throw new Error(authorized.error);
      }
      await rm(authorized.resolvedPath, { force: true });
      workspacePathByRecordingId.delete(recording.recordingId);
    },
  };
}
