import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { PluginJsonValueV2Schema } from '../plugins/contributions/publicTypes.js';

const UTF8_ENCODER = new TextEncoder();

/**
 * Foundational Automation stored-content bounds and envelope. These are shared
 * by every Automation persistence owner — Event admission, the Run execution
 * recipe, the session-start request envelope, and the trigger definition — so
 * they live below the Event module rather than inside it.
 */
export const MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES = 256 * 1024;
export const MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES = 512 * 1024;

export const ENCRYPTED_STORED_CONTENT_SCHEMA = z.strictObject({
  t: z.literal('encrypted'),
  c: z.string().check(z.minLength(1)),
});

export function addAutomationStoredEnvelopeUtf8LimitIssue(
  value: unknown,
  context: z.core.$RefinementCtx,
  message: string,
): void {
  if (UTF8_ENCODER.encode(createCanonicalJsonSigningInput(value)).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
    context.addIssue({ code: "custom", message });
  }
}

/** Shared envelope shape; each persistence owner supplies its own resource boundary. */
export const StoredContentEnvelopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: PluginJsonValueV2Schema }),
  ENCRYPTED_STORED_CONTENT_SCHEMA,
]));

export const AutomationStoredContentEnvelopeV1Schema = lazyZodSchema(() => StoredContentEnvelopeV1Schema.check(z.superRefine((value, context) => {
  addAutomationStoredEnvelopeUtf8LimitIssue(
    value,
    context,
    'Stored Automation envelope exceeds its UTF-8 byte limit',
  );
})));
export type AutomationStoredContentEnvelopeV1 = z.infer<typeof AutomationStoredContentEnvelopeV1Schema>;
export const AutomationStoredContentEnvelopeV1ReadSchema = createStoredReadSchema(AutomationStoredContentEnvelopeV1Schema);
