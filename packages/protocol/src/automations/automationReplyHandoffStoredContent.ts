import { z } from 'zod';

import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import type { AutomationEventReplyContextV1 } from './automationEventJsonBoundsV1.js';
import {
  AutomationConversationReplyContextStoredPayloadV1Schema,
  AutomationConversationReplyContextStoredV1Schema,
  AutomationReplyHandoffReceiptPayloadV1Schema,
  AutomationReplyHandoffReceiptStoredV1Schema,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
  AutomationRunResultStoredPayloadV1Schema,
  AutomationRunResultStoredV1Schema,
  validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
  type AutomationReplyHandoffCorrespondenceV1,
  type AutomationReplyHandoffStoredContentOpenFailureV1,
  type AutomationResultDeliverySourceV1,
  type AutomationResultDeliveryResultV1,
  type AutomationRunResultCorrespondenceV1,
  type AutomationRunResultV1,
} from './automationEventV1.js';

type AutomationReplyHandoffStoredEnvelopeSealModeV1 =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{
      mode: 'e2ee';
      material: AccountScopedCryptoMaterial;
      randomBytes: (length: number) => Uint8Array;
    }>;

type AutomationReplyHandoffStoredContentOpenResultV1<TPayload> =
  | Readonly<{ kind: 'available'; payload: TPayload }>
  | AutomationReplyHandoffStoredContentOpenFailureV1;

const utf8Encoder = new TextEncoder();

/**
 * Parses the serialized Run result envelope from its persistence boundary.
 * The same bounded, strict outer envelope is then used by all consumers.
 */
export function parseAutomationRunResultStoredEnvelopeV1(serialized: unknown) {
  if (
    typeof serialized !== 'string'
    || utf8Encoder.encode(serialized).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES
  ) {
    return null;
  }
  try {
    const parsed = AutomationRunResultStoredV1Schema.safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function openAutomationReplyHandoffStoredEnvelopeV1<TPayload>(params: Readonly<{
  mode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial;
  envelope: unknown;
  kind: 'automation_run_result' | 'automation_conversation_reply_context' | 'automation_reply_handoff_receipt';
  payloadSchema: z.ZodType<TPayload>;
}>): AutomationReplyHandoffStoredContentOpenResultV1<TPayload> {
  const outer = validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
    content: params.kind === 'automation_run_result'
      ? 'result'
      : params.kind === 'automation_conversation_reply_context'
        ? 'replyContext'
        : 'receipt',
    mode: params.mode,
    envelope: params.envelope,
  });
  if (outer.kind !== 'available') return outer;
  const envelope = outer.envelope;

  let rawPayload: unknown;
  if (envelope.t === 'plain') {
    rawPayload = envelope.v;
  } else {
    if (!params.material) return { kind: 'materialUnavailable' };
    const opened = openAccountScopedBlobCiphertext({
      kind: params.kind,
      material: params.material,
      ciphertext: envelope.c,
    });
    if (!opened) return { kind: 'contentInvalid' };
    rawPayload = opened.value;
  }
  const payload = params.payloadSchema.safeParse(rawPayload);
  return payload.success
    ? { kind: 'available', payload: payload.data }
    : { kind: 'contentInvalid' };
}

export function sealAutomationRunResultStoredEnvelopeV1(params: Readonly<{
  correspondence: AutomationRunResultCorrespondenceV1;
  result: AutomationRunResultV1;
}> & AutomationReplyHandoffStoredEnvelopeSealModeV1) {
  const payload = AutomationRunResultStoredPayloadV1Schema.parse({
    v: 1,
    correspondence: params.correspondence,
    result: params.result,
  });
  if (params.mode === 'plain') {
    return AutomationRunResultStoredV1Schema.parse({ t: 'plain', v: payload });
  }
  return AutomationRunResultStoredV1Schema.parse({
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: 'automation_run_result',
      material: params.material,
      payload,
      randomBytes: params.randomBytes,
    }),
  });
}

export function openAutomationRunResultStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial;
  envelope: unknown;
}>): (
  | Readonly<{
      kind: 'available';
      correspondence: AutomationRunResultCorrespondenceV1;
      result: AutomationRunResultV1;
    }>
  | AutomationReplyHandoffStoredContentOpenFailureV1
) {
  const opened = openAutomationReplyHandoffStoredEnvelopeV1({
    ...params,
    kind: 'automation_run_result',
    payloadSchema: AutomationRunResultStoredPayloadV1Schema,
  });
  if (opened.kind !== 'available') return opened;
  return {
    kind: 'available',
    correspondence: opened.payload.correspondence,
    result: opened.payload.result,
  };
}

export function sealAutomationConversationReplyContextStoredEnvelopeV1(params: Readonly<{
  correspondence: AutomationReplyHandoffCorrespondenceV1;
  source: AutomationResultDeliverySourceV1;
  opaqueContext: AutomationEventReplyContextV1;
}> & AutomationReplyHandoffStoredEnvelopeSealModeV1) {
  const payload = AutomationConversationReplyContextStoredPayloadV1Schema.parse({
    v: 1,
    correspondence: params.correspondence,
    source: params.source,
    opaqueContext: params.opaqueContext,
  });
  if (params.mode === 'plain') {
    return AutomationConversationReplyContextStoredV1Schema.parse({ t: 'plain', v: payload });
  }
  return AutomationConversationReplyContextStoredV1Schema.parse({
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: 'automation_conversation_reply_context',
      material: params.material,
      payload,
      randomBytes: params.randomBytes,
    }),
  });
}

export function openAutomationConversationReplyContextStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial;
  envelope: unknown;
}>): (
  | Readonly<{
      kind: 'available';
      correspondence: AutomationReplyHandoffCorrespondenceV1;
      source: AutomationResultDeliverySourceV1;
      opaqueContext: AutomationEventReplyContextV1;
    }>
  | AutomationReplyHandoffStoredContentOpenFailureV1
) {
  const opened = openAutomationReplyHandoffStoredEnvelopeV1({
    ...params,
    kind: 'automation_conversation_reply_context',
    payloadSchema: AutomationConversationReplyContextStoredPayloadV1Schema,
  });
  if (opened.kind !== 'available') return opened;
  return {
    kind: 'available',
    correspondence: opened.payload.correspondence,
    source: opened.payload.source,
    opaqueContext: opened.payload.opaqueContext,
  };
}

export function sealAutomationReplyHandoffReceiptStoredEnvelopeV1(params: Readonly<{
  correspondence: AutomationReplyHandoffCorrespondenceV1;
  result: AutomationResultDeliveryResultV1;
}> & AutomationReplyHandoffStoredEnvelopeSealModeV1) {
  const payload = AutomationReplyHandoffReceiptPayloadV1Schema.parse({
    v: 1,
    correspondence: params.correspondence,
    result: params.result,
  });
  if (params.mode === 'plain') {
    return AutomationReplyHandoffReceiptStoredV1Schema.parse({ t: 'plain', v: payload });
  }
  return AutomationReplyHandoffReceiptStoredV1Schema.parse({
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: 'automation_reply_handoff_receipt',
      material: params.material,
      payload,
      randomBytes: params.randomBytes,
    }),
  });
}

export function openAutomationReplyHandoffReceiptStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial;
  envelope: unknown;
}>): (
  | Readonly<{
      kind: 'available';
      correspondence: AutomationReplyHandoffCorrespondenceV1;
      result: AutomationResultDeliveryResultV1;
    }>
  | AutomationReplyHandoffStoredContentOpenFailureV1
) {
  const opened = openAutomationReplyHandoffStoredEnvelopeV1({
    ...params,
    kind: 'automation_reply_handoff_receipt',
    payloadSchema: AutomationReplyHandoffReceiptPayloadV1Schema,
  });
  if (opened.kind !== 'available') return opened;
  return {
    kind: 'available',
    correspondence: opened.payload.correspondence,
    result: opened.payload.result,
  };
}
