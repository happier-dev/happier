/**
 * Whether this computer's stored sign-in is usable against the relay it is
 * pointed at right now.
 *
 * `happier auth status` has always answered this question, but it answered it
 * inline, so every other caller re-derived it — and re-derived it wrong, from
 * the presence of a credentials file. Two states are invisible to that test and
 * are exactly the states a guided setup exists to repair: credentials the relay
 * rejects, and credentials with no machine identity behind them.
 *
 * The rule for an unreachable relay is deliberately not "assume broken". Only a
 * definitive rejection unsets authentication; a relay that did not answer leaves
 * the stored credentials as they were, because a relay being down is not a
 * reason to make someone sign in again.
 */

import { readCredentials, readSettings, type Credentials } from '@/persistence';

import { validateStoredAuthTokenAgainstActiveServer } from './validateStoredAuthTokenAgainstActiveServer';

export type ActiveServerAuthUnusableReason = 'no-credentials' | 'credentials-rejected';
export type ActiveServerCredentialState = 'missing' | 'rejected' | 'valid' | 'unknown';

export type ActiveServerAuthReadiness = Readonly<{
  credentials: Credentials | null;
  /** Credentials exist and the active relay positively accepted them. */
  authenticated: boolean;
  /** The exact validation fact. `unknown` retains credentials without calling them authenticated. */
  credentialState: ActiveServerCredentialState;
  /** Why the stored sign-in cannot be used, when it cannot. */
  unusableReason: ActiveServerAuthUnusableReason | null;
  machineId: string | null;
  machineRegistered: boolean;
}>;

export async function resolveActiveServerAuthReadiness(): Promise<ActiveServerAuthReadiness> {
  const [credentials, settings] = await Promise.all([
    readCredentials(),
    readSettings(),
  ]);

  const machineIdRaw = settings?.machineId;
  const machineId = typeof machineIdRaw === 'string' && machineIdRaw.trim().length > 0
    ? machineIdRaw.trim()
    : null;

  if (!credentials) {
    return {
      credentials: null,
      authenticated: false,
      credentialState: 'missing',
      unusableReason: 'no-credentials',
      machineId,
      machineRegistered: machineId !== null,
    };
  }

  const validation = await validateStoredAuthTokenAgainstActiveServer(credentials.token);
  const credentialState: ActiveServerCredentialState = validation.state === 'invalid'
    ? 'rejected'
    : validation.state;

  return {
    credentials,
    authenticated: credentialState === 'valid',
    credentialState,
    unusableReason: credentialState === 'rejected' ? 'credentials-rejected' : null,
    machineId,
    machineRegistered: machineId !== null,
  };
}
