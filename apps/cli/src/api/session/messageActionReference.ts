import axios from 'axios';

import {
  MESSAGE_ACTION_VISIBLE_TEXT_MAX_UTF8_BYTES,
  MessageActionDurableResolutionV1Schema,
  MessageActionReferenceV1Schema,
  SessionMessageRoleSchema,
  SessionStoredMessageContentSchema,
  projectMessageActionProvenanceCategoryV1,
  readSessionMessageProvenanceV1,
  type MessageActionDurableResolutionV1,
  type MessageActionReferenceV1,
  type MessageActionResolutionV1,
  type SessionMessageRole,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { decryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

const textEncoder = new TextEncoder();
const DEFAULT_MESSAGE_ACTION_REFERENCE_RESOLVE_TIMEOUT_MS = 10_000;

export type CurrentMessageActionReferenceRowV1 = Readonly<{
  sessionId: string;
  messageId: string;
  observedRevision: string;
  seq: number;
  messageRole: SessionMessageRole | null;
  /** Already decrypted by the Account/Session content owner. */
  decryptedContent: unknown;
}>;

export type ReadCurrentMessageActionReferenceRowV1 = (params: Readonly<{
  reference: MessageActionReferenceV1;
  durableMessage: Extract<MessageActionDurableResolutionV1, { status: 'available' }>['message'];
  signal?: AbortSignal;
}>) => Promise<CurrentMessageActionReferenceRowV1 | null>;

function unavailable(): MessageActionResolutionV1 {
  return { status: 'unavailable' };
}

function ineligible(): MessageActionResolutionV1 {
  return { status: 'ineligible' };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Message Action reference resolution was cancelled');
}

function resolveTextSnapshot(params: Readonly<{
  reference: MessageActionReferenceV1;
  currentMessage: CurrentMessageActionReferenceRowV1;
  role: 'user' | 'agent';
}>): MessageActionResolutionV1 {
  const decrypted = readRecord(params.currentMessage.decryptedContent);
  const content = readRecord(decrypted?.content);
  if (
    decrypted?.role !== params.role
    || content?.type !== 'text'
    || typeof content.text !== 'string'
    || textEncoder.encode(content.text).byteLength > MESSAGE_ACTION_VISIBLE_TEXT_MAX_UTF8_BYTES
  ) {
    return ineligible();
  }

  return {
    status: 'available',
    snapshot: {
      sessionId: params.reference.sessionId,
      messageId: params.reference.messageId,
      observedRevision: params.reference.observedRevision,
      role: params.role,
      contentCategory: 'text',
      seq: params.currentMessage.seq,
      visibleText: content.text,
      structuredPresentationSummary: null,
      provenanceCategory: projectMessageActionProvenanceCategoryV1(
        readSessionMessageProvenanceV1(decrypted?.meta),
      ),
    },
  };
}

/**
 * Produces the sole ephemeral SDK-facing disclosure from a server-authorized
 * durable reference and one freshly read/decrypted row. It has no cache and
 * receives no Action policy or invocation authority.
 */
export function resolveMessageActionSnapshotFromCurrentMessageV1(params: Readonly<{
  reference: MessageActionReferenceV1;
  durableResolution: MessageActionDurableResolutionV1;
  currentMessage: CurrentMessageActionReferenceRowV1;
}>): MessageActionResolutionV1 {
  const reference = MessageActionReferenceV1Schema.safeParse(params.reference);
  const durableResolution = MessageActionDurableResolutionV1Schema.safeParse(params.durableResolution);
  if (!reference.success || !durableResolution.success) return unavailable();
  if (durableResolution.data.status !== 'available') {
    return durableResolution.data;
  }

  const durableMessage = durableResolution.data.message;
  if (
    durableMessage.sessionId !== reference.data.sessionId
    || durableMessage.messageId !== reference.data.messageId
    || durableMessage.observedRevision !== reference.data.observedRevision
  ) {
    return unavailable();
  }
  if (
    params.currentMessage.sessionId !== reference.data.sessionId
    || params.currentMessage.messageId !== reference.data.messageId
  ) {
    return unavailable();
  }
  if (
    params.currentMessage.observedRevision !== reference.data.observedRevision
    || params.currentMessage.seq !== durableMessage.seq
  ) {
    return { status: 'stale' };
  }

  const messageRole = SessionMessageRoleSchema.safeParse(params.currentMessage.messageRole);
  if (!messageRole.success || (messageRole.data !== 'user' && messageRole.data !== 'agent')) {
    return ineligible();
  }
  if (durableMessage.messageRole !== messageRole.data) {
    return ineligible();
  }

  return resolveTextSnapshot({
    reference: reference.data,
    currentMessage: params.currentMessage,
    role: messageRole.data,
  });
}

function resolveRequestTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MESSAGE_ACTION_REFERENCE_RESOLVE_TIMEOUT_MS;
  }
  return Math.max(1, Math.trunc(value));
}

function resolveServerBaseUrl(serverUrl: string | undefined): string | null {
  const baseUrl = (serverUrl ?? resolveServerHttpBaseUrl()).trim().replace(/\/+$/, '');
  return baseUrl || null;
}

/**
 * Resolves durable access/currentness only. A successful result is not a
 * content disclosure; callers must still fetch, decrypt, and revalidate the
 * exact row through `resolveMessageActionSnapshotFromCurrentMessageV1`.
 */
export async function resolveServerMessageActionReferenceV1(params: Readonly<{
  token: string;
  reference: MessageActionReferenceV1;
  serverUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>): Promise<MessageActionDurableResolutionV1> {
  const reference = MessageActionReferenceV1Schema.safeParse(params.reference);
  const serverUrl = resolveServerBaseUrl(params.serverUrl);
  if (!reference.success || !serverUrl) return { status: 'unavailable' };

  try {
    const response = await axios.post(
      `${serverUrl}/v1/sessions/${encodeURIComponent(reference.data.sessionId)}/messages/action-reference/resolve`,
      reference.data,
      {
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
        },
        timeout: resolveRequestTimeoutMs(params.timeoutMs),
        ...(params.signal ? { signal: params.signal } : {}),
        validateStatus: () => true,
      },
    );
    if (response.status !== 200) return { status: 'unavailable' };

    const durableResolution = MessageActionDurableResolutionV1Schema.safeParse(response.data);
    if (!durableResolution.success) return { status: 'unavailable' };
    if (
      durableResolution.data.status === 'available'
      && (
        durableResolution.data.message.sessionId !== reference.data.sessionId
        || durableResolution.data.message.messageId !== reference.data.messageId
        || durableResolution.data.message.observedRevision !== reference.data.observedRevision
      )
    ) {
      return { status: 'unavailable' };
    }
    return durableResolution.data;
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return { status: 'unavailable' };
  }
}

/**
 * The live host composition point. Server authorization/currentness is read
 * first; only an available durable row permits the Account/Session content
 * owner to fetch and decrypt its exact current bytes. No result is retained.
 */
export async function resolveMessageActionReferenceSnapshotV1(params: Readonly<{
  token: string;
  reference: MessageActionReferenceV1;
  readCurrentMessage: ReadCurrentMessageActionReferenceRowV1;
  serverUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>): Promise<MessageActionResolutionV1> {
  const reference = MessageActionReferenceV1Schema.safeParse(params.reference);
  if (!reference.success) return unavailable();

  const durableResolution = await resolveServerMessageActionReferenceV1({
    token: params.token,
    reference: reference.data,
    ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (durableResolution.status !== 'available') return durableResolution;

  try {
    const currentMessage = await params.readCurrentMessage({
      reference: reference.data,
      durableMessage: durableResolution.message,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!currentMessage) return unavailable();
    return resolveMessageActionSnapshotFromCurrentMessageV1({
      reference: reference.data,
      durableResolution,
      currentMessage,
    });
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return unavailable();
  }
}

/**
 * Reads one exact current row through the established Session transport and
 * crypto owner. The caller supplies current Account credentials only; machine
 * encryption material is never accepted here. A changed page reference is
 * returned for the pure resolver to classify as stale.
 */
export async function readCurrentMessageActionReferenceRowV1(params: Readonly<{
  credentials: StoredCredentials;
  token: string;
  reference: MessageActionReferenceV1;
  durableMessage: Extract<MessageActionDurableResolutionV1, { status: 'available' }>['message'];
  signal?: AbortSignal;
}>): Promise<CurrentMessageActionReferenceRowV1 | null> {
  const reference = MessageActionReferenceV1Schema.safeParse(params.reference);
  if (!reference.success || params.credentials.token !== params.token) return null;

  try {
    throwIfAborted(params.signal);
    const sessionTransport = await resolveSessionTransportContext({
      credentials: params.credentials,
      idOrPrefix: reference.data.sessionId,
    });
    throwIfAborted(params.signal);
    if (!sessionTransport.ok || sessionTransport.sessionId !== reference.data.sessionId) return null;

    const page = await fetchEncryptedTranscriptMessagesPage({
      token: params.credentials.token,
      sessionId: reference.data.sessionId,
      ...(params.durableMessage.seq === 0
        ? { beforeSeq: 1 }
        : { afterSeq: params.durableMessage.seq - 1 }),
      limit: 1,
      scope: 'all',
      ...(params.signal ? { signal: params.signal } : {}),
    });
    throwIfAborted(params.signal);

    const row = readRecord(page.messages[0]);
    const pageReference = MessageActionReferenceV1Schema.safeParse(row?.messageActionReference);
    const content = SessionStoredMessageContentSchema.safeParse(row?.content);
    const messageRole = SessionMessageRoleSchema.safeParse(row?.messageRole);
    if (
      !row
      || !pageReference.success
      || !content.success
      || !messageRole.success
      || row.id !== reference.data.messageId
      || row.seq !== params.durableMessage.seq
      || pageReference.data.sessionId !== reference.data.sessionId
      || pageReference.data.messageId !== reference.data.messageId
    ) {
      return null;
    }

    const decryptedContent = sessionTransport.mode === 'plain'
      ? content.data.t === 'plain'
        ? content.data.v
        : null
      : content.data.t === 'encrypted'
        ? decryptSessionPayload({
            ctx: sessionTransport.ctx,
            ciphertextBase64: content.data.c,
          })
        : null;
    if (decryptedContent === null) return null;

    return {
      sessionId: reference.data.sessionId,
      messageId: reference.data.messageId,
      observedRevision: pageReference.data.observedRevision,
      seq: params.durableMessage.seq,
      messageRole: messageRole.data,
      decryptedContent,
    };
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return null;
  }
}
