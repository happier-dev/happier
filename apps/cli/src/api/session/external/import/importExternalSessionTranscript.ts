import {
  isMessageStructuredPresentationV1Candidate,
  makeExternalSessionHistoricalImportLocalId,
  SESSION_MESSAGE_PROVENANCE_META_KEY,
  SessionMessageRoleSchema,
  stripSessionInputProtectedMeta,
  type ExternalSessionTranscriptRawMessageV1,
  type SessionMessageRole,
  type SessionStoredMessageContent,
  type SidechainId,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import {
  encryptSessionPayload,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * An External Sessions source classification is descriptive rather than an input admission.
 * Strip source-owned protected facts and let this host boundary mint the one history provenance
 * that external-share projection recognizes.
 */
function sanitizeHistoricalImportRaw(params: Readonly<{
  item: ExternalSessionTranscriptRawMessageV1;
  messageRole: SessionMessageRole | null;
  raw: Record<string, unknown>;
}>): Record<string, unknown> {
  const sourceFact = params.item.userProjection === 'source_fact'
    && params.messageRole === 'user';
  const rawMeta = params.raw.meta;
  if (!sourceFact && !isRecord(rawMeta)) return params.raw;

  const meta = stripSessionInputProtectedMeta(isRecord(rawMeta) ? rawMeta : undefined);
  delete meta[SESSION_MESSAGE_PROVENANCE_META_KEY];
  if (sourceFact) {
    meta[SESSION_MESSAGE_PROVENANCE_META_KEY] = {
      v: 1,
      kind: 'host',
      producer: 'externalSessionHistory',
    };
  }
  return { ...params.raw, meta };
}

function buildStoredMessageContent(params: Readonly<{
  rawSession: RawSessionRecord;
  credentials: StoredCredentials;
  raw: Record<string, unknown>;
}>): SessionStoredMessageContent {
  // Structured presentation remains host-private prework. This is the one
  // historical-import boundary that still owns plaintext for both storage
  // modes, so share the canonical Message-writer profile reservation before
  // E2EE can make an unsupported profile opaque to that writer.
  if (isMessageStructuredPresentationV1Candidate(params.raw)) {
    throw new Error('reserved_message_structured_presentation_historical_import');
  }

  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (mode === 'plain') {
    return { t: 'plain', v: params.raw };
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);
  if (!ctx) {
    throw new Error('session_encryption_material_unavailable');
  }
  return {
    t: 'encrypted',
    c: encryptSessionPayload({
      ctx,
      payload: params.raw,
    }),
  };
}

export async function prepareExternalSessionHistoricalImportItem(params: Readonly<{
  item: ExternalSessionTranscriptRawMessageV1;
  linked: LoadedLinkedExternalSession;
  credentials: StoredCredentials;
  sessionId: string;
  workingDirectory: string | null;
  sourceReadRoots: readonly string[];
  createdWorkspaceMediaPaths?: string[];
  persistedWorkspaceMediaPaths?: string[];
  /**
   * Awaited per resolved candidate destination before any bytes are written,
   * so operation-owned cleanup custody exists before media creation (the
   * crash between write and bookkeeping can no longer orphan workspace
   * media).
   */
  recordIntendedWorkspaceMedia?: (media: Readonly<{
    workingDirectory: string;
    candidateWorkspaceRelativePath: string;
  }>) => Promise<void>;
}>): Promise<Readonly<{
  localId: string;
  sidechainId: SidechainId | null;
  messageRole: SessionMessageRole | null;
  content: SessionStoredMessageContent;
  sourceCreatedAtMs?: number;
}>> {
  const localId = makeExternalSessionHistoricalImportLocalId({
    agentId: params.linked.agentId,
    remoteSessionId: params.linked.remoteSessionId,
    directItemId: params.item.id,
  });
  const parsedMessageRole = SessionMessageRoleSchema.safeParse(params.item.messageRole);
  const messageRole = parsedMessageRole.success ? parsedMessageRole.data : null;
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
        ...(params.recordIntendedWorkspaceMedia
          ? {
              onIntendedWorkspacePath: async (candidateWorkspaceRelativePath) => {
                await params.recordIntendedWorkspaceMedia!({
                  workingDirectory: params.workingDirectory!,
                  candidateWorkspaceRelativePath,
                });
              },
            }
          : {}),
        onCreatedWorkspacePath: (path) => params.createdWorkspaceMediaPaths?.push(path),
        onPersistedWorkspacePath: (path) => params.persistedWorkspaceMediaPaths?.push(path),
      })
      : params.item.raw;
  } catch {
    throw new ExternalSessionHistoricalImportRequiredItemError('media');
  }
  raw = sanitizeHistoricalImportRaw({ item: params.item, messageRole, raw });
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
  return {
    localId,
    sidechainId: params.item.sidechainId ?? null,
    messageRole,
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
  credentials: StoredCredentials;
  sessionId: string;
}>): Readonly<{
  localId: string;
  sidechainId: SidechainId | null;
  messageRole: SessionMessageRole | null;
  content: SessionStoredMessageContent;
  sourceCreatedAtMs?: number;
}> {
  const localId = makeExternalSessionHistoricalImportLocalId({
    agentId: params.linked.agentId,
    remoteSessionId: params.linked.remoteSessionId,
    directItemId: params.staged.item.id,
  });
  const parsedMessageRole = SessionMessageRoleSchema.safeParse(params.staged.item.messageRole);
  const messageRole = parsedMessageRole.success ? parsedMessageRole.data : null;
  let content: SessionStoredMessageContent;
  try {
    content = buildStoredMessageContent({
      rawSession: params.linked.rawSession,
      credentials: params.credentials,
      raw: sanitizeHistoricalImportRaw({
        item: params.staged.item,
        messageRole,
        raw: projectSessionMediaMetadataForHistoricalImportValidation({
          raw: params.staged.item.raw,
          sessionId: params.sessionId,
          messageLocalId: localId,
        }),
      }),
    });
  } catch {
    throw new ExternalSessionHistoricalImportRequiredItemError('conversion');
  }
  return {
    localId,
    sidechainId: params.staged.item.sidechainId ?? null,
    messageRole,
    content,
    ...(Number.isSafeInteger(params.staged.item.createdAtMs) && params.staged.item.createdAtMs >= 0
      ? { sourceCreatedAtMs: params.staged.item.createdAtMs }
      : {}),
  };
}
