import { rm } from 'node:fs/promises';

import { BrowserEvidenceSessionMediaReferenceV1Schema } from '@happier-dev/protocol/browser/recording/v1';
import type { BrowserEvidenceSessionMediaReferenceV1, BrowserRecordingSessionV1 } from '@happier-dev/protocol';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import {
  persistSessionMedia,
  type PersistSessionMediaResult,
} from '@/session/media/persistSessionMedia';
import type { SessionMediaIngestionSource } from '@/session/media/_types';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { attachSessionMediaMeta } from '@/api/session/client/transcript/sessionMediaBridge';
import type { RecordingOperationContext, RecordingSaveAdmission } from './sessionMediaHost';
import { RecordingSaveError } from './service';

import type {
  BrowserRecordingCapturedArtifact,
  BrowserRecordingMediaWriter,
  BrowserRecordingInputControlResolver,
  RecordingSession,
} from './service';

export type BrowserRecordingSessionMediaTarget = Readonly<{
  sessionId: string;
  messageLocalId: string;
}>;

export type BrowserRecordingSessionMediaWriterOptions<R extends RecordingSession = BrowserRecordingSessionV1> = Readonly<{
  workingDirectory: string;
  pathAllowanceRegistry: TransferPathAllowanceRegistry;
  accessPolicy?: FilesystemAccessPolicy;
  sourceAccessPolicy?: FilesystemAccessPolicy;
  resolveSessionMediaTarget(recording: R): BrowserRecordingSessionMediaTarget;
  /** The media host's Record START decision; the admitted context then carries the save's custody and workspace. */
  admitSave?: (target: BrowserRecordingSessionMediaTarget, context?: RecordingOperationContext) => Promise<RecordingSaveAdmission>;
  resolveWorkingDirectory?: (target: BrowserRecordingSessionMediaTarget, context?: RecordingOperationContext) => string | Promise<string>;
  commitAttachment?: (input: Readonly<{ sessionId: string; localId: string; meta: Record<string, unknown> }>, context?: RecordingOperationContext) => Promise<void>;
  resolveInputControl?: (recording: R) => ReturnType<BrowserRecordingInputControlResolver>;
}>;

function buildSessionMediaSource(artifact: BrowserRecordingCapturedArtifact): Extract<
  SessionMediaIngestionSource,
  { kind: 'local-file' | 'local-uri' }
> {
  return {
    ...artifact.source,
    mimeType: artifact.source.mimeType ?? artifact.mimeType,
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

export function createBrowserRecordingSessionMediaWriter<R extends RecordingSession = BrowserRecordingSessionV1>(
  options: BrowserRecordingSessionMediaWriterOptions<R>,
): BrowserRecordingMediaWriter<R> {
  const accessPolicy = options.accessPolicy ?? { kind: 'osUser' as const };
  const sourceAccessPolicy = options.sourceAccessPolicy ?? { kind: 'osUser' as const };
  const workspacePathByRecordingId = new Map<string, Readonly<{ path: string; workingDirectory: string; attached: boolean }>>();

  async function discardWorkspaceDraft(recordingId: string, beforeEffect?: () => Promise<void>): Promise<void> {
    const workspacePath = workspacePathByRecordingId.get(recordingId);
    if (!workspacePath) throw new Error('Browser recording media path is unavailable for discard.');
    // Transcript custody has admitted this attachment; draft cleanup must not break it.
    if (!workspacePath.attached) {
      const authorized = authorizeFilesystemPath({
        targetPath: workspacePath.path,
        defaultDirectory: workspacePath.workingDirectory,
        accessPolicy,
      });
      if (!authorized.valid) throw new Error(authorized.error);
      await beforeEffect?.();
      await rm(authorized.resolvedPath, { force: true });
    }
    workspacePathByRecordingId.delete(recordingId);
  }

  const admitSave = options.admitSave;
  return {
    ...(admitSave ? { admitRecording: async ({ recording, context }: Readonly<{ recording: R; context?: RecordingOperationContext }>) =>
      admitSave(options.resolveSessionMediaTarget(recording), context) } : {}),
    async attachToComposer({ recording, sessionId }) {
      const target = options.resolveSessionMediaTarget(recording);
      const storage = workspacePathByRecordingId.get(recording.recordingId);
      if ((sessionId && sessionId !== target.sessionId) || !storage?.attached || !recording.mediaRef) {
        return { ok: false, reason: 'recording_attachment_unavailable' };
      }
      return { ok: true, attachmentId: recording.mediaRef.mediaId };
    },
    getRecordingStorage(recordingId) {
      const storage = workspacePathByRecordingId.get(recordingId);
      if (!storage) return null;
      const authorized = authorizeFilesystemPath({
        targetPath: storage.path,
        defaultDirectory: storage.workingDirectory,
        accessPolicy,
      });
      return authorized.valid ? { path: authorized.resolvedPath, attached: storage.attached } : null;
    },

    async persistRecording({ recording, artifact, captureStopped, context }) {
      // Only the recording lifecycle can admit this already-stopped, pre-private prefix.
      // Arbitrary capture writes still obey the live confidential-observation boundary.
      const control = captureStopped ? undefined : options.resolveInputControl?.(recording);
      const confidential = () => new Error('Browser recording is held for confidential input.');
      if (control?.isObservationHeld()) throw confidential();
      const persist = async (): Promise<BrowserEvidenceSessionMediaReferenceV1> => {
        // Each save step names its failure by what happens to the recording file.
        const notWritten = (cause: unknown) => new RecordingSaveError('workspace_write_failed', { cause });
        let target: BrowserRecordingSessionMediaTarget;
        let workingDirectory: string;
        try {
          target = options.resolveSessionMediaTarget(recording);
          workingDirectory = await (options.resolveWorkingDirectory?.(target, ...(context ? [context] as const : [])) ?? options.workingDirectory);
        } catch (error) { throw notWritten(error); }
        if (control?.isObservationHeld()) throw confidential();
        const persisted = await persistSessionMedia({
          workingDirectory,
          accessPolicy,
          sourceAccessPolicy,
          pathAllowanceRegistry: options.pathAllowanceRegistry,
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
            suggestedName: artifact.source.fileNameHint,
            createdAtMs: recording.stoppedAtMs ?? recording.startedAtMs,
          },
        }).catch(error => { throw notWritten(error); });
        if (!persisted.success) throw notWritten(new Error(`Browser recording media persistence failed: ${persisted.code}`));
        const mediaRef = convertPersistedItemToMediaRef(persisted);
        workspacePathByRecordingId.set(recording.recordingId, { path: persisted.item.path, workingDirectory, attached: false });
        if (control?.isObservationHeld()) {
          await discardWorkspaceDraft(recording.recordingId);
          throw confidential();
        }
        if (options.commitAttachment) {
          // The file stays in the Session workspace when the transcript card cannot be added.
          await options.commitAttachment({
            sessionId: target.sessionId,
            localId: target.messageLocalId,
            meta: attachSessionMediaMeta({}, [{
              ...persisted.item,
              ...(recording.outcomeReason ? { browserRecording: { outcomeReason: recording.outcomeReason } } : {}),
            }], []),
          }, ...(context ? [context] as const : [])).catch(error => {
            throw new RecordingSaveError('transcript_attach_failed', { cause: error });
          });
          workspacePathByRecordingId.set(recording.recordingId, { path: persisted.item.path, workingDirectory, attached: true });
        }
        return mediaRef;
      };
      const mediaRef = control ? await control.observeWhile(persist) : await persist();
      if (!mediaRef) throw confidential();
      return mediaRef;
    },

    async discardRecording({ recording, beforeEffect }) {
      if (!recording.mediaRef) return;
      await discardWorkspaceDraft(recording.recordingId, beforeEffect);
    },
  };
}
