import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { decodeBase64, encodeBase64, type Base64Variant } from '../crypto/base64.js';
import { SERVER_IDENTITY_ID_PATTERN } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import { ACCOUNT_API_TOKEN_BEARER_V1_SOURCE, ACCOUNT_API_TOKEN_CREDENTIAL_V1_PREFIX } from './accountApiTokenFormatV1.js';

const ACCOUNT_API_TOKEN_BEARER_V1_PATTERN = new RegExp(`^${ACCOUNT_API_TOKEN_BEARER_V1_SOURCE}$`, 'u');
export const AccountApiTokenBearerV1Schema = lazyZodSchema(() => z.string().check(z.regex(ACCOUNT_API_TOKEN_BEARER_V1_PATTERN)));

export type ParsedAccountApiTokenBearerV1 = Readonly<{
  tokenId: string;
  secret: string;
}>;

/** The sole parser for the exact bearer shape minted by the Account server. */
export function parseAccountApiTokenBearerV1(
  token: string,
): ParsedAccountApiTokenBearerV1 | null {
  const match = ACCOUNT_API_TOKEN_BEARER_V1_PATTERN.exec(token);
  const tokenId = match?.[1];
  const secret = match?.[2];
  return tokenId && secret ? { tokenId, secret } : null;
}

export function accountApiTokenCanonicalBytesSchema(length: number, variant: Base64Variant) {
  const encodedLength = variant === 'base64' ? Math.ceil(length / 3) * 4 : Math.ceil(length * 4 / 3);
  return z.string().check(z.length(encodedLength), z.refine((value) => {
    const bytes = decodeBase64(value, variant);
    return bytes.length === length && encodeBase64(bytes, variant) === value;
  }));
}

export const ApiTokenHomeIdentitySchema = lazyZodSchema(() => z.string().check(z.regex(SERVER_IDENTITY_ID_PATTERN)));
export const ApiTokenContentPublicKeySchema = accountApiTokenCanonicalBytesSchema(32, 'base64');
export const AccountApiTokenCredentialV1Schema = lazyZodSchema(() => z.strictObject({
  bearer: AccountApiTokenBearerV1Schema.check(z.refine((value) => {
    const parsed = parseAccountApiTokenBearerV1(value);
    return parsed !== null && accountApiTokenCanonicalBytesSchema(32, 'base64url').safeParse(parsed.secret).success;
  })),
  wrappingSecret: accountApiTokenCanonicalBytesSchema(32, 'base64url'),
  serverIdentityId: ApiTokenHomeIdentitySchema,
  accountId: z.string().check(z.minLength(1)),
  contentPublicKey: ApiTokenContentPublicKeySchema,
}));
export type AccountApiTokenCredentialV1 = z.infer<typeof AccountApiTokenCredentialV1Schema>;

/** Invocation-local encoding. It must never be used as an HTTP bearer. */
export function formatAccountApiTokenCredentialV1(value: AccountApiTokenCredentialV1): string {
  const payload = AccountApiTokenCredentialV1Schema.parse(value);
  return `${ACCOUNT_API_TOKEN_CREDENTIAL_V1_PREFIX}${encodeBase64(new TextEncoder().encode(JSON.stringify(payload)), 'base64url')}`;
}

export function parseAccountApiTokenCredentialV1(value: string): AccountApiTokenCredentialV1 | null {
  if (!value.startsWith(ACCOUNT_API_TOKEN_CREDENTIAL_V1_PREFIX)) return null;
  try {
    const encoded = value.slice(ACCOUNT_API_TOKEN_CREDENTIAL_V1_PREFIX.length);
    const bytes = decodeBase64(encoded, 'base64url');
    if (encodeBase64(bytes, 'base64url') !== encoded) return null;
    const parsed = AccountApiTokenCredentialV1Schema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
