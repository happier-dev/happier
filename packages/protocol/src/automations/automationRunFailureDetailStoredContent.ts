import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import {
  getAccountScopedBlobCiphertextBase64LengthV1,
  isAccountScopedBlobCiphertextForKind,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import { MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } from './automationEventV1.js';
import {
  AutomationHostIdentifierV1Schema,
  AutomationIdV1Schema,
} from './automationIdV1.js';

const utf8Encoder = new TextEncoder();

export const AUTOMATION_RUN_FAILURE_DETAIL_ACCOUNT_SCOPED_BLOB_KIND_V1 =
  'automation_run_failure_detail' as const;

/** Structural error codes remain public; this bounded string is Run-private. */
export const MAX_AUTOMATION_RUN_FAILURE_DETAIL_CODE_UNITS_V1 = 4_000;

export const AutomationRunFailureDetailCorrespondenceV1Schema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  runId: asProtocolZod(AutomationHostIdentifierV1Schema),
}).strict();
export type AutomationRunFailureDetailCorrespondenceV1 = z.infer<
  typeof AutomationRunFailureDetailCorrespondenceV1Schema
>;

export const AutomationRunFailureDetailStoredPayloadV1Schema = z.object({
  v: z.literal(1),
  correspondence: AutomationRunFailureDetailCorrespondenceV1Schema,
  detail: z.string().min(1).max(MAX_AUTOMATION_RUN_FAILURE_DETAIL_CODE_UNITS_V1),
}).strict();
export type AutomationRunFailureDetailStoredPayloadV1 = z.infer<
  typeof AutomationRunFailureDetailStoredPayloadV1Schema
>;

export const AUTOMATION_RUN_FAILURE_DETAIL_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES_V1 =
  getAccountScopedBlobCiphertextBase64LengthV1(
    MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
  );

/**
 * One private, Account-mode-correct Run terminal-detail carrier. The server
 * validates only this strict outer shape and purpose; a device with Account
 * material alone opens its detail and verifies its Run correspondence.
 */
export const AutomationRunFailureDetailStoredEnvelopeV1Schema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: AutomationRunFailureDetailStoredPayloadV1Schema,
  }).strict(),
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1),
  }).strict(),
]).superRefine((value, context) => {
  if (value.t === 'encrypted') {
    if (
      utf8Encoder.encode(value.c).byteLength
      > AUTOMATION_RUN_FAILURE_DETAIL_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES_V1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['c'],
        message: 'Automation Run failure-detail ciphertext exceeds the maximum stored size',
      });
    }
    return;
  }

  try {
    const serialized = JSON.stringify(value);
    if (utf8Encoder.encode(serialized).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['v'],
        message: 'Automation Run failure detail exceeds the maximum stored size',
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['v'],
      message: 'Automation Run failure detail is not serializable',
    });
  }
});
export type AutomationRunFailureDetailStoredEnvelopeV1 = z.infer<
  typeof AutomationRunFailureDetailStoredEnvelopeV1Schema
>;

export type AutomationRunFailureDetailStoredContentOpenFailureV1 =
  | Readonly<{ kind: 'materialUnavailable' }>
  | Readonly<{ kind: 'contentInvalid' }>
  | Readonly<{ kind: 'modeMismatch' }>;

export type AutomationRunFailureDetailStoredContentOuterValidationV1 =
  | Readonly<{
      kind: 'available';
      envelope: AutomationRunFailureDetailStoredEnvelopeV1;
    }>
  | Exclude<
      AutomationRunFailureDetailStoredContentOpenFailureV1,
      Readonly<{ kind: 'materialUnavailable' }>
    >;

export type AutomationRunFailureDetailStoredContentOpenResultV1 =
  | Readonly<{
      kind: 'available';
      correspondence: AutomationRunFailureDetailCorrespondenceV1;
      detail: string;
    }>
  | AutomationRunFailureDetailStoredContentOpenFailureV1;

type AutomationRunFailureDetailStoredEnvelopeSealModeV1 =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{
      mode: 'e2ee';
      material: AccountScopedCryptoMaterial;
      randomBytes: (length: number) => Uint8Array;
    }>;

export function isAutomationRunFailureDetailCiphertextV1(ciphertext: string): boolean {
  return isAccountScopedBlobCiphertextForKind({
    kind: AUTOMATION_RUN_FAILURE_DETAIL_ACCOUNT_SCOPED_BLOB_KIND_V1,
    ciphertext,
  });
}

/** Server-safe outer admission: no Account content is opened here. */
export function validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1(
  params: Readonly<{
    mode: 'plain' | 'e2ee';
    envelope: unknown;
  }>,
): AutomationRunFailureDetailStoredContentOuterValidationV1 {
  const envelope = AutomationRunFailureDetailStoredEnvelopeV1Schema.safeParse(params.envelope);
  if (!envelope.success) return { kind: 'contentInvalid' };
  if (
    (params.mode === 'plain' && envelope.data.t !== 'plain')
    || (params.mode === 'e2ee' && envelope.data.t !== 'encrypted')
  ) {
    return { kind: 'modeMismatch' };
  }
  if (
    envelope.data.t === 'encrypted'
    && !isAutomationRunFailureDetailCiphertextV1(envelope.data.c)
  ) {
    return { kind: 'contentInvalid' };
  }
  return { kind: 'available', envelope: envelope.data };
}

/** The worker-side owner that seals one Run-bound failure detail before settlement. */
export function sealAutomationRunFailureDetailStoredEnvelopeV1(params: Readonly<{
  correspondence: AutomationRunFailureDetailCorrespondenceV1;
  detail: string;
}> & AutomationRunFailureDetailStoredEnvelopeSealModeV1): AutomationRunFailureDetailStoredEnvelopeV1 {
  const payload = AutomationRunFailureDetailStoredPayloadV1Schema.parse({
    v: 1,
    correspondence: params.correspondence,
    detail: params.detail,
  });
  if (params.mode === 'plain') {
    return AutomationRunFailureDetailStoredEnvelopeV1Schema.parse({ t: 'plain', v: payload });
  }
  return AutomationRunFailureDetailStoredEnvelopeV1Schema.parse({
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: AUTOMATION_RUN_FAILURE_DETAIL_ACCOUNT_SCOPED_BLOB_KIND_V1,
      material: params.material,
      payload,
      randomBytes: params.randomBytes,
    }),
  });
}

/** Device-only reader; it verifies mode and ciphertext purpose before opening. */
export function openAutomationRunFailureDetailStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee';
  envelope: unknown;
  material?: AccountScopedCryptoMaterial;
}>): AutomationRunFailureDetailStoredContentOpenResultV1 {
  const outer = validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1(params);
  if (outer.kind !== 'available') return outer;

  let rawPayload: unknown;
  if (outer.envelope.t === 'plain') {
    rawPayload = outer.envelope.v;
  } else {
    if (!params.material) return { kind: 'materialUnavailable' };
    const opened = openAccountScopedBlobCiphertext({
      kind: AUTOMATION_RUN_FAILURE_DETAIL_ACCOUNT_SCOPED_BLOB_KIND_V1,
      material: params.material,
      ciphertext: outer.envelope.c,
    });
    if (!opened) return { kind: 'contentInvalid' };
    rawPayload = opened.value;
  }

  const payload = AutomationRunFailureDetailStoredPayloadV1Schema.safeParse(rawPayload);
  return payload.success
    ? {
        kind: 'available',
        correspondence: payload.data.correspondence,
        detail: payload.data.detail,
      }
    : { kind: 'contentInvalid' };
}

/** Parses one stored string before mode/purpose validation at a reader boundary. */
export function parseAutomationRunFailureDetailStoredEnvelopeV1(
  serialized: unknown,
): AutomationRunFailureDetailStoredEnvelopeV1 | null {
  if (
    typeof serialized !== 'string'
    || utf8Encoder.encode(serialized).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES
  ) {
    return null;
  }
  try {
    const parsed = AutomationRunFailureDetailStoredEnvelopeV1Schema.safeParse(
      JSON.parse(serialized),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
