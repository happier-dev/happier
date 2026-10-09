import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ComputerSecretFillRequestV1Schema } from '../computer/v1.js';
import { BrowserAutomationSecretFillRequestV1Schema } from '../browser/automation/v1.js';

/** Live human continuation only. Never an Action input, stored approval or replay operand. */
export const PrivateSecretChoiceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('saved'), ref: z.string().min(1), fingerprint: z.string().min(1),
    revision: z.number().int().nonnegative().nullable() }).strict(),
]));
export type PrivateSecretChoiceV1 = z.infer<typeof PrivateSecretChoiceV1Schema>;

export const PrivateSecretContinuationV1Schema = lazyZodSchema(() => {
  const binding = {
    v: z.literal(1), artifactId: z.string().min(1), requestId: z.string().min(1),
    accountEncryptionMode: z.enum(['plain', 'e2ee']),
    choice: PrivateSecretChoiceV1Schema, submit: z.boolean(),
  };
  return z.discriminatedUnion('actionId', [
    z.object({ ...binding, actionId: z.literal('computer.secret.fill'), request: ComputerSecretFillRequestV1Schema }).strict(),
    z.object({ ...binding, actionId: z.literal('browser.automation.secret.fill'), request: BrowserAutomationSecretFillRequestV1Schema }).strict(),
  ]);
});
export type PrivateSecretContinuationV1 = z.infer<typeof PrivateSecretContinuationV1Schema>;
