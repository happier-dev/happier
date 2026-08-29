import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../../../crypto/base64.js';

const ACCOUNT_DIRECTORY_KEY_ID_PATTERN = /^[0-9a-f]{64}$/u;
const ACCOUNT_DIRECTORY_PUBLIC_KEY_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const PublicKeyBase64UrlSchema = z.string()
  .regex(ACCOUNT_DIRECTORY_PUBLIC_KEY_BASE64URL_PATTERN)
  .refine((value) => {
    try {
      const bytes = decodeBase64(value, 'base64url');
      return bytes.byteLength === 32 && encodeBase64(bytes, 'base64url') === value;
    } catch {
      return false;
    }
  }, 'publicKeyBase64Url must be canonical base64url for 32 bytes');

export const AccountDirectoryCapabilitiesSchema = z.object({
  version: z.literal(1),
  homeDirectory: z.boolean(),
  homeEnrollment: z.boolean(),
  deviceApproval: z.boolean().optional(),
  homeLoginAssertion: z.object({
    keyId: z.string().regex(ACCOUNT_DIRECTORY_KEY_ID_PATTERN),
    publicKeyBase64Url: PublicKeyBase64UrlSchema,
  }).strict(),
}).strict();

export type AccountDirectoryCapabilities = z.infer<typeof AccountDirectoryCapabilitiesSchema>;
