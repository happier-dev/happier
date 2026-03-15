import axios from 'axios';

import type { Credentials } from '@/persistence';
import { configuration } from '@/configuration';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  resolveSessionEncryptionContextFromCredentials,
} from '@/sessionControl/sessionEncryptionContext';
import { decryptTranscriptRows } from '@/session/replay/decryptTranscriptRows';
import { tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';

import { createOpenCodeServerRuntimeClient, type OpenCodeServerRuntimeClient } from './client';
import { resolveOpenCodeUserMessageIdFromMetadata } from './openCodeUserMessageIds';

type RawTranscriptRow = Readonly<{
  id?: unknown;
  seq?: unknown;
  createdAt?: unknown;
  localId?: unknown;
  content?: unknown;
}>;

function extractOpenCodeSessionMessageId(raw: unknown): string | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const info = asRecord(rec.info);
  if (!info) return null;
  const id = normalizeString(info.id).trim();
  return id.length > 0 ? id : null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function deriveLegacyOpenCodeMessageIdFromLocalId(localId: string | null): string | null {
  const normalized = typeof localId === 'string' ? localId.trim() : '';
  if (!normalized) return null;
  return `msg_${normalized}`;
}

async function fetchSingleHappyTranscriptRow(params: {
  token: string;
  sessionId: string;
  beforeSeq: number;
}): Promise<RawTranscriptRow | null> {
  const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: {
      limit: 1,
      beforeSeq: Math.max(1, Math.floor(params.beforeSeq)),
    },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }

  const raw = (response.data as any)?.messages;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw[0] as RawTranscriptRow;
}

function resolveOpenCodeForkMessageIdFromHappyRow(params: {
  credentials: Credentials;
  parentRawSession: Readonly<{ encryptionMode?: unknown; dataEncryptionKey?: unknown; metadata?: unknown }>;
  row: RawTranscriptRow;
}): string | null {
  const seq = typeof params.row.seq === 'number' && Number.isFinite(params.row.seq) ? Math.trunc(params.row.seq) : null;
  if (seq === null) return null;

  const localIdRaw = normalizeString(params.row.localId);
  let localId = localIdRaw.trim().length > 0 ? localIdRaw.trim() : null;

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.parentRawSession);
  const decrypted = decryptTranscriptRows({ ctx, rows: [params.row] })[0] ?? null;
  if (!decrypted) return null;

  if (decrypted.role === 'user') {
    if (!localId) {
      const meta = asRecord(decrypted.meta);
      const metaLocalId = meta ? normalizeString(meta.localId).trim() : '';
      if (metaLocalId) localId = metaLocalId;
    }
    if (!localId) {
      const contentRec = asRecord(decrypted.content);
      const contentLocalId = contentRec ? normalizeString(contentRec.localId).trim() : '';
      if (contentLocalId) localId = contentLocalId;
      const nestedMeta = contentRec ? asRecord(contentRec.meta) : null;
      const nestedLocalId = nestedMeta ? normalizeString(nestedMeta.localId).trim() : '';
      if (nestedLocalId) localId = nestedLocalId;
    }
    const parentMetadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.parentRawSession as any });
    const mapped = localId ? resolveOpenCodeUserMessageIdFromMetadata(parentMetadata, localId) : null;
    if (mapped) return mapped;
    return deriveLegacyOpenCodeMessageIdFromLocalId(localId);
  }

  const meta = asRecord(decrypted.meta);
  const opencodeMessageId = meta ? normalizeString(meta.opencodeMessageId).trim() : '';
  if (opencodeMessageId) return opencodeMessageId;

  // Back-compat: some agent messages may nest per-message metadata inside the content payload.
  const contentRec = asRecord(decrypted.content);
  const nestedMeta = contentRec ? asRecord(contentRec.meta) : null;
  const nested = nestedMeta ? normalizeString(nestedMeta.opencodeMessageId).trim() : '';
  return nested || null;
}

export type OpenCodeNativeForkDeps = Readonly<{
  createClient?: typeof createOpenCodeServerRuntimeClient;
  fetchSingleHappyRow?: typeof fetchSingleHappyTranscriptRow;
}>;

export async function forkOpenCodeSessionNative(params: {
  credentials: Credentials;
  parentHappySessionId: string;
  parentRawSession: Readonly<{ encryptionMode?: unknown; dataEncryptionKey?: unknown; metadata?: unknown }>;
  directory: string;
  parentOpenCodeSessionId: string;
  forkPoint: { type: 'latest' } | { type: 'seq'; upToSeqInclusive: number };
}, deps: OpenCodeNativeForkDeps = {}): Promise<{ vendorSessionId: string; vendorMessageId?: string } | null> {
  const createClient = deps.createClient ?? createOpenCodeServerRuntimeClient;
  const fetchRow = deps.fetchSingleHappyRow ?? fetchSingleHappyTranscriptRow;

  const parentOpenCodeSessionId = params.parentOpenCodeSessionId.trim();
  if (!parentOpenCodeSessionId) return null;

  let vendorMessageId: string | undefined;
  if (params.forkPoint.type === 'seq') {
    const cutoff = Math.max(0, Math.floor(params.forkPoint.upToSeqInclusive));
    const beforeSeq = cutoff + 1;
    if (beforeSeq <= 0) return null;

    const row = await fetchRow({
      token: params.credentials.token,
      sessionId: params.parentHappySessionId,
      beforeSeq,
    }).catch(() => null);
    if (!row) return null;

    const resolved = resolveOpenCodeForkMessageIdFromHappyRow({
      credentials: params.credentials,
      parentRawSession: params.parentRawSession,
      row,
    });
    if (!resolved) return null;
    vendorMessageId = resolved;
  }

  let client: OpenCodeServerRuntimeClient | null = null;
  try {
    client = await createClient({ directory: params.directory, messageBuffer: new MessageBuffer() });

    // OpenCode server fork semantics are exclusive: it clones messages strictly before `messageID`.
    // To fork "at" a given message (inclusive), we must pass the *next* vendor message id as the cursor.
    let forkCursorMessageId: string | undefined;
    if (vendorMessageId) {
      const raw = await client.sessionMessagesList({ sessionId: parentOpenCodeSessionId }).catch(() => ([] as unknown[]));
      const items = Array.isArray(raw) ? raw : [];
      const ids: string[] = [];
      for (const row of items) {
        const id = extractOpenCodeSessionMessageId(row);
        if (id) ids.push(id);
      }
      const idx = ids.indexOf(vendorMessageId);
      if (idx < 0) return null;
      forkCursorMessageId = idx >= ids.length - 1 ? undefined : ids[idx + 1];
    }

    const forked = await client.sessionFork({
      sessionId: parentOpenCodeSessionId,
      ...(forkCursorMessageId ? { messageId: forkCursorMessageId } : {}),
    });
    const vendorSessionId = typeof forked?.id === 'string' ? forked.id.trim() : '';
    if (!vendorSessionId) return null;
    return { vendorSessionId, ...(forkCursorMessageId ? { vendorMessageId: forkCursorMessageId } : {}) };
  } finally {
    await client?.dispose().catch(() => {});
  }
}
