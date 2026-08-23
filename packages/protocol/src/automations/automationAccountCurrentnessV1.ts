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

/**
 * The one projection from a raw Account currentness reading to the Automation
 * witness. A supported plain Account may still retain the content public key of
 * the E2EE state it was migrated away from, so its canonical currentness
 * reading keeps reporting that fingerprint. Plain Automation content is
 * keyless, so the plain witness is normalized here — once, for every reader —
 * instead of letting each caller validate the raw retained fingerprint and
 * conclude that a current plain Account has no currentness.
 */
export function projectAutomationAccountCurrentnessWitnessV1(reading: Readonly<{
  mode: unknown;
  version: unknown;
  contentKeyFingerprint: unknown;
}>): AutomationAccountCurrentnessWitnessV1 | null {
  const parsed = AutomationAccountCurrentnessWitnessV1Schema.safeParse({
    mode: reading.mode,
    version: reading.version,
    contentKeyFingerprint: reading.mode === 'plain' ? null : reading.contentKeyFingerprint,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Exact witness equality. Every Automation request that carries a witness to
 * the server must match the server's current Account state exactly, including
 * its Account change version.
 */
export function sameAutomationAccountCurrentnessWitnessV1(
  left: AutomationAccountCurrentnessWitnessV1,
  right: AutomationAccountCurrentnessWitnessV1,
): boolean {
  return left.mode === right.mode
    && left.version === right.version
    && left.contentKeyFingerprint === right.contentKeyFingerprint;
}

/**
 * Account *content* identity: the mode and key under which Account-scoped
 * Automation content can be opened or sealed. The witness version is the
 * Account-wide change cursor and advances for unrelated Account writes, so a
 * reader that only has to prove "this content is still readable with the same
 * key" compares identity rather than the exact witness.
 */
export function sameAutomationAccountContentIdentityV1(
  left: AutomationAccountCurrentnessWitnessV1,
  right: AutomationAccountCurrentnessWitnessV1,
): boolean {
  return left.mode === right.mode
    && left.contentKeyFingerprint === right.contentKeyFingerprint;
}
