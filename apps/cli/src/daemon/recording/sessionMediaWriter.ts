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
import { configuration } from '@/configuration';
import { prepareSource } from '@/session/media/source';
import { SessionMediaItemV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMediaV1';
import { persistFilesystemEffectSessionMedia } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';
import { logger } from '@/ui/logger';
import type { FilesystemMutationActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { RecordingMemberMedia, RecordingOperationContext, RecordingSaveAdmission } from './sessionMediaHost';
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

/** Runs one requester-owned operation; its process cleanup is reported beside, never instead of, the result. */
async function withMemberOperation<T>(member: RecordingMemberMedia, effect: (channel: Awaited<ReturnType<RecordingMemberMedia['open']>>) => Promise<T>): Promise<T> {
  const channel = await member.open();
  try { return await effect(channel); }
  finally {
    await channel.dispose().catch(error => {
      logger.debug('[Recording] Member media operation cleanup is unconfirmed', { error: error instanceof Error ? error.name : 'unknown' });
    });
  }
}

/** A separated requester's media file is written by that requester's own OS user, from bytes this daemon captured. */
async function persistSessionMediaAsMember(member: RecordingMemberMedia, params: Readonly<{
  workingDirectory: string;
  sourceAccessPolicy: FilesystemAccessPolicy;
  input: Parameters<typeof persistSessionMedia>[0]['input'];
}>): Promise<PersistSessionMediaResult> {
  const { source, ...media } = params.input;
  const prepared = await prepareSource({ source, workingDirectory: params.workingDirectory,
    accessPolicy: params.sourceAccessPolicy, maxBytes: configuration.filesUploadMaxFileBytes, suggestedName: media.suggestedName });
  if ('success' in prepared) return prepared;
  const raw = await withMemberOperation(member, channel => persistFilesystemEffectSessionMedia(channel, {
    bytes: prepared.bytes,
    media: { ...media, mimeType: prepared.mimeType, ...(prepared.suggestedName ? { fileNameHint: prepared.suggestedName } : {}) },
  }));
  const result = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (result.success === false) return { success: false, code: String(result.code), error: String(result.error) };
  const item = SessionMediaItemV1Schema.safeParse(result.item);
  if (result.success !== true || !item.success) throw new Error('Member media persistence returned an invalid result');
  return { success: true, created: result.created === true, item: item.data as Extract<PersistSessionMediaResult, { success: true }>['item'] };
}

export function createBrowserRecordingSessionMediaWriter<R extends RecordingSession = BrowserRecordingSessionV1>(
  options: BrowserRecordingSessionMediaWriterOptions<R>,
): BrowserRecordingMediaWriter<R> {
  const accessPolicy = options.accessPolicy ?? { kind: 'osUser' as const };
  const sourceAccessPolicy = options.sourceAccessPolicy ?? { kind: 'osUser' as const };
  const workspacePathByRecordingId = new Map<string, Readonly<{ path: string; workingDirectory: string; attached: boolean;
    member?: RecordingMemberMedia }>>();

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
      const member = workspacePath.member;
      if (member) {
        // The member's own filesystem owner removes the draft it wrote.
        const removed = await withMemberOperation(member, channel => channel.request({ kind: 'action',
          actionId: 'daemon.filesystem.delete' satisfies FilesystemMutationActionId, input: { rootPath: workspacePath.workingDirectory, path: authorized.resolvedPath, recursive: false } }));
        if (!removed || typeof removed !== 'object' || Reflect.get(removed, 'success') !== true) {
          throw new Error('Browser recording draft could not be removed from the Session workspace.');
        }
      } else await rm(authorized.resolvedPath, { force: true });
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
        const input: Parameters<typeof persistSessionMedia>[0]['input'] = {
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
        };
        // Record START decided who writes this Session's files; the save follows that decision.
        const save = context?.recordingSave;
        const member = save?.sessionId === target.sessionId ? save.member : undefined;
        const persisted = await (member
          ? persistSessionMediaAsMember(member, { workingDirectory, sourceAccessPolicy, input })
          : persistSessionMedia({ workingDirectory, accessPolicy, sourceAccessPolicy,
            pathAllowanceRegistry: options.pathAllowanceRegistry, input })).catch(error => { throw notWritten(error); });
        if (!persisted.success) throw notWritten(new Error(`Browser recording media persistence failed: ${persisted.code}`));
        const mediaRef = convertPersistedItemToMediaRef(persisted);
        const stored = { path: persisted.item.path, workingDirectory, ...(member ? { member } : {}) };
        workspacePathByRecordingId.set(recording.recordingId, { ...stored, attached: false });
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
          workspacePathByRecordingId.set(recording.recordingId, { ...stored, attached: true });
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
