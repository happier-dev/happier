import axios from 'axios';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

import {
  createAuthenticationHttpStatusError,
  isAuthenticationStatus,
  readAuthenticationStatus,
} from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { Credentials } from '@/persistence';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  resolveSessionEncryptionContextFromCredentials,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { decryptTranscriptRows } from '@/session/replay/decryptTranscriptRows';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';

import { createOpenCodeServerRuntimeClient, type OpenCodeServerRuntimeClient } from './client';
import { extractOpenCodeTextHistoryItems } from './openCodeSessionMessageImport';
import { resolveOpenCodeUserMessageIdFromMetadata } from './openCodeUserMessageIds';
import { asRecord, normalizeString } from './openCodeParsing';
import { ProviderNativeForkFailedBeforeDispatchError } from '@/backends/forking/providerNativeForkHandler';
import { withSharedManagedOpenCodeServerAccess } from './sharedManagedServer';

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
  return readNonBlankOpaqueIdentifier(normalizeString(info.id));
}

function deriveLegacyOpenCodeMessageIdFromLocalId(localId: string | null): string | null {
  const exactLocalId = readNonBlankOpaqueIdentifier(localId);
  if (!exactLocalId) return null;
  return `msg_${exactLocalId}`;
}

function readOpenCodeHttpAuthStatus(error: unknown): 401 | 403 | null {
  const directStatus = readAuthenticationStatus(error);
  if (directStatus) return directStatus;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = /\bfailed:\s*(401|403)\b/u.exec(message);
  if (!match) return null;
  const status = Number.parseInt(match[1] ?? '', 10);
  return isAuthenticationStatus(status) ? status : null;
}

function throwIfOpenCodeHttpAuthError(error: unknown): void {
  const status = readOpenCodeHttpAuthStatus(error);
  if (!status) return;
  const message = error instanceof Error ? error.message : `Unauthorized (${status})`;
  throw createAuthenticationHttpStatusError(status, message);
}

function extractHappyUserTextFromDecrypted(value: unknown): string | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const content = asRecord((rec as any).content);
  const direct =
    content && normalizeString(content.type).trim() === 'text'
      ? normalizeString(content.text).trim()
      : '';
  if (direct) return direct;
  const nestedContent = content ? asRecord((content as any).content) : null;
  const nested =
    nestedContent && normalizeString(nestedContent.type).trim() === 'text'
      ? normalizeString(nestedContent.text).trim()
      : '';
  if (nested) return nested;
  const maybeText = normalizeString((rec as any).text).trim();
  return maybeText ? maybeText : null;
}

async function fetchSingleHappyTranscriptRow(params: {
  token: string;
  sessionId: string;
  beforeSeq: number;
}): Promise<RawTranscriptRow | null> {
  const serverUrl = resolveServerHttpBaseUrl();
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

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, `Unauthorized (${response.status})`);
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
}): Readonly<{ messageId: string; source: 'user' | 'agent'; userText?: string; happyCreatedAtMs?: number }> | null {
  const seq = typeof params.row.seq === 'number' && Number.isFinite(params.row.seq) ? Math.trunc(params.row.seq) : null;
  if (seq === null) return null;

  const localIdRaw = normalizeString(params.row.localId);
  let localId = readNonBlankOpaqueIdentifier(localIdRaw);

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.parentRawSession);
  const decrypted = decryptTranscriptRows({ ctx, rows: [params.row] })[0] ?? null;
  if (!decrypted) return null;

  if (decrypted.role === 'user') {
    const userText = extractHappyUserTextFromDecrypted(decrypted);
    const happyCreatedAtMs = typeof params.row.createdAt === 'number' && Number.isFinite(params.row.createdAt)
      ? Math.max(0, Math.trunc(params.row.createdAt))
      : undefined;
    if (!localId) {
      const meta = asRecord(decrypted.meta);
      const metaLocalId = meta ? readNonBlankOpaqueIdentifier(meta.localId) : null;
      if (metaLocalId) localId = metaLocalId;
    }
    if (!localId) {
      const contentRec = asRecord(decrypted.content);
      const contentLocalId = contentRec ? readNonBlankOpaqueIdentifier(contentRec.localId) : null;
      if (contentLocalId) localId = contentLocalId;
      const nestedMeta = contentRec ? asRecord(contentRec.meta) : null;
      const nestedLocalId = nestedMeta ? readNonBlankOpaqueIdentifier(nestedMeta.localId) : null;
      if (nestedLocalId) localId = nestedLocalId;
    }
    const parentMetadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.parentRawSession as any });
    const mapped = localId ? resolveOpenCodeUserMessageIdFromMetadata(parentMetadata, localId) : null;
    if (mapped) {
      return {
        messageId: mapped,
        source: 'user',
        ...(userText ? { userText } : {}),
        ...(typeof happyCreatedAtMs === 'number' ? { happyCreatedAtMs } : {}),
      };
    }
    const legacy = deriveLegacyOpenCodeMessageIdFromLocalId(localId);
    return legacy
      ? {
        messageId: legacy,
        source: 'user',
        ...(userText ? { userText } : {}),
        ...(typeof happyCreatedAtMs === 'number' ? { happyCreatedAtMs } : {}),
      }
      : null;
  }

  const meta = asRecord(decrypted.meta);
  const opencodeMessageId = meta ? normalizeString(meta.opencodeMessageId).trim() : '';
  if (opencodeMessageId) return { messageId: opencodeMessageId, source: 'agent' };

  // Back-compat: some agent messages may nest per-message metadata inside the content payload.
  const contentRec = asRecord(decrypted.content);
  const nestedMeta = contentRec ? asRecord(contentRec.meta) : null;
  const nested = nestedMeta ? normalizeString(nestedMeta.opencodeMessageId).trim() : '';
  return nested ? { messageId: nested, source: 'agent' } : null;
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
  baseUrlOverride?: string | null;
  managedServerLaunchFingerprint?: string | null;
  forkPoint: { type: 'latest' } | { type: 'seq'; upToSeqInclusive: number };
}, deps: OpenCodeNativeForkDeps = {}): Promise<{ vendorSessionId: string; vendorMessageId?: string } | null> {
  const createClient = deps.createClient ?? createOpenCodeServerRuntimeClient;
  const fetchRow = deps.fetchSingleHappyRow ?? fetchSingleHappyTranscriptRow;

  const parentOpenCodeSessionId = params.parentOpenCodeSessionId.trim();
  if (!parentOpenCodeSessionId) return null;

  let resolved: Readonly<{ messageId: string; source: 'user' | 'agent'; userText?: string; happyCreatedAtMs?: number }> | null = null;
  if (params.forkPoint.type === 'seq') {
    const cutoff = Math.max(0, Math.floor(params.forkPoint.upToSeqInclusive));
    const beforeSeq = cutoff + 1;
    if (beforeSeq <= 0) return null;

    const row = await fetchRow({
      token: params.credentials.token,
      sessionId: params.parentHappySessionId,
      beforeSeq,
    }).catch((error) => {
      throwIfOpenCodeHttpAuthError(error);
      return null;
    });
    if (!row) return null;

    resolved = resolveOpenCodeForkMessageIdFromHappyRow({
      credentials: params.credentials,
      parentRawSession: params.parentRawSession,
      row,
    });
    if (!resolved) return null;
  }

  return await withSharedManagedOpenCodeServerAccess(async () => {
    let client: OpenCodeServerRuntimeClient | null = null;
    try {
      client = await createClient({ directory: params.directory, messageBuffer: new MessageBuffer(),
        ...(params.baseUrlOverride ? { baseUrlOverride: params.baseUrlOverride } : {}),
        managedServerLaunchFingerprint: params.managedServerLaunchFingerprint,
      }).catch((error) => {
        if (params.managedServerLaunchFingerprint != null) {
          throw new ProviderNativeForkFailedBeforeDispatchError(new Error('Managed OpenCode native fork target is unavailable.'));
        }
        throw error;
      });

      // OpenCode server fork semantics are exclusive: it clones messages strictly before `messageID`.
      //
      // Happier semantics:
      // - When forking from a user message (with at least one prior committed message), we fork *before* that message
      //   so the user can edit/resend it ("branch and edit").
      // - When the fork target is the first user message in the session, keep an inclusive cutoff (fork after it)
      //   so the forked session retains the initial prompt context.
      // - When forking from an agent message, we fork *after* that message (inclusive) to keep assistant context.
      const targetSeqInclusive =
        params.forkPoint.type === 'seq'
          ? Math.max(0, Math.floor(params.forkPoint.upToSeqInclusive))
          : null;
      const shouldBranchAndEditUserFork = typeof targetSeqInclusive === 'number' ? targetSeqInclusive >= 2 : true;

      let forkCursorMessageId: string | undefined;
      if (resolved?.source === 'user') {
        if (shouldBranchAndEditUserFork) {
          forkCursorMessageId = resolved.messageId;
        } else {
          const vendorMessageId = resolved.messageId;
          if (typeof client.sessionMessagesList !== 'function') return null;
          const raw = await client.sessionMessagesList({ sessionId: parentOpenCodeSessionId }).catch((error) => {
            throwIfOpenCodeHttpAuthError(error);
            return [] as unknown[];
          });
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
      } else if (resolved?.source === 'agent') {
        const vendorMessageId = resolved.messageId;
        const raw = await client.sessionMessagesList({ sessionId: parentOpenCodeSessionId }).catch((error) => {
          throwIfOpenCodeHttpAuthError(error);
          return [] as unknown[];
        });
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

      const attemptFork = async (messageId: string | undefined): Promise<{ vendorSessionId: string } | null> => {
        try {
          const forked = await client!.sessionFork({
            sessionId: parentOpenCodeSessionId,
            ...(messageId ? { messageId } : {}),
          });
          const vendorSessionId = typeof (forked as any)?.id === 'string' ? String((forked as any).id).trim() : '';
          return vendorSessionId ? { vendorSessionId } : null;
        } catch (error) {
          throwIfOpenCodeHttpAuthError(error);
          return null;
        }
      };

      let forked = await attemptFork(forkCursorMessageId);
      if (!forked && resolved?.source === 'user') {
        const userText = typeof resolved.userText === 'string' ? resolved.userText.trim() : '';
        const happyCreatedAtMs = typeof resolved.happyCreatedAtMs === 'number' ? resolved.happyCreatedAtMs : 0;
        if (userText && typeof client.sessionMessagesList === 'function') {
          const raw = await client.sessionMessagesList({ sessionId: parentOpenCodeSessionId }).catch((error) => {
            throwIfOpenCodeHttpAuthError(error);
            return [] as unknown[];
          });
          const allItems = Array.isArray(raw) ? raw : [];
          const items = extractOpenCodeTextHistoryItems(allItems).filter((item) => item.role === 'user');
          let bestMessageId: string | null = null;
          let bestScore = Number.POSITIVE_INFINITY;
          for (const item of items) {
            const candidateText = item.text.trim();
            if (candidateText !== userText && !candidateText.startsWith(userText)) continue;
            const score = happyCreatedAtMs > 0 ? Math.abs(item.createdAtMs - happyCreatedAtMs) : 0;
            if (score < bestScore) {
              bestScore = score;
              bestMessageId = item.messageId;
            }
          }
          if (bestMessageId) {
            let nextForkCursorMessageId: string | undefined;
            if (shouldBranchAndEditUserFork) {
              nextForkCursorMessageId = bestMessageId;
            } else {
              const ids: string[] = [];
              for (const row of allItems) {
                const id = extractOpenCodeSessionMessageId(row);
                if (id) ids.push(id);
              }
              const idx = ids.indexOf(bestMessageId);
              if (idx < 0) {
                nextForkCursorMessageId = undefined;
              } else {
                nextForkCursorMessageId = idx >= ids.length - 1 ? undefined : ids[idx + 1];
              }
            }
            if (nextForkCursorMessageId !== forkCursorMessageId) {
              forkCursorMessageId = nextForkCursorMessageId;
              forked = await attemptFork(forkCursorMessageId);
            }
          }
        }
      }

      const vendorSessionId = forked?.vendorSessionId ? forked.vendorSessionId.trim() : '';
      if (!vendorSessionId) return null;
      return { vendorSessionId, ...(forkCursorMessageId ? { vendorMessageId: forkCursorMessageId } : {}) };
    } finally {
      await client?.dispose().catch(() => {});
    }
  }, params.baseUrlOverride ?? process.env.HAPPIER_OPENCODE_SERVER_URL, params.managedServerLaunchFingerprint);
}
