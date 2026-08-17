import { z } from 'zod';

export const EncryptedStringV1Schema = z.object({
  t: z.literal('enc-v1'),
  c: z.string().min(1),
});

export type EncryptedStringV1 = z.infer<typeof EncryptedStringV1Schema>;

export const SecretStringV1Schema = z.object({
  _isSecretValue: z.literal(true),
  value: z.string().min(1).optional(),
  encryptedValue: EncryptedStringV1Schema.optional(),
});

export type SecretStringV1 = z.infer<typeof SecretStringV1Schema>;
