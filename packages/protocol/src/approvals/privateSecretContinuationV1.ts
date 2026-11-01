import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { InputPathSchema } from '../inputs/inputPredicates.js';
import { ComputerSecretFillRequestV1Schema } from '../computer/v1.js';
import { BrowserAutomationSecretFillRequestV1Schema } from '../browser/automation/v1.js';

/** Live human continuation only. Never an Action input, stored approval or replay operand. */
export const PrivateSecretChoiceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), value: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('saved'), ref: z.string().check(z.minLength(1)), fingerprint: z.string().check(z.minLength(1)),
    revision: z.nullable(z.number().check(z.int(), z.nonnegative())) }),
]));
export type PrivateSecretChoiceV1 = z.infer<typeof PrivateSecretChoiceV1Schema>;

export const PrivateSecretContinuationV1Schema = lazyZodSchema(() => {
  const binding = {
    v: z.literal(1), artifactId: z.string().check(z.minLength(1)), requestId: z.string().check(z.minLength(1)),
    accountEncryptionMode: z.enum(['plain', 'e2ee']),
    choice: PrivateSecretChoiceV1Schema, submit: z.boolean(),
  };
  return z.discriminatedUnion('actionId', [
    z.strictObject({ ...binding, actionId: z.literal('computer.secret.fill'), request: ComputerSecretFillRequestV1Schema }),
    z.strictObject({ ...binding, actionId: z.literal('browser.automation.secret.fill'), request: BrowserAutomationSecretFillRequestV1Schema }),
  ]);
});
export type PrivateSecretContinuationV1 = z.infer<typeof PrivateSecretContinuationV1Schema>;

/** Value-free presentation from the declaration owner; private admission rebinds current paths. */
export const ConfidentialActionInputReviewV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('action_inputs'), paths: z.array(InputPathSchema),
}));
