import { normalizeRawMessage } from '../raw/index.js';
import { readUnsupportedContentMeta } from './unsupportedContentMeta.js';
import { MESSAGE_ACTION_VISIBLE_TEXT_MAX_UTF8_BYTES, MessageActionDurableResolutionV1Schema, MessageActionReferenceV1Schema, projectMessageActionProvenanceCategoryV1 } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import { SessionMessageRoleSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { readSessionMessageProvenanceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { MessageActionDurableResolutionV1, MessageActionReferenceV1, MessageActionResolutionV1 } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import type { SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';

const textEncoder = new TextEncoder();

export type CurrentMessageActionReferenceRowV1 = Readonly<{
  sessionId: string;
  messageId: string;
  observedRevision: string;
  seq: number;
  messageRole: SessionMessageRole | null;
  /** Already decrypted by the Account/Session content owner. */
  decryptedContent: unknown;
}>;

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

function resolveTextSnapshot(params: Readonly<{
  reference: MessageActionReferenceV1;
  currentMessage: CurrentMessageActionReferenceRowV1;
  role: 'user' | 'agent';
}>): MessageActionResolutionV1 {
  const decrypted = readRecord(params.currentMessage.decryptedContent);
  const content = readRecord(decrypted?.content);
  if (decrypted?.role !== params.role) return ineligible();

  // Plain text already is a disclosure. Native envelopes use the transcript's
  // normalizer so ACP/output text is identical to the text rendered and copied,
  // without disclosing tool payloads or unsupported-content placeholders.
  const normalized = content?.type === 'text' ? null : normalizeRawMessage(
    params.currentMessage.messageId, null, 0, params.currentMessage.decryptedContent,
    { seq: params.currentMessage.seq, messageRole: params.role },
  );
  const visibleText = content?.type === 'text' && typeof content.text === 'string'
    ? content.text
    : normalized?.role === params.role && !readUnsupportedContentMeta(normalized.meta) && !normalized.structuredPresentation
      ? normalized.role === 'user' ? normalized.content.text
        : normalized.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
      : null;
  if (
    visibleText === null
    || (content?.type !== 'text' && visibleText.length === 0)
    || textEncoder.encode(visibleText).byteLength > MESSAGE_ACTION_VISIBLE_TEXT_MAX_UTF8_BYTES
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
      visibleText,
      structuredPresentationSummary: null,
      provenanceCategory: projectMessageActionProvenanceCategoryV1(
        readSessionMessageProvenanceV1(decrypted?.meta, 'stored'),
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

