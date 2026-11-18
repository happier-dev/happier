/**
 * Whether this computer's stored sign-in is usable against the active relay.
 *
 * Stored bytes are not readiness: the relay may reject them, and a usable
 * account still needs a registered machine identity. Auth login, auth status,
 * setup, and the installers all consume this same decision.
 *
 * An unreachable relay is not treated as a rejection and never deletes the
 * stored sign-in. It is also not reported as authenticated: callers receive
 * the explicit `unknown` validation state and decide whether they can proceed
 * without a current server fact.
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
export type CredentialReadinessState = 'missing' | 'valid' | 'invalid' | 'unknown';
export type MachineRegistrationState = 'no-local-id' | 'local-only' | 'server-confirmed';

export type ActiveServerAuthReadiness = Readonly<{
  credentials: StoredCredentials | null;
  credentialState: CredentialReadinessState;
  authenticated: boolean;
  unusableReason: ActiveServerAuthUnusableReason | null;
  /** The validator's typed, non-secret reason when the credential is not valid (for example `identity_mismatch`). */
  credentialReason: string | null;
  /** Readable label of the account the relay validated (from the same profile read); null when unknown. */
  accountLabel: string | null;
  machineId: string | null;
  machineRegistrationState: MachineRegistrationState;
  machineRegistered: boolean;
}>;

type ActiveServerAuthReadinessDeps = Readonly<{
  readCredentialsFn?: typeof readStoredCredentials;
  readSettingsFn?: typeof readSettings;
  validateTokenFn?: (token: string, signal?: AbortSignal) => Promise<ActiveServerStoredTokenValidationResult>;
  signal?: AbortSignal;
}>;

export async function resolveActiveServerAuthReadiness(
  deps: ActiveServerAuthReadinessDeps = {},
): Promise<ActiveServerAuthReadiness> {
  deps.signal?.throwIfAborted();
  const readCredentialsFn = deps.readCredentialsFn ?? readStoredCredentials;
  const readSettingsFn = deps.readSettingsFn ?? readSettings;
  const validateTokenFn = deps.validateTokenFn ?? validateStoredAuthTokenAgainstActiveServer;
  const [credentials, settings] = await Promise.all([
    readCredentialsFn(),
    readSettingsFn(),
  ]);
  deps.signal?.throwIfAborted();

  const machineIdRaw = settings?.machineId;
  const machineId = typeof machineIdRaw === 'string' && machineIdRaw.trim().length > 0
    ? machineIdRaw.trim()
    : null;
  // `machineId` is only a locally allocated identity. The scoped confirmation
  // bit is written by the canonical registration owner after the Home accepts
  // that identity, and is cleared when credentials/account identity changes.
  const machineRegistrationState: MachineRegistrationState = machineId === null
    ? 'no-local-id'
    : settings?.machineIdConfirmedByServer === true
      ? 'server-confirmed'
      : 'local-only';
  const machineRegistered = machineRegistrationState === 'server-confirmed';

  if (!credentials) {
    return {
      credentials: null,
      credentialState: 'missing',
      authenticated: false,
      unusableReason: 'no-credentials',
      credentialReason: null,
      accountLabel: null,
      machineId,
      machineRegistrationState,
      machineRegistered,
    };
  }

  const validation = await validateTokenFn(credentials.token, deps.signal);
  deps.signal?.throwIfAborted();
  const credentialState: CredentialReadinessState = validation.state;
  if (
    credentialState === 'valid'
    && credentials.credentialProvenance === 'stored_session'
    && credentials.encryption?.type === 'legacy'
  ) {
    const { fetchAccountEncryptionCurrentness } = await import('@/api/client/connectedServiceCredentialApi');
    await fetchAccountEncryptionCurrentness({
      credentials: credentials, token: credentials.token,
      ...(deps.signal ? { signal: deps.signal } : {}),
    }).catch(() => {
      deps.signal?.throwIfAborted();
      // Profile validation remains an auth fact; currentness owns its typed recovery result.
    });
  }
  const rejected = credentialState === 'invalid';
  return {
    credentials,
    credentialState,
    authenticated: credentialState === 'valid',
    unusableReason: rejected ? 'credentials-rejected' : null,
    credentialReason: validation.state === 'valid' ? null : validation.reasonCode,
    accountLabel: validation.state === 'valid' ? validation.accountLabel ?? null : null,
    machineId,
    machineRegistrationState,
    machineRegistered,
  };
}
