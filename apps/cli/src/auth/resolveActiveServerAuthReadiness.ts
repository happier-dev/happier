/**
 * Whether this computer's stored sign-in is usable against the active relay.
 *
 * Stored bytes are not readiness: the relay may reject them, and a usable
 * account still needs a registered machine identity. Auth login, auth status,
 * setup, and the installers all consume this same decision.
 *
 * An unreachable relay is not treated as a rejection. Only a definitive
 * invalid response makes `authenticated` false; transient reachability leaves
 * the stored sign-in intact.
 */

import {
  readSettings,
  readStoredCredentials,
  type StoredCredentials,
} from '@/persistence';

import {
  validateStoredAuthTokenAgainstActiveServer,
  type ActiveServerStoredTokenValidationResult,
} from './validateStoredAuthTokenAgainstActiveServer';

export type ActiveServerAuthUnusableReason = 'no-credentials' | 'credentials-rejected';

export type ActiveServerAuthReadiness = Readonly<{
  credentials: StoredCredentials | null;
  authenticated: boolean;
  unusableReason: ActiveServerAuthUnusableReason | null;
  machineId: string | null;
  machineRegistered: boolean;
}>;

type ActiveServerAuthReadinessDeps = Readonly<{
  readCredentialsFn?: typeof readStoredCredentials;
  readSettingsFn?: typeof readSettings;
  validateTokenFn?: (token: string) => Promise<ActiveServerStoredTokenValidationResult>;
}>;

export async function resolveActiveServerAuthReadiness(
  deps: ActiveServerAuthReadinessDeps = {},
): Promise<ActiveServerAuthReadiness> {
  const readCredentialsFn = deps.readCredentialsFn ?? readStoredCredentials;
  const readSettingsFn = deps.readSettingsFn ?? readSettings;
  const validateTokenFn = deps.validateTokenFn ?? validateStoredAuthTokenAgainstActiveServer;
  const [credentials, settings] = await Promise.all([
    readCredentialsFn(),
    readSettingsFn(),
  ]);

  const machineIdRaw = settings?.machineId;
  const machineId = typeof machineIdRaw === 'string' && machineIdRaw.trim().length > 0
    ? machineIdRaw.trim()
    : null;

  if (!credentials) {
    return {
      credentials: null,
      authenticated: false,
      unusableReason: 'no-credentials',
      machineId,
      machineRegistered: machineId !== null,
    };
  }

  const validation = await validateTokenFn(credentials.token);
  const rejected = validation.state === 'invalid';
  return {
    credentials,
    authenticated: !rejected,
    unusableReason: rejected ? 'credentials-rejected' : null,
    machineId,
    machineRegistered: machineId !== null,
  };
}
