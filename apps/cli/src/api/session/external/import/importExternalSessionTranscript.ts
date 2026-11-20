import { buildSessionTranscriptMessageProvenanceV1, SESSION_MESSAGE_PROVENANCE_META_KEY, stripSessionInputProtectedMeta } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { isMessageStructuredPresentationV1Candidate } from '@happier-dev/protocol/sessions/messages/messageStructuredPresentationV1';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import type { ExternalSessionOperationSocketBatchItemV1 } from '@happier-dev/protocol/sessions/external/operationActionsV1';
import { createLegacyInlineContentDigestV1 } from '@happier-dev/protocol/sessions/messages/sessionToolOutputBindingV1';
import { normalizeSessionStoredMessageContentForStorage } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { SessionMessageRoleSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { projectUsageSessionMessageTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import type { ExternalSessionTranscriptRawMessageV1, SessionMessageRole, StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol';

import { splitDurableSessionToolOutput } from '@/api/session/client/transport/outboundSessionMessagePayload';
import { redactTranscriptSecrets } from '@/api/session/client/transport/transcriptSecretRedaction';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import {
  encryptSessionMessagePayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  type SessionStoredContentCryptoContext,
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
    meta[SESSION_MESSAGE_PROVENANCE_META_KEY] = buildSessionTranscriptMessageProvenanceV1(
      'externalSessionHistory',
    );
  }
  return { ...params.raw, meta };
}

function buildStoredMessageContent(params: Readonly<{
  sessionId: string;
  localId: string;
  rawSession: RawSessionRecord;
  credentials: StoredCredentials;
  raw: Record<string, unknown>;
  toolOutputStorage?: 'detached';
}>): Pick<ExternalSessionOperationSocketBatchItemV1, 'content' | 'toolOutputPart' | 'legacyInlineContentDigest'> {
  // Structured presentation remains host-private prework. This is the one
  // historical-import boundary that still owns plaintext for both storage
  // modes, so share the canonical Message-writer profile reservation before
  // E2EE can make an unsupported profile opaque to that writer.
  if (isMessageStructuredPresentationV1Candidate(params.raw)) {
    throw new Error('reserved_message_structured_presentation_historical_import');
  }

  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  let context: SessionStoredContentCryptoContext = { mode: 'plain', ctx: null };
  if (mode === 'e2ee') {
    const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);
    if (!ctx) throw new Error('session_encryption_material_unavailable');
    context = { mode, ctx };
  }
  const idempotencyKey = JSON.stringify([params.sessionId, params.localId]);
  const seal = (payload: unknown): StrictSessionStoredMessageContentEnvelope => context.mode === 'plain'
    ? { t: 'plain', v: payload }
    : { t: 'encrypted', c: encryptSessionMessagePayload({ ctx: context.ctx, payload, idempotencyKey }) };

  // Production imports stay inline until the exact output reader is available.
  if (params.toolOutputStorage !== 'detached') return { content: seal(params.raw) };
  const split = splitDurableSessionToolOutput(context, { ...params, content: redactTranscriptSecrets(params.raw) });
  if (!split) return { content: seal(params.raw) };
  const original = seal(params.raw);
  const normalized = normalizeSessionStoredMessageContentForStorage(original.t === 'plain'
    ? { t: 'plain', v: projectNativeJsonValueForTransport(original.v) } : original);
  if (!normalized) throw new Error('invalid_legacy_inline_message');
  return {
    content: seal(split.shell),
    toolOutputPart: split.toolOutputPart,
    legacyInlineContentDigest: createLegacyInlineContentDigestV1(params.sessionId, params.localId, normalized),
  };
}

export async function prepareExternalSessionHistoricalImportItem(params: Readonly<{
  item: ExternalSessionTranscriptRawMessageV1;
  linked: LoadedLinkedExternalSession;
  credentials: StoredCredentials;
  sessionId: string;
  toolOutputStorage?: 'detached';
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
}>): Promise<Readonly<ExternalSessionOperationSocketBatchItemV1>> {
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
  let stored: ReturnType<typeof buildStoredMessageContent>;
  try {
    stored = buildStoredMessageContent({
      sessionId: params.sessionId,
      localId,
      rawSession: params.linked.rawSession,
      credentials: params.credentials,
      raw,
      toolOutputStorage: params.toolOutputStorage,
    });
  } catch {
    throw new ExternalSessionHistoricalImportRequiredItemError('conversion');
  }
  return {
    localId,
    sidechainId: params.item.sidechainId ?? null,
    messageRole,
    ...stored,
    usageTimingV1: projectUsageSessionMessageTimingV1({ sessionId: params.sessionId,
      message: { id: localId, localId, content: raw, createdAt: params.item.createdAtMs } }),
    ...(typeof params.item.createdAtMs === 'number' && Number.isSafeInteger(params.item.createdAtMs) && params.item.createdAtMs >= 0
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
  toolOutputStorage?: 'detached';
}>): Readonly<ExternalSessionOperationSocketBatchItemV1> {
  const localId = makeExternalSessionHistoricalImportLocalId({
    agentId: params.linked.agentId,
    remoteSessionId: params.linked.remoteSessionId,
    directItemId: params.staged.item.id,
  });
  const parsedMessageRole = SessionMessageRoleSchema.safeParse(params.staged.item.messageRole);
  const messageRole = parsedMessageRole.success ? parsedMessageRole.data : null;
  let raw: Record<string, unknown>;
  let stored: ReturnType<typeof buildStoredMessageContent>;
  try {
    raw = sanitizeHistoricalImportRaw({
      item: params.staged.item, messageRole,
      raw: projectSessionMediaMetadataForHistoricalImportValidation({
        raw: params.staged.item.raw, sessionId: params.sessionId, messageLocalId: localId,
      }),
    });
    stored = buildStoredMessageContent({
      sessionId: params.sessionId,
      localId,
      rawSession: params.linked.rawSession,
      credentials: params.credentials,
      raw,
      toolOutputStorage: params.toolOutputStorage,
    });
  } catch {
    throw new ExternalSessionHistoricalImportRequiredItemError('conversion');
  }
  return {
    localId,
    sidechainId: params.staged.item.sidechainId ?? null,
    messageRole,
    ...stored,
    usageTimingV1: projectUsageSessionMessageTimingV1({ sessionId: params.sessionId,
      message: { id: localId, localId, content: raw, createdAt: params.staged.item.createdAtMs } }),
    ...(typeof params.staged.item.createdAtMs === 'number' && Number.isSafeInteger(params.staged.item.createdAtMs) && params.staged.item.createdAtMs >= 0
      ? { sourceCreatedAtMs: params.staged.item.createdAtMs }
      : {}),
  };
}
