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
import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { adoptSessionMediaMetadataForManagedSession } from '@/session/media/adoption';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function resolvePageMaxBytes(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_EXTERNAL_SESSIONS_PAGE_MAX_BYTES ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 512_000;
  return Math.max(1024, Math.min(10 * 1024 * 1024, configured));
}

function resolvePageMaxItems(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_EXTERNAL_SESSIONS_PAGE_MAX_ITEMS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
  return Math.max(1, Math.min(5000, configured));
}

function makeImportLocalId(params: Readonly<{
  agentId: string;
  remoteSessionId: string;
  directItemId: string;
}>): string {
  const digest = sha256(`${params.agentId}:${params.remoteSessionId}:${params.directItemId}`).slice(0, 24);
  return `direct-import:v1:${params.agentId}:${digest}`;
}

type ExternalSessionTranscriptPage = Readonly<{
  items: ExternalSessionTranscriptRawMessageV1[];
  nextCursor: string | null;
  hasMore: boolean;
  truncated?: boolean;
}>;

async function loadExternalSessionTranscriptPage(params: Readonly<{
  linked: LoadedLinkedExternalSession;
  providerOps: Pick<ExternalSessionExecutionSurface, 'pageTranscript'> & Readonly<{
    pageTranscript: NonNullable<ExternalSessionExecutionSurface['pageTranscript']>;
  }>;
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<ExternalSessionTranscriptPage> {
  return await params.providerOps.pageTranscript({
    source: params.linked.source,
    remoteSessionId: params.linked.remoteSessionId,
    direction: 'older',
    cursor: params.cursor,
    maxBytes: params.maxBytes,
    maxItems: params.maxItems,
  });
}

async function resolveExternalSessionProviderOps(linked: LoadedLinkedExternalSession): Promise<ExternalSessionExecutionSurface> {
  const providerOps = (await getSessionHostBridge().resolveExecutionSurfaces(linked.agentId)).externalSession;
  if (!providerOps) {
    throw new Error(`Unsupported direct-session provider: ${linked.agentId}`);
  }
  return providerOps;
}

async function loadAllDirectTranscriptItems(params: Readonly<{
  linked: LoadedLinkedExternalSession;
  providerOps: Pick<ExternalSessionExecutionSurface, 'pageTranscript'> & Readonly<{
    pageTranscript: NonNullable<ExternalSessionExecutionSurface['pageTranscript']>;
  }>;
}>): Promise<ExternalSessionTranscriptRawMessageV1[]> {
  const pageMaxBytes = resolvePageMaxBytes();
  const pageMaxItems = resolvePageMaxItems();
  const pages: ExternalSessionTranscriptRawMessageV1[][] = [];
  let cursor: string | undefined = undefined;

  for (let pageIndex = 0; pageIndex < 10_000; pageIndex += 1) {
    const page = await loadExternalSessionTranscriptPage({
      linked: params.linked,
      providerOps: params.providerOps,
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

  const ordered: ExternalSessionTranscriptRawMessageV1[] = [];
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

export async function importExternalSessionTranscript(params: Readonly<{
  linked: LoadedLinkedExternalSession;
  credentials: Credentials;
  sessionId: string;
}>): Promise<Readonly<{ importedCount: number }>> {
  const providerOps = await resolveExternalSessionProviderOps(params.linked);
  if (!providerOps.pageTranscript) {
    throw new Error(`Direct-session provider '${params.linked.agentId}' does not support transcript paging`);
  }
  const [items, sourceReadRoots] = await Promise.all([
    loadAllDirectTranscriptItems({ linked: params.linked, providerOps: { pageTranscript: providerOps.pageTranscript } }),
    providerOps.resolveTranscriptMediaReadRoots?.({
      source: params.linked.source,
      remoteSessionId: params.linked.remoteSessionId,
    }) ?? [],
  ]);
  let importedCount = 0;

  for (const item of items) {
    const localId = makeImportLocalId({
      agentId: params.linked.agentId,
      remoteSessionId: params.linked.remoteSessionId,
      directItemId: item.id,
    });
    const raw = await adoptSessionMediaMetadataForManagedSession({
      raw: item.raw,
      sessionId: params.sessionId,
      messageLocalId: localId,
      workingDirectory: params.linked.sessionPath,
      sourceReadRoots,
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
      localId,
    });
    importedCount += 1;
  }

  return { importedCount };
}
