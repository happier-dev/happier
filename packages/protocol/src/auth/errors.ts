import { z } from 'zod';

export const AUTH_ERROR_CODES = [
  // Provider / policy
  'unsupported-provider',
  'signup-provider-disabled',
  'provider-required',
  'not-eligible',

  // OAuth
  'oauth_not_configured',
  'missing_access_token',
  'invalid_state',
  'server_error',
  'upstream_error',
  'profile_fetch_failed',
  'invalid_profile',

  // Pending / finalize
  'provider-already-linked',
  'username-taken',
  'username-required',
  'invalid-username',
  'invalid-pending',
  'invalid-public-key',
  'invalid-signature',
  'forbidden',
] as const;

export const AuthErrorCodeSchema = z.enum(AUTH_ERROR_CODES);
export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>;
