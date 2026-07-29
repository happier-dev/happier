import {
  makeExternalSessionHistoricalImportLocalId,
  SessionMessageRoleSchema,
  type ExternalSessionTranscriptRawMessageV1,
  type SessionMessageRole,
  type SessionStoredMessageContent,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import {
  encryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
  adoptSessionMediaMetadataForManagedSession,
  countStagedSessionMediaMetadata,
  projectSessionMediaMetadataForHistoricalImportValidation,
  stageSessionMediaMetadataForHistoricalImport,
} from '@/session/media/adoption';
import { garbageCollectUncommittedSessionMedia } from '@/session/media/garbageCollect';

export type ExternalSessionHistoricalImportRequiredItemFailureCategory =
  | 'record'
  | 'media'
  | 'conversion';

export class ExternalSessionHistoricalImportRequiredItemError extends Error {
  readonly category: ExternalSessionHistoricalImportRequiredItemFailureCategory;

  constructor(category: ExternalSessionHistoricalImportRequiredItemFailureCategory) {
    super('A required external-session transcript item could not be prepared.');
    this.name = 'ExternalSessionHistoricalImportRequiredItemError';
    this.category = category;
  }
}

export type ExternalSessionHistoricalImportStagedItem = Readonly<{
  v: 1;
  kind: 'external_session_historical_import_staged_item';
  item: ExternalSessionTranscriptRawMessageV1;
  mediaWorkingDirectory?: string;
}>;

function buildStoredMessageContent(params: Readonly<{
  rawSession: RawSessionRecord;
  credentials: Credentials;
  raw: Record<string, unknown>;
}>): SessionStoredMessageContent {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (mode === 'plain') {
    return { t: 'plain', v: params.raw };
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);
  return {
    t: 'encrypted',
    c: encryptStoredSessionPayload({
      mode: 'e2ee',
      ctx,
      payload: params.raw,
    }),
  };
}

export async function prepareExternalSessionHistoricalImportItem(params: Readonly<{
  item: ExternalSessionTranscriptRawMessageV1;
  linked: LoadedLinkedExternalSession;
  credentials: Credentials;
  sessionId: string;
  workingDirectory: string | null;
  sourceReadRoots: readonly string[];
  createdWorkspaceMediaPaths?: string[];
  cleanupWorkspaceMediaPaths?: string[];
}>): Promise<Readonly<{
  localId: string;
  sidechainId: string | null;
  messageRole: SessionMessageRole | null;
  content: SessionStoredMessageContent;
  sourceCreatedAtMs?: number;
}>> {
  const localId = makeExternalSessionHistoricalImportLocalId({
    agentId: params.linked.agentId,
    remoteSessionId: params.linked.remoteSessionId,
    directItemId: params.item.id,
  });
  let raw: Record<string, unknown>;
  try {
    if (
      !params.workingDirectory
      && countStagedSessionMediaMetadata(params.item.raw) > 0
    ) {
      throw new Error('historical_import_media_working_directory_unavailable');
    }
    raw = params.workingDirectory
      ? await adoptSessionMediaMetadataForManagedSession({
        raw: params.item.raw,
        sessionId: params.sessionId,
        messageLocalId: localId,
        workingDirectory: params.workingDirectory,
        sourceReadRoots: params.sourceReadRoots,
        onCreatedWorkspacePath: (path) => params.createdWorkspaceMediaPaths?.push(path),
        onAdoptedStagedWorkspacePath: (path) => params.cleanupWorkspaceMediaPaths?.push(path),
      })
      : params.item.raw;
  } catch {
    throw new ExternalSessionHistoricalImportRequiredItemError('media');
  }
  let content: SessionStoredMessageContent;
  try {
    content = buildStoredMessageContent({
      rawSession: params.linked.rawSession,
      credentials: params.credentials,
      raw,
    });
  } catch {
    throw new ExternalSessionHistoricalImportRequiredItemError('conversion');
  }
  const messageRole = SessionMessageRoleSchema.safeParse(params.item.messageRole);
  return {
    localId,
    sidechainId: null,
    messageRole: messageRole.success ? messageRole.data : null,
    content,
    ...(Number.isSafeInteger(params.item.createdAtMs) && params.item.createdAtMs >= 0
      ? { sourceCreatedAtMs: params.item.createdAtMs }
      : {}),
  };
}

export async function stageExternalSessionHistoricalImportItem(params: Readonly<{
  item: ExternalSessionTranscriptRawMessageV1;
  workingDirectory: string | null;
  sourceReadRoots: readonly string[];
}>): Promise<ExternalSessionHistoricalImportStagedItem> {
  let raw: Record<string, unknown>;
  try {
    raw = await stageSessionMediaMetadataForHistoricalImport({
      raw: params.item.raw,
      workingDirectory: params.workingDirectory,
      sourceReadRoots: params.sourceReadRoots,
    });
  } catch {
    throw new ExternalSessionHistoricalImportRequiredItemError('media');
  }
  return {
    v: 1,
    kind: 'external_session_historical_import_staged_item',
    item: {
      ...params.item,
      raw,
    },
    ...(params.workingDirectory
      ? { mediaWorkingDirectory: params.workingDirectory }
      : {}),
  };
}

export async function cleanupExternalSessionHistoricalImportStagedMedia(params: Readonly<{
  staged: ExternalSessionHistoricalImportStagedItem;
  agentId: string;
  remoteSessionId: string;
  sessionId: string;
}>): Promise<void> {
  const stagedMediaCount = countStagedSessionMediaMetadata(params.staged.item.raw);
  if (stagedMediaCount === 0) return;
  const workingDirectory = params.staged.mediaWorkingDirectory;
  if (!workingDirectory) {
    throw new Error('historical_import_media_working_directory_unavailable');
  }
  const candidateWorkspaceRelativePaths: string[] = [];
  await adoptSessionMediaMetadataForManagedSession({
    raw: params.staged.item.raw,
    sessionId: params.sessionId,
    messageLocalId: makeExternalSessionHistoricalImportLocalId({
      agentId: params.agentId,
      remoteSessionId: params.remoteSessionId,
      directItemId: params.staged.item.id,
    }),
    workingDirectory,
    sourceReadRoots: [],
    onAdoptedStagedWorkspacePath: (path) => candidateWorkspaceRelativePaths.push(path),
  });
  if (candidateWorkspaceRelativePaths.length !== stagedMediaCount) {
    throw new Error('historical_import_staged_media_cleanup_unavailable');
  }
  const cleaned = await garbageCollectUncommittedSessionMedia({
    workingDirectory,
    candidateWorkspaceRelativePaths,
    reason: 'interrupted_ingestion',
  });
  if (cleaned === null) {
    throw new Error('historical_import_staged_media_cleanup_failed');
  }
}

export function readExternalSessionHistoricalImportStagedItem(
  value: unknown,
): ExternalSessionHistoricalImportStagedItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1
    || record.kind !== 'external_session_historical_import_staged_item'
    || (
      record.mediaWorkingDirectory !== undefined
      && typeof record.mediaWorkingDirectory !== 'string'
    )
    || !record.item
    || typeof record.item !== 'object'
    || Array.isArray(record.item)
  ) {
    return null;
  }
  const item = record.item as Record<string, unknown>;
  if (
    typeof item.id !== 'string'
    || !item.raw
    || typeof item.raw !== 'object'
    || Array.isArray(item.raw)
  ) {
    return null;
  }
  return value as ExternalSessionHistoricalImportStagedItem;
}

export function validateExternalSessionHistoricalImportStagedItem(params: Readonly<{
  staged: ExternalSessionHistoricalImportStagedItem;
  linked: LoadedLinkedExternalSession;
  credentials: Credentials;
  sessionId: string;
}>): Readonly<{
  localId: string;
  sidechainId: string | null;
  messageRole: SessionMessageRole | null;
  content: SessionStoredMessageContent;
  sourceCreatedAtMs?: number;
}> {
  let content: SessionStoredMessageContent;
  try {
    content = buildStoredMessageContent({
      rawSession: params.linked.rawSession,
      credentials: params.credentials,
      raw: projectSessionMediaMetadataForHistoricalImportValidation({
        raw: params.staged.item.raw,
        sessionId: params.sessionId,
        messageLocalId: makeExternalSessionHistoricalImportLocalId({
          agentId: params.linked.agentId,
          remoteSessionId: params.linked.remoteSessionId,
          directItemId: params.staged.item.id,
        }),
      }),
    });
  } catch {
    throw new ExternalSessionHistoricalImportRequiredItemError('conversion');
  }
  const messageRole = SessionMessageRoleSchema.safeParse(params.staged.item.messageRole);
  return {
    localId: makeExternalSessionHistoricalImportLocalId({
      agentId: params.linked.agentId,
      remoteSessionId: params.linked.remoteSessionId,
      directItemId: params.staged.item.id,
    }),
    sidechainId: null,
    messageRole: messageRole.success ? messageRole.data : null,
    content,
    ...(Number.isSafeInteger(params.staged.item.createdAtMs) && params.staged.item.createdAtMs >= 0
      ? { sourceCreatedAtMs: params.staged.item.createdAtMs }
      : {}),
  };
}
