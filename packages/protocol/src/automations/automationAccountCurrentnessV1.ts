import { z } from 'zod';

import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';

import { AutomationNonnegativeSafeIntegerV1Schema } from './automationResultDeliveryV1.js';

/**
 * A non-secret witness from the canonical Account currentness endpoint. The
 * host binds it to private Automation content; plugin Action input never
 * supplies it.
 */
export const AutomationAccountCurrentnessWitnessV1Schema = z.object({
  mode: AccountEncryptionModeSchema,
  version: AutomationNonnegativeSafeIntegerV1Schema,
  contentKeyFingerprint: z.string().min(1).max(256).nullable(),
}).strict().superRefine((value, context) => {
  if (
    (value.mode === 'plain' && value.contentKeyFingerprint !== null)
    || (value.mode === 'e2ee' && value.contentKeyFingerprint === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contentKeyFingerprint'],
      message: 'Account currentness mode and content-key fingerprint must agree',
    });
  }
});
export type AutomationAccountCurrentnessWitnessV1 = z.infer<
  typeof AutomationAccountCurrentnessWitnessV1Schema
>;
