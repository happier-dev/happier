import { z } from 'zod';

export const AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND =
  'happier_automation_template_encrypted_v1' as const;
export const AUTOMATION_TEMPLATE_PLAIN_V1_KIND =
  'happier_automation_template_plain_v1' as const;

export const AUTOMATION_TEMPLATE_PAYLOAD_CIPHERTEXT_MAX_CHARS = 200_000;
export const AUTOMATION_TEMPLATE_PAYLOAD_PLAINTEXT_MAX_CHARS = 200_000;

/**
 * How large the serialized template envelope may be as one persisted
 * `templateCiphertext` string: the bounded payload above plus its envelope
 * framing. Every reader and writer of that same persisted field binds here —
 * the V3 API, the Run recipe, the Account encryption transition, the server's
 * authoring validation, and the daemon's pre-decrypt bound. A second local
 * ceiling would make a validly persisted definition unreadable by one of them.
 *
 * This is deliberately not the whole-execution-input byte limit
 * (`MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES`), which bounds a different
 * persisted field.
 */
export const AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS = 220_000;

const ExistingSessionIdSchema = z.string().trim().min(1).max(128);

export const EncryptedAutomationTemplateEnvelopeSchema = z
  .object({
    kind: z.literal(AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND),
    payloadCiphertext: z
      .string()
      .trim()
      .min(1)
      .max(AUTOMATION_TEMPLATE_PAYLOAD_CIPHERTEXT_MAX_CHARS),
  })
  .strict();
export type EncryptedAutomationTemplateEnvelope = z.infer<
  typeof EncryptedAutomationTemplateEnvelopeSchema
>;

const PlainAutomationTemplateEnvelopeBaseSchema = z
  .object({
    kind: z.literal(AUTOMATION_TEMPLATE_PLAIN_V1_KIND),
    payload: z.unknown(),
  })
  .strict();

function withPlainPayloadValidation<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine((value, context) => {
    const payload = (value as { payload: unknown }).payload;
    let payloadJson: string | undefined;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      payloadJson = undefined;
    }
    if (typeof payloadJson !== 'string') {
      context.addIssue({
        code: 'custom',
        path: ['payload'],
        message: 'payload must be JSON-serializable',
      });
      return;
    }
    if (
      payloadJson.length
      > AUTOMATION_TEMPLATE_PAYLOAD_PLAINTEXT_MAX_CHARS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['payload'],
        message: 'payload is too large',
      });
    }
  }) as T;
}

export const PlainAutomationTemplateEnvelopeSchema = withPlainPayloadValidation(
  PlainAutomationTemplateEnvelopeBaseSchema,
);
export type PlainAutomationTemplateEnvelope = z.infer<
  typeof PlainAutomationTemplateEnvelopeSchema
>;

export const AutomationTemplateEnvelopeSchema = z.discriminatedUnion('kind', [
  EncryptedAutomationTemplateEnvelopeSchema,
  PlainAutomationTemplateEnvelopeSchema,
]);
export type AutomationTemplateEnvelope = z.infer<
  typeof AutomationTemplateEnvelopeSchema
>;

/**
 * Exact read-only predecessor shape emitted before target identifiers became
 * payload-private. New writers and current request validation use
 * AutomationTemplateEnvelopeSchema; this adapter exists only while supported
 * persisted rows can retain the former outer field.
 */
export const LegacyEncryptedAutomationTemplateEnvelopeSchema =
  EncryptedAutomationTemplateEnvelopeSchema.extend({
    existingSessionId: ExistingSessionIdSchema.optional(),
  });
export type LegacyEncryptedAutomationTemplateEnvelope = z.infer<
  typeof LegacyEncryptedAutomationTemplateEnvelopeSchema
>;

export const LegacyPlainAutomationTemplateEnvelopeSchema =
  withPlainPayloadValidation(
    PlainAutomationTemplateEnvelopeBaseSchema.extend({
      existingSessionId: ExistingSessionIdSchema.optional(),
    }),
  );
export type LegacyPlainAutomationTemplateEnvelope = z.infer<
  typeof LegacyPlainAutomationTemplateEnvelopeSchema
>;

export const LegacyAutomationTemplateEnvelopeSchema = z.discriminatedUnion(
  'kind',
  [
    LegacyEncryptedAutomationTemplateEnvelopeSchema,
    LegacyPlainAutomationTemplateEnvelopeSchema,
  ],
);
export type LegacyAutomationTemplateEnvelope = z.infer<
  typeof LegacyAutomationTemplateEnvelopeSchema
>;

export type AutomationTemplateEnvelopeStoredRead = Readonly<{
  envelope: AutomationTemplateEnvelope;
  /**
   * Present only for the exact predecessor encrypted shape. Content-capable
   * readers must compare it with the authenticated payload before acting on
   * it; non-content readers must not project it.
   */
  legacyExistingSessionId?: string;
}>;

function readPayloadExistingSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const candidate = (payload as Record<string, unknown>).existingSessionId;
  if (typeof candidate !== 'string') return null;
  const normalized = candidate.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Reads the one released predecessor shape without making its outer target
 * identifier part of the canonical envelope. New writes and incoming current
 * requests must use AutomationTemplateEnvelopeSchema instead.
 */
export function normalizeAutomationTemplateEnvelopeStoredRead(
  input: unknown,
): AutomationTemplateEnvelopeStoredRead | null {
  const current = AutomationTemplateEnvelopeSchema.safeParse(input);
  if (current.success) {
    return { envelope: current.data };
  }

  const predecessor = LegacyAutomationTemplateEnvelopeSchema.safeParse(input);
  if (!predecessor.success || !predecessor.data.existingSessionId) {
    return null;
  }

  if (predecessor.data.kind === AUTOMATION_TEMPLATE_PLAIN_V1_KIND) {
    if (
      readPayloadExistingSessionId(predecessor.data.payload)
      !== predecessor.data.existingSessionId
    ) {
      return null;
    }
    return {
      envelope: {
        kind: AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
        payload: predecessor.data.payload,
      },
    };
  }

  return {
    envelope: {
      kind: AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
      payloadCiphertext: predecessor.data.payloadCiphertext,
    },
    legacyExistingSessionId: predecessor.data.existingSessionId,
  };
}
