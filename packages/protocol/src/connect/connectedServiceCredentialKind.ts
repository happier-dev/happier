import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** Canonical connected-service credential category primitive. */
export const ConnectedServiceCredentialKindSchema = lazyZodSchema(() => z.enum(['oauth', 'token']));
export type ConnectedServiceCredentialKind = z.infer<
  typeof ConnectedServiceCredentialKindSchema
>;

export const ConnectedServiceCredentialKindRecoverySchema = lazyZodSchema(() => z.enum([
  'refresh_sign_in', 'reconnect_token', 'refresh_sign_in_or_reconnect_token',
]));
export type ConnectedServiceCredentialKindRecovery = z.infer<typeof ConnectedServiceCredentialKindRecoverySchema>;

/** Agents retain legacy kindless selections. A Provider restriction requires an observed kind. */
export function readConnectedServiceCredentialKindRefusal(
  kind: ConnectedServiceCredentialKind | null | undefined,
  requiredKinds: readonly ConnectedServiceCredentialKind[] | undefined,
  consumer: 'agent' | 'provider',
): ConnectedServiceCredentialKindRecovery | 'unsupported_kind' | null {
  if (!requiredKinds?.length) return null;
  if (kind != null) return requiredKinds.includes(kind) ? null : 'unsupported_kind';
  if (consumer === 'agent') return null;
  const acceptsOAuth = requiredKinds.includes('oauth');
  if (acceptsOAuth && requiredKinds.includes('token')) return 'refresh_sign_in_or_reconnect_token';
  return acceptsOAuth ? 'refresh_sign_in' : 'reconnect_token';
}
