import { dirname } from 'node:path';

import {
  ComposerAttachmentDraftV1Schema,
  ComposerAttachmentInputV1Schema,
  ComposerContentHandleV1Schema,
  SessionMediaMessageMetaV1Schema,
  type ComposerAttachmentDraftV1,
  type ComposerAttachmentInputV1,
  type ComposerContentHandleV1,
  type ComposerRefV1,
  type PluginContributionIdentityV1,
  type SessionExecutionTargetV1,
} from '@happier-dev/protocol';
import {
  garbageCollectFailedSessionMediaCommit,
  persistSessionMediaForTranscript,
  type SessionMediaBridgePersistResult,
} from '@/api/session/client/transcript/sessionMediaBridge';
import type {
  ComposerMediaStageClaimant,
  ComposerMediaStageInspection,
  ComposerMediaStageStore,
} from '@/transfers/staging/composerMediaStageStore';

import {
  resolveSessionMediaMimeType,
  sessionMediaKindForMimeType,
} from './mime';

type MetadataRecord = Record<string, unknown>;

type LoggerLike = Readonly<{
  debug: (message: string, details?: unknown) => void;
}>;

export type ComposerStagedMediaFinalizationErrorCode =
  | 'composer_staged_media_attachment_invalid'
  | 'composer_staged_media_target_mismatch'
  | 'composer_staged_media_owner_mismatch'
  | 'composer_staged_media_mime_invalid'
  | 'composer_staged_media_stage_unavailable'
  | 'composer_staged_media_metadata_conflict'
  | 'composer_staged_media_persist_failed'
  | 'composer_staged_media_persist_mismatch'
  | 'composer_staged_media_working_directory_required';

/** Typed pre-admission refusal; the completed transfer stage remains retryable. */
export class ComposerStagedMediaFinalizationError extends Error {
  constructor(readonly code: ComposerStagedMediaFinalizationErrorCode) {
    super(code);
    this.name = 'ComposerStagedMediaFinalizationError';
  }
}

/** The only request-local facts needed after durable Message admission. */
export type ComposerStagedMediaReleaseIntent = Readonly<{
  handle: ComposerContentHandleV1;
  executionTarget: SessionExecutionTargetV1;
  owner: PluginContributionIdentityV1;
  claimant: ComposerMediaStageClaimant;
}>;

export type ComposerStagedMediaFinalizationResult = Readonly<{
  meta: MetadataRecord;
  attachments: readonly ComposerAttachmentInputV1[];
  releaseIntents: readonly ComposerStagedMediaReleaseIntent[];
  createdWorkspaceRelativePaths: readonly string[];
}>;

type ReadyStagedMedia = Readonly<{
  attachment: ComposerAttachmentDraftV1;
  handle: ComposerContentHandleV1;
  inspection: Extract<ComposerMediaStageInspection, { status: 'ready' }>;
  claimant: ComposerMediaStageClaimant;
}>;

function fail(code: ComposerStagedMediaFinalizationErrorCode): never {
  throw new ComposerStagedMediaFinalizationError(code);
}

function asRecord(value: unknown): MetadataRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MetadataRecord
    : null;
}

function sameExecutionTarget(
  left: SessionExecutionTargetV1,
  right: SessionExecutionTargetV1,
): boolean {
  return left.serverId === right.serverId && left.machineId === right.machineId;
}

function sameOwner(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function sameHandle(
  left: ComposerContentHandleV1,
  right: ComposerContentHandleV1,
): boolean {
  return left.v === right.v
    && left.id === right.id
    && sameExecutionTarget(left.executionTarget, right.executionTarget)
    && sameOwner(left.owner, right.owner)
    && left.mediaKind === right.mediaKind
    && left.mimeType === right.mimeType
    && left.name === right.name
    && left.sizeBytes === right.sizeBytes
    && left.sha256.toLowerCase() === right.sha256.toLowerCase();
}

function assertNoExistingSessionMediaEnvelope(meta: MetadataRecord): void {
  for (const key of ['happier', 'happierMedia']) {
    const candidate = asRecord(meta[key]);
    if (candidate?.kind !== 'session_media.v1') continue;
    if (!SessionMediaMessageMetaV1Schema.safeParse(candidate).success) {
      fail('composer_staged_media_metadata_conflict');
    }
    fail('composer_staged_media_metadata_conflict');
  }
}

function assertSupportedHandle(
  rawHandle: unknown,
  executionTarget: SessionExecutionTargetV1,
  owner: PluginContributionIdentityV1,
): ComposerContentHandleV1 {
  const parsed = ComposerContentHandleV1Schema.safeParse(rawHandle);
  if (!parsed.success) fail('composer_staged_media_attachment_invalid');
  const handle = parsed.data;
  if (!sameExecutionTarget(handle.executionTarget, executionTarget)) {
    fail('composer_staged_media_target_mismatch');
  }
  if (!sameOwner(handle.owner, owner)) {
    fail('composer_staged_media_owner_mismatch');
  }
  const mimeType = resolveSessionMediaMimeType({
    declaredMimeType: handle.mimeType,
    suggestedName: handle.name,
    allowVideoByDeclarationOrExtension: true,
  });
  if (!mimeType || mimeType !== handle.mimeType || sessionMediaKindForMimeType(mimeType) !== handle.mediaKind) {
    fail('composer_staged_media_mime_invalid');
  }
  return handle;
}

async function inspectReadyStagedMedia(params: Readonly<{
  sourceComposerRef: ComposerRefV1;
  destinationComposerRef: ComposerRefV1;
  messageLocalId: string;
  attachments: readonly ComposerAttachmentDraftV1[];
  executionTarget: SessionExecutionTargetV1;
  stageStore: ComposerMediaStageStore;
}>): Promise<readonly ReadyStagedMedia[]> {
  const staged: ReadyStagedMedia[] = [];
  const stageIds = new Set<string>();
  for (const rawAttachment of params.attachments) {
    const attachment = ComposerAttachmentDraftV1Schema.safeParse(rawAttachment);
    if (!attachment.success) fail('composer_staged_media_attachment_invalid');
    if (!attachment.data.content) continue;

    const handle = assertSupportedHandle(
      attachment.data.content.handle,
      params.executionTarget,
      attachment.data.attachment,
    );
    if (stageIds.has(handle.id)) fail('composer_staged_media_attachment_invalid');
    stageIds.add(handle.id);
    const sourceClaimant: ComposerMediaStageClaimant = {
      composer: params.sourceComposerRef,
      attachmentInstanceId: attachment.data.instanceId,
    };
    const claimant: ComposerMediaStageClaimant = {
      composer: params.destinationComposerRef,
      attachmentInstanceId: attachment.data.instanceId,
    };
    // Every captured submission snapshot submits against its own fork copy, even
    // when the source and destination Composer refs are equal. Persisting the
    // mutable draft original would let a concurrent draft removal delete the
    // exact bytes between this inspection and Session persistence.
    const submissionHandle = (await params.stageStore.forkClaimForSubmission({
      handle,
      executionTarget: params.executionTarget,
      owner: attachment.data.attachment,
      sourceClaimant,
      destinationClaimant: claimant,
      messageLocalId: params.messageLocalId,
    })).handle;
    if (!submissionHandle) fail('composer_staged_media_stage_unavailable');
    const inspection = await params.stageStore.inspectForFinalization({
      handle: submissionHandle,
      executionTarget: params.executionTarget,
      owner: attachment.data.attachment,
      claimant,
    });
    if (inspection.status !== 'ready') fail('composer_staged_media_stage_unavailable');
    if (
      !sameHandle(inspection.handle, submissionHandle)
      || inspection.mediaKind !== handle.mediaKind
      || inspection.mimeType !== handle.mimeType
      || inspection.name !== handle.name
      || inspection.sizeBytes !== handle.sizeBytes
      || inspection.sha256.toLowerCase() !== handle.sha256.toLowerCase()
    ) {
      fail('composer_staged_media_stage_unavailable');
    }
    staged.push({ attachment: attachment.data, handle: submissionHandle, inspection, claimant });
  }
  return Object.freeze(staged);
}

function toInputAttachment(
  attachment: ComposerAttachmentDraftV1,
  mediaId: string | null,
): ComposerAttachmentInputV1 {
  if (attachment.content && !mediaId) {
    fail('composer_staged_media_persist_mismatch');
  }
  const { content: _discardedStagedContent, ...base } = attachment;
  return ComposerAttachmentInputV1Schema.parse({
    ...base,
    ...(mediaId ? { content: { kind: 'sessionMedia', mediaId } } : {}),
  });
}

function assertPersistedItemMatchesStage(
  item: SessionMediaBridgePersistResult['items'][number],
  staged: ReadyStagedMedia,
): void {
  if (
    item.role !== 'input'
    || item.category !== 'attachment'
    || item.origin.source !== 'user-upload'
    || item.mediaKind !== staged.handle.mediaKind
    || item.mimeType !== staged.handle.mimeType
    || item.name !== staged.handle.name
    || item.sizeBytes !== staged.handle.sizeBytes
    || item.sha256?.toLowerCase() !== staged.handle.sha256.toLowerCase()
  ) {
    fail('composer_staged_media_persist_mismatch');
  }
}

async function cleanupNewUncommittedMedia(params: Readonly<{
  workingDirectory: string;
  persisted: SessionMediaBridgePersistResult;
  logger?: LoggerLike;
}>): Promise<void> {
  await garbageCollectFailedSessionMediaCommit({
    workingDirectory: params.workingDirectory,
    persisted: params.persisted,
    ...(params.logger ? { logger: params.logger } : {}),
  }).catch(() => undefined);
}

/**
 * The one SessionMedia finalizer for Composer's transfer-owned staged image/video content.
 * It never persists the stage path or handle: only a verified durable SessionMedia id reaches
 * admitted Composer input, while release remains a request-local post-admission action.
 */
export async function finalizeComposerStagedMediaToSession(params: Readonly<{
  sessionId: string;
  sourceComposerRef?: ComposerRefV1;
  messageLocalId: string;
  workingDirectory: string;
  executionTarget: SessionExecutionTargetV1;
  stageStore: ComposerMediaStageStore;
  meta: MetadataRecord;
  attachments: readonly ComposerAttachmentDraftV1[];
  logger?: LoggerLike;
}>): Promise<ComposerStagedMediaFinalizationResult> {
  const destinationComposerRef: ComposerRefV1 = { kind: 'session', sessionId: params.sessionId };
  const staged = await inspectReadyStagedMedia({
    sourceComposerRef: params.sourceComposerRef ?? destinationComposerRef,
    destinationComposerRef,
    messageLocalId: params.messageLocalId,
    attachments: params.attachments,
    executionTarget: params.executionTarget,
    stageStore: params.stageStore,
  });
  if (staged.length === 0) {
    return {
      meta: params.meta,
      attachments: Object.freeze(params.attachments.map((attachment) => toInputAttachment(attachment, null))),
      releaseIntents: Object.freeze([]),
      createdWorkspaceRelativePaths: Object.freeze([]),
    };
  }
  if (params.workingDirectory.trim().length === 0) {
    fail('composer_staged_media_working_directory_required');
  }
  assertNoExistingSessionMediaEnvelope(params.meta);

  const persisted = await persistSessionMediaForTranscript({
    sessionId: params.sessionId,
    workingDirectory: params.workingDirectory,
    request: {
      localId: params.messageLocalId,
      role: 'input',
      category: 'attachment',
      meta: params.meta,
      media: staged.map(({ handle, inspection }) => ({
        source: {
          kind: 'local-file' as const,
          path: inspection.filePath,
          mimeType: handle.mimeType,
          fileNameHint: handle.name,
        },
        sourceAccessPolicy: {
          kind: 'restrictedRoots' as const,
          roots: [dirname(inspection.filePath)],
        },
        origin: { source: 'user-upload' as const },
        suggestedName: handle.name,
      })),
    },
    ...(params.logger ? { logger: params.logger } : {}),
  });
  if (!persisted.success || persisted.items.length !== staged.length) {
    await cleanupNewUncommittedMedia({
      workingDirectory: params.workingDirectory,
      persisted,
      ...(params.logger ? { logger: params.logger } : {}),
    });
    fail('composer_staged_media_persist_failed');
  }
  try {
    for (let index = 0; index < staged.length; index += 1) {
      assertPersistedItemMatchesStage(persisted.items[index]!, staged[index]!);
    }
  } catch (error) {
    await cleanupNewUncommittedMedia({
      workingDirectory: params.workingDirectory,
      persisted,
      ...(params.logger ? { logger: params.logger } : {}),
    });
    throw error;
  }

  const mediaIdByAttachmentInstanceId = new Map(
    staged.map((entry, index) => [entry.attachment.instanceId, persisted.items[index]!.id]),
  );
  return {
    meta: persisted.meta,
    attachments: Object.freeze(params.attachments.map((attachment) => toInputAttachment(
      attachment,
      mediaIdByAttachmentInstanceId.get(attachment.instanceId) ?? null,
    ))),
    releaseIntents: Object.freeze(staged.map(({ handle, attachment, claimant }) => Object.freeze({
      handle,
      executionTarget: params.executionTarget,
      owner: attachment.attachment,
      claimant,
    }))),
    createdWorkspaceRelativePaths: persisted.createdWorkspaceRelativePaths,
  };
}
