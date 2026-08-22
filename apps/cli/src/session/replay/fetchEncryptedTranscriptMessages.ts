import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SessionMessageContentSchema } from '@/api/types';
import {
  ExternalShareableActorV1Schema,
  ExternalShareableTranscriptSnapshotV1Schema,
  isExternalShareableTranscriptWirePayloadWithinLimitV1,
  type ExternalShareableTranscriptSnapshotV1,
} from '@happier-dev/protocol';
import {
  createSessionTranscriptStoredContentUnavailableError,
  throwIfSessionTranscriptStoredContentUnavailableResponse,
} from '@/api/session/sessionTranscriptStoredContentUnavailable';

export type RawTranscriptRow = Readonly<{
  id?: unknown;
  seq?: unknown;
  localId?: unknown;
  createdAt?: unknown;
  content?: unknown;
  messageRole?: unknown;
  sidechainId?: unknown;
  externalShareableActor?: unknown;
}>;

export type FetchEncryptedTranscriptMessagesPageResult = Readonly<{
  messages: readonly RawTranscriptRow[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
  nextAfterSeq: number | null;
  publicationBlocked?: boolean;
  externalShareableSnapshot?: ExternalShareableTranscriptSnapshotV1;
}>;

function parseAuthoritativeTranscriptMessages(raw: unknown, projection?: 'externalShareableV1'): RawTranscriptRow[] {
  if (!Array.isArray(raw)) throw createSessionTranscriptStoredContentUnavailableError();

  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw createSessionTranscriptStoredContentUnavailableError();
    }
    const row = entry as Record<string, unknown>;
    if (!(typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq >= 0)) {
      throw createSessionTranscriptStoredContentUnavailableError();
    }
    if (projection === 'externalShareableV1') {
      const {
        inputAdmissionReceipt: _inputAdmissionReceipt,
        externalShareableActor: rawExternalShareableActor,
        content: _rawContent,
        ...externalShareableRow
      } = row;
      const content = SessionMessageContentSchema.safeParse(row.content);
      const externalShareableActor = ExternalShareableActorV1Schema.safeParse(rawExternalShareableActor);
      return {
        ...externalShareableRow,
        ...(content.success ? { content: content.data } : {}),
        ...(externalShareableActor.success
          ? { externalShareableActor: externalShareableActor.data }
          : {}),
      };
    }
    const content = SessionMessageContentSchema.safeParse(row.content);
    if (!content.success) throw createSessionTranscriptStoredContentUnavailableError();
    return { ...row, content: content.data };
  });
}

function parseOptionalTranscriptCursor(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
    throw createSessionTranscriptStoredContentUnavailableError();
  }
  return value;
}

export async function fetchEncryptedTranscriptMessagesPage(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  beforeSeq?: number;
  afterSeq?: number;
  scope?: 'main' | 'sidechain' | 'all';
  sidechainId?: string | null;
  role?: 'user' | 'agent' | 'event' | 'unknown';
  roles?: readonly ('user' | 'agent' | 'event' | 'unknown')[];
  projection?: 'externalShareableV1';
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>): Promise<FetchEncryptedTranscriptMessagesPageResult> {
  const serverUrl = resolveServerHttpBaseUrl();
  const remainingMs = params.deadlineAtMs === undefined
    ? null
    : Math.floor(params.deadlineAtMs - Date.now());
  if (params.signal?.aborted || (remainingMs !== null && remainingMs <= 0)) {
    const error = new Error('Transcript page read was cancelled');
    error.name = 'AbortError';
    throw error;
  }
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: {
      limit: params.limit,
      ...(typeof params.beforeSeq === 'number' && Number.isFinite(params.beforeSeq) ? { beforeSeq: Math.max(0, Math.floor(params.beforeSeq)) } : {}),
      ...(typeof params.afterSeq === 'number' && Number.isFinite(params.afterSeq) ? { afterSeq: Math.max(0, Math.floor(params.afterSeq)) } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
      ...(params.role ? { role: params.role } : {}),
      ...(params.roles && params.roles.length > 0 ? { roles: params.roles.join(',') } : {}),
      ...(params.projection ? { projection: params.projection } : {}),
    },
    timeout: remainingMs === null ? 10_000 : Math.min(10_000, remainingMs),
    ...(params.signal ? { signal: params.signal } : {}),
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, 'Authentication failed while fetching transcript messages');
  }
  throwIfSessionTranscriptStoredContentUnavailableResponse(response.status, response.data);
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }
  if (
    params.projection === 'externalShareableV1'
    && !isExternalShareableTranscriptWirePayloadWithinLimitV1(response.data)
  ) {
    throw createSessionTranscriptStoredContentUnavailableError();
  }

  const raw = (response.data as any)?.messages;
  const messages = parseAuthoritativeTranscriptMessages(raw, params.projection);
  const hasMore = (response.data as any)?.hasMore === true;
  const nextBeforeSeqRaw = (response.data as any)?.nextBeforeSeq;
  const nextAfterSeqRaw = (response.data as any)?.nextAfterSeq;
  const nextBeforeSeq = parseOptionalTranscriptCursor(nextBeforeSeqRaw);
  const nextAfterSeq = parseOptionalTranscriptCursor(nextAfterSeqRaw);
  const rawExternalShareableSnapshot = (response.data as any)?.externalShareableSnapshot;
  const externalShareableSnapshot = params.projection === 'externalShareableV1'
    && rawExternalShareableSnapshot !== undefined
    ? ExternalShareableTranscriptSnapshotV1Schema.parse(rawExternalShareableSnapshot)
    : undefined;

  return {
    messages,
    hasMore,
    nextBeforeSeq,
    nextAfterSeq,
    ...(params.projection === 'externalShareableV1'
      ? {
          publicationBlocked: (response.data as any)?.publicationBlocked === true,
          ...(externalShareableSnapshot ? { externalShareableSnapshot } : {}),
        }
      : {}),
  };
}

export async function fetchEncryptedTranscriptMessages(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  beforeSeq?: number;
  scope?: 'main' | 'sidechain' | 'all';
  sidechainId?: string | null;
  role?: 'user' | 'agent' | 'event' | 'unknown';
  roles?: readonly ('user' | 'agent' | 'event' | 'unknown')[];
}>): Promise<RawTranscriptRow[]> {
  return (await fetchEncryptedTranscriptMessagesPage(params)).messages as RawTranscriptRow[];
}
