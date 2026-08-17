import { z } from 'zod';

/**
 * The largest source-declared occurrence timestamp portable across the Run
 * persistence providers. It is an untrusted source fact, not host time.
 */
export const MAX_AUTOMATION_ORIGIN_OCCURRED_AT_MS = 253_402_300_799_999;

export const AutomationOriginOccurredAtV1Schema = z.number().int().nonnegative()
  .max(MAX_AUTOMATION_ORIGIN_OCCURRED_AT_MS).safe();
export type AutomationOriginOccurredAtV1 = z.infer<typeof AutomationOriginOccurredAtV1Schema>;
