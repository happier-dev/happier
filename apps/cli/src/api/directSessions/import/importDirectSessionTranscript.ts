import { createHash } from 'node:crypto';

import {
  SESSION_MEDIA_MESSAGE_META_KIND_V1,
  type SessionStoredMessageContent,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { commitSessionStoredMessage } from '@/session/transport/http/sessionsHttp';
import {
  encryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { LoadedLinkedDirectSession } from '@/api/directSessions/takeover/loadLinkedDirectSession';
import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';
import { getDirectSessionProviderOps } from '@/backends/catalog';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { persistSessionMediaItem, type PersistSessionMediaInput } from '@/session/sessionMedia/persistSessionMediaItem';
import type { SessionMediaOrigin } from '@/session/sessionMedia/sessionMediaIngestionSource';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function resolvePageMaxBytes(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_DIRECT_SESSIONS_PAGE_MAX_BYTES ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 512_000;
  return Math.max(1024, Math.min(10 * 1024 * 1024, configured));
}

function resolvePageMaxItems(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
  return Math.max(1, Math.min(5000, configured));
}

function makeImportLocalId(params: Readonly<{
  providerId: string;
  remoteSessionId: string;
  directItemId: string;
}>): string {
  const digest = sha256(`${params.providerId}:${params.remoteSessionId}:${params.directItemId}`).slice(0, 24);
  return `direct-import:v1:${params.providerId}:${digest}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isDurableSessionMediaPath(value: string): boolean {
  if (!value.startsWith('.happier/uploads/')) return false;
  if (value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  if (value.startsWith('file://') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function readMediaOrigin(value: unknown): SessionMediaOrigin {
  const record = asRecord(value);
  const source = record?.source;
  const normalizedSource: SessionMediaOrigin['source'] =
    source === 'user-upload' ||
    source === 'provider-generated' ||
    source === 'tool-output' ||
    source === 'acp-content' ||
    source === 'mcp-content' ||
    source === 'local-file'
      ? source
      : 'provider-generated';

  return {
    source: normalizedSource,
    ...(readString(record?.agentId) ? { agentId: readString(record?.agentId)! } : {}),
    ...(readString(record?.toolCallId) ? { toolCallId: readString(record?.toolCallId)! } : {}),
    ...(readString(record?.generationId) ? { generationId: readString(record?.generationId)! } : {}),
    ...(readString(record?.providerEventId) ? { providerEventId: readString(record?.providerEventId)! } : {}),
    ...(readString(record?.providerFileId) ? { providerFileId: readString(record?.providerFileId)! } : {}),
  };
}

function readMediaCategory(value: unknown): PersistSessionMediaInput['category'] {
  return value === 'attachment' || value === 'generated' || value === 'tool-artifact' ? value : 'generated';
}

function readMediaRole(value: unknown): PersistSessionMediaInput['role'] {
  return value === 'input' || value === 'output' ? value : 'output';
}

type DirectTranscriptPage = Readonly<{
  items: DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  hasMore: boolean;
  truncated?: boolean;
}>;

async function loadDirectTranscriptPage(params: Readonly<{
  linked: LoadedLinkedDirectSession;
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<DirectTranscriptPage> {
  return await (await getDirectSessionProviderOps(params.linked.providerId)).pageTranscript({
    source: params.linked.source,
    remoteSessionId: params.linked.remoteSessionId,
    direction: 'older',
    cursor: params.cursor,
    maxBytes: params.maxBytes,
    maxItems: params.maxItems,
  });
}

async function loadAllDirectTranscriptItems(params: Readonly<{
  linked: LoadedLinkedDirectSession;
}>): Promise<DirectTranscriptRawMessageV1[]> {
  const pageMaxBytes = resolvePageMaxBytes();
  const pageMaxItems = resolvePageMaxItems();
  const pages: DirectTranscriptRawMessageV1[][] = [];
  let cursor: string | undefined = undefined;

  for (let pageIndex = 0; pageIndex < 10_000; pageIndex += 1) {
    const page = await loadDirectTranscriptPage({
      linked: params.linked,
      cursor,
      maxBytes: pageMaxBytes,
      maxItems: pageMaxItems,
    });

    if (page.items.length > 0) {
      pages.push(page.items.slice());
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const ordered: DirectTranscriptRawMessageV1[] = [];
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    ordered.push(...pages[index]!);
  }
  return ordered;
}

async function adoptDirectSessionMediaEnvelope(params: Readonly<{
  envelope: unknown;
  sessionId: string;
  messageLocalId: string;
  workingDirectory: string;
}>): Promise<unknown> {
  const envelope = asRecord(params.envelope);
  if (!envelope || envelope.kind !== SESSION_MEDIA_MESSAGE_META_KIND_V1) return params.envelope;
  const payload = asRecord(envelope.payload);
  const media = Array.isArray(payload?.media) ? payload.media : [];
  if (media.length === 0) return params.envelope;

  const adoptedMedia: unknown[] = [];
  const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

  for (const mediaValue of media) {
    const mediaRecord = asRecord(mediaValue);
    const path = readString(mediaRecord?.path);
    if (!mediaRecord || !path) continue;

    if (isDurableSessionMediaPath(path)) {
      adoptedMedia.push(mediaRecord);
      continue;
    }

    const result = await persistSessionMediaItem({
      workingDirectory: params.workingDirectory,
      pathAllowanceRegistry,
      input: {
        sessionId: params.sessionId,
        messageLocalId: params.messageLocalId,
        role: readMediaRole(mediaRecord.role),
        category: readMediaCategory(mediaRecord.category),
        source: path.startsWith('file://')
          ? {
              kind: 'local-uri',
              uri: path,
              ...(readString(mediaRecord.mimeType) ? { mimeType: readString(mediaRecord.mimeType)! } : {}),
              ...(readString(mediaRecord.name) ? { suggestedName: readString(mediaRecord.name)! } : {}),
            }
          : {
              kind: 'local-file',
              path,
              ...(readString(mediaRecord.mimeType) ? { mimeType: readString(mediaRecord.mimeType)! } : {}),
              ...(readString(mediaRecord.name) ? { suggestedName: readString(mediaRecord.name)! } : {}),
            },
        origin: readMediaOrigin(mediaRecord.origin),
      },
    });

    if (result.success) {
      adoptedMedia.push(result.item);
    }
  }

  if (adoptedMedia.length === 0) return undefined;
  return {
    kind: SESSION_MEDIA_MESSAGE_META_KIND_V1,
    payload: { media: adoptedMedia },
  };
}

async function adoptDirectSessionMediaForImport(params: Readonly<{
  raw: Record<string, unknown>;
  sessionId: string;
  messageLocalId: string;
  workingDirectory: string | null;
}>): Promise<Record<string, unknown>> {
  if (!params.workingDirectory) return params.raw;
  const meta = asRecord(params.raw.meta);
  if (!meta) return params.raw;

  const nextMeta: Record<string, unknown> = { ...meta };
  const primary = await adoptDirectSessionMediaEnvelope({
    envelope: nextMeta.happier,
    sessionId: params.sessionId,
    messageLocalId: params.messageLocalId,
    workingDirectory: params.workingDirectory,
  });
  const secondary = await adoptDirectSessionMediaEnvelope({
    envelope: nextMeta.happierMedia,
    sessionId: params.sessionId,
    messageLocalId: params.messageLocalId,
    workingDirectory: params.workingDirectory,
  });

  if (primary === undefined) {
    delete nextMeta.happier;
  } else {
    nextMeta.happier = primary;
  }
  if (secondary === undefined) {
    delete nextMeta.happierMedia;
  } else {
    nextMeta.happierMedia = secondary;
  }

  return { ...params.raw, meta: nextMeta };
}

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

export async function importDirectSessionTranscript(params: Readonly<{
  linked: LoadedLinkedDirectSession;
  credentials: Credentials;
  sessionId: string;
  workingDirectory?: string;
}>): Promise<Readonly<{ importedCount: number }>> {
  const items = await loadAllDirectTranscriptItems({ linked: params.linked });
  let importedCount = 0;
  const workingDirectory = readString(params.workingDirectory) ?? params.linked.sessionPath;

  for (const item of items) {
    const raw = await adoptDirectSessionMediaForImport({
      raw: item.raw,
      sessionId: params.sessionId,
      messageLocalId: item.localId ?? item.id,
      workingDirectory,
    });
    const content = buildStoredMessageContent({
      rawSession: params.linked.rawSession,
      credentials: params.credentials,
      raw,
    });

    await commitSessionStoredMessage({
      token: params.credentials.token,
      sessionId: params.sessionId,
      content,
      messageRole: item.messageRole ?? undefined,
      localId: makeImportLocalId({
        providerId: params.linked.providerId,
        remoteSessionId: params.linked.remoteSessionId,
        directItemId: item.id,
      }),
    });
    importedCount += 1;
  }

  return { importedCount };
}
