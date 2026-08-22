import { z } from 'zod';

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

export const ENCRYPTED_STORED_CONTENT_SCHEMA = z.object({
  t: z.literal('encrypted'),
  c: z.string().min(1),
}).strict();

export function addAutomationStoredEnvelopeUtf8LimitIssue(
  value: unknown,
  context: z.RefinementCtx,
  message: string,
): void {
  if (UTF8_ENCODER.encode(createCanonicalJsonSigningInput(value)).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
}

export const AutomationStoredContentEnvelopeV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: PluginJsonValueV2Schema }).strict(),
  ENCRYPTED_STORED_CONTENT_SCHEMA,
]).superRefine((value, context) => {
  addAutomationStoredEnvelopeUtf8LimitIssue(
    value,
    context,
    'Stored Automation envelope exceeds its UTF-8 byte limit',
  );
});
export type AutomationStoredContentEnvelopeV1 = z.infer<typeof AutomationStoredContentEnvelopeV1Schema>;
