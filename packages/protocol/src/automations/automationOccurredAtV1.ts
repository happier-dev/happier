import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The largest source-declared occurrence timestamp portable across the Run
 * persistence providers. It is an untrusted source fact, not host time.
 */
export const MAX_AUTOMATION_OCCURRED_AT_MS = 253_402_300_799_999;

export const AutomationOccurredAtV1Schema = lazyZodSchema(() => z.number().int().nonnegative()
  .max(MAX_AUTOMATION_OCCURRED_AT_MS).safe());
export type AutomationOccurredAtV1 = z.infer<typeof AutomationOccurredAtV1Schema>;
