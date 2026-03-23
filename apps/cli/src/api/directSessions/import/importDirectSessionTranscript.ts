import { createHash } from 'node:crypto';

import type { SessionStoredMessageContent } from '@happier-dev/protocol';

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
}>): Promise<Readonly<{ importedCount: number }>> {
  const items = await loadAllDirectTranscriptItems({ linked: params.linked });
  let importedCount = 0;

  for (const item of items) {
    const content = buildStoredMessageContent({
      rawSession: params.linked.rawSession,
      credentials: params.credentials,
      raw: item.raw,
    });

    await commitSessionStoredMessage({
      token: params.credentials.token,
      sessionId: params.sessionId,
      content,
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
