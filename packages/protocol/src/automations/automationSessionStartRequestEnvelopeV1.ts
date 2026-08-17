import { z } from 'zod';

import {
  getAccountScopedBlobCiphertextBase64LengthV1,
  isAccountScopedBlobCiphertextForKind,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import {
  PluginJsonValueV2Schema,
  type PluginJsonValueV2,
} from '../plugins/contributions/publicTypes.js';
import {
  SessionSpawnNewInputV2Schema,
  type SessionSpawnNewInputV2,
} from '../sessions/creation/sessionSpawnNewInputV2.js';
import {
  MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from './automationEventV1.js';

const textEncoder = new TextEncoder();

export const AUTOMATION_SESSION_START_REQUEST_ACCOUNT_SCOPED_BLOB_KIND_V1 =
  'automation_session_start_request' as const;

/*
 * Automation materializes a strict V2 request from a recipe-bounded spawn
 * draft, a 256 KiB rendered prompt, and `automation-run:<Run.id>`. JSON can
 * expand one source byte/code unit to six bytes (`\\u0000`), so this is the
 * smallest proven raw ceiling that contains that producer without inheriting
 * the unrelated 512 KiB stored-envelope ceiling for the new transport.
 */
const MAX_JSON_ESCAPED_UTF8_BYTES_PER_SOURCE_UNIT_V1 = 6;
const AUTOMATION_RUN_ID_MAX_CODE_UNITS_V1 = 256;
const AUTOMATION_RUN_CREATION_KEY_PREFIX_UTF8_BYTES_V1 = textEncoder.encode(
  'automation-run:',
).byteLength;
const CREATION_KEY_MEMBER_OVERHEAD_UTF8_BYTES_V1 = textEncoder.encode(
  '"creationKey":',
).byteLength + 1;
const INITIAL_MESSAGE_MEMBER_OVERHEAD_UTF8_BYTES_V1 = textEncoder.encode(
  '"initialMessage":',
).byteLength + 1;
const CREATION_KEY_JSON_STRING_MAX_UTF8_BYTES_V1 = 2
  + AUTOMATION_RUN_CREATION_KEY_PREFIX_UTF8_BYTES_V1
  + (MAX_JSON_ESCAPED_UTF8_BYTES_PER_SOURCE_UNIT_V1 * AUTOMATION_RUN_ID_MAX_CODE_UNITS_V1);
const INITIAL_MESSAGE_JSON_STRING_MAX_UTF8_BYTES_V1 = 2
  + (MAX_JSON_ESCAPED_UTF8_BYTES_PER_SOURCE_UNIT_V1
    * MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES);

export const AUTOMATION_SESSION_START_REQUEST_MAX_RAW_UTF8_BYTES_V1 =
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES
  + CREATION_KEY_MEMBER_OVERHEAD_UTF8_BYTES_V1
  + CREATION_KEY_JSON_STRING_MAX_UTF8_BYTES_V1
  + INITIAL_MESSAGE_MEMBER_OVERHEAD_UTF8_BYTES_V1
  + INITIAL_MESSAGE_JSON_STRING_MAX_UTF8_BYTES_V1;

export const AUTOMATION_SESSION_START_REQUEST_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES_V1 =
  getAccountScopedBlobCiphertextBase64LengthV1(
    AUTOMATION_SESSION_START_REQUEST_MAX_RAW_UTF8_BYTES_V1,
  );

function serializedJsonUtf8ByteLength(value: PluginJsonValueV2): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string'
      ? textEncoder.encode(serialized).byteLength
      : null;
  } catch {
    return null;
  }
}

/**
 * One bounded, mode-tagged Automation-owned carrier. Its plaintext is
 * intentionally generic JSON at outer-only readers; only the target-side open
 * path is allowed to parse the inner Session V2 request.
 */
export const AutomationSessionStartRequestEnvelopeV1Schema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: PluginJsonValueV2Schema,
  }).strict(),
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1),
  }).strict(),
]).superRefine((value, context) => {
  if (value.t === 'encrypted') {
    if (
      textEncoder.encode(value.c).byteLength
      > AUTOMATION_SESSION_START_REQUEST_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES_V1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['c'],
        message: 'Automation Session-start ciphertext exceeds the maximum request size',
      });
    }
    return;
  }

  const bytes = serializedJsonUtf8ByteLength(value.v);
  if (bytes === null || bytes > AUTOMATION_SESSION_START_REQUEST_MAX_RAW_UTF8_BYTES_V1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['v'],
      message: 'Automation Session-start plaintext exceeds the maximum request size',
    });
  }
});
export type AutomationSessionStartRequestEnvelopeV1 = z.infer<
  typeof AutomationSessionStartRequestEnvelopeV1Schema
>;

export type AutomationSessionStartRequestEnvelopeOpenFailureV1 =
  | Readonly<{ kind: 'materialUnavailable' }>
  | Readonly<{ kind: 'contentInvalid' }>
  | Readonly<{ kind: 'modeMismatch' }>;

export type AutomationSessionStartRequestEnvelopeOuterValidationV1 =
  | Readonly<{
      kind: 'available';
      envelope: AutomationSessionStartRequestEnvelopeV1;
    }>
  | Exclude<
      AutomationSessionStartRequestEnvelopeOpenFailureV1,
      Readonly<{ kind: 'materialUnavailable' }>
    >;

export type AutomationSessionStartRequestEnvelopeOpenResultV1 =
  | Readonly<{ kind: 'available'; input: SessionSpawnNewInputV2 }>
  | AutomationSessionStartRequestEnvelopeOpenFailureV1;

type AutomationSessionStartRequestEnvelopeSealModeV1 =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{
      mode: 'e2ee';
      material: AccountScopedCryptoMaterial;
      randomBytes: (length: number) => Uint8Array;
    }>;

/** Lets ciphertext-blind transport readers refuse every other Account purpose. */
export function isAutomationSessionStartRequestCiphertextV1(ciphertext: string): boolean {
  return isAccountScopedBlobCiphertextForKind({
    kind: AUTOMATION_SESSION_START_REQUEST_ACCOUNT_SCOPED_BLOB_KIND_V1,
    ciphertext,
  });
}

/**
 * Checks only the bounded outer carrier and Account encryption mode. It does
 * not open ciphertext or parse Session V2 input, so the server can safely
 * route the same envelope to the exact target daemon.
 */
export function validateAutomationSessionStartRequestEnvelopeOuterForModeV1(params: Readonly<{
  mode: 'plain' | 'e2ee';
  envelope: unknown;
}>): AutomationSessionStartRequestEnvelopeOuterValidationV1 {
  const envelope = AutomationSessionStartRequestEnvelopeV1Schema.safeParse(params.envelope);
  if (!envelope.success) return { kind: 'contentInvalid' };
  if (
    (params.mode === 'plain' && envelope.data.t !== 'plain')
    || (params.mode === 'e2ee' && envelope.data.t !== 'encrypted')
  ) {
    return { kind: 'modeMismatch' };
  }
  if (
    envelope.data.t === 'encrypted'
    && !isAutomationSessionStartRequestCiphertextV1(envelope.data.c)
  ) {
    return { kind: 'contentInvalid' };
  }
  return { kind: 'available', envelope: envelope.data };
}

/**
 * The one Automation writer for strict materialized Session V2 requests.
 * Plain and E2EE modes share their outer shape, while only E2EE consumes
 * Account material and a fresh nonce source.
 */
export function sealAutomationSessionStartRequestEnvelopeV1(params: Readonly<{
  input: SessionSpawnNewInputV2;
}> & AutomationSessionStartRequestEnvelopeSealModeV1): AutomationSessionStartRequestEnvelopeV1 {
  const input = SessionSpawnNewInputV2Schema.parse(params.input);
  if (params.mode === 'plain') {
    return AutomationSessionStartRequestEnvelopeV1Schema.parse({ t: 'plain', v: input });
  }
  return AutomationSessionStartRequestEnvelopeV1Schema.parse({
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: AUTOMATION_SESSION_START_REQUEST_ACCOUNT_SCOPED_BLOB_KIND_V1,
      material: params.material,
      payload: input,
      randomBytes: params.randomBytes,
    }),
  });
}

/**
 * The target-side only opener. It preserves the server's ciphertext-blind
 * role, verifies mode/purpose before decryption, then admits only strict
 * canonical Session V2 input to the incumbent Session create owner.
 */
export function openAutomationSessionStartRequestEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee';
  envelope: unknown;
  material?: AccountScopedCryptoMaterial;
}>): AutomationSessionStartRequestEnvelopeOpenResultV1 {
  const outer = validateAutomationSessionStartRequestEnvelopeOuterForModeV1({
    mode: params.mode,
    envelope: params.envelope,
  });
  if (outer.kind !== 'available') return outer;

  let rawInput: unknown;
  if (outer.envelope.t === 'plain') {
    rawInput = outer.envelope.v;
  } else {
    if (!params.material) return { kind: 'materialUnavailable' };
    const opened = openAccountScopedBlobCiphertext({
      kind: AUTOMATION_SESSION_START_REQUEST_ACCOUNT_SCOPED_BLOB_KIND_V1,
      material: params.material,
      ciphertext: outer.envelope.c,
    });
    if (!opened) return { kind: 'contentInvalid' };
    rawInput = opened.value;
  }

  const input = SessionSpawnNewInputV2Schema.safeParse(rawInput);
  return input.success
    ? { kind: 'available', input: input.data }
    : { kind: 'contentInvalid' };
}
