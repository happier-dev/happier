import { readAccountIdFromToken, readCredentialEpochFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import type { SessionHostLaunchRecordV1 } from '@/session/transport/rpc/localSessionRpcChannel';

type AdmittedAccount = NonNullable<SessionHostLaunchRecordV1['account']>;

/**
 * The Account a launch runs as when its credential is the Machine Account's stored sign-in: the one
 * identity rule the daemon (producer of the launch record) and the host (its hold) both apply.
 * Null for requester custody, API tokens and unreadable bearers: those keep their own per-launch read.
 */
export function readStoredCredentialLaunchIdentity(credentials: StoredCredentials): Readonly<{
  accountId: string; credentialEpoch: number;
}> | null {
  if (credentials.credentialProvenance === 'api_token' || credentials.requesterSessionCredentialScope) return null;
  const accountId = readAccountIdFromToken(credentials.token);
  const credentialEpoch = readCredentialEpochFromToken(credentials.token);
  return accountId === null || credentialEpoch === null ? null : { accountId, credentialEpoch };
}

/** The stored credential no longer names the Account the daemon admitted for this launch. */
export class SessionHostLaunchAccountChangedError extends Error {
  readonly code = 'session_launch_account_changed';
  /** The typed runtime cause the Session's end carries to the spawn result (existing `account_changed` reason). */
  readonly failureCause = { phase: 'authentication', failureReason: 'account_changed', retryable: true } as const;
  constructor() {
    super('The signed-in Account changed since this Session was admitted');
  }
}

/**
 * The session host's Account credentials, read once per (Home, Account) for the host's lifetime
 * instead of once per Session. Each add carries the Account id and credential epoch its daemon
 * admitted: a held credential is used only when both match; otherwise the credential is read again
 * (in the added Session's scope, as its runner would) and the Session is refused when that read
 * still names another Account or epoch. A host that outlives a sign-out/sign-in therefore never
 * starts a Session under the previous Account. Memory only; never logged or sent anywhere.
 */
export function createSessionHostCredentialHold(
  read: () => Promise<StoredCredentials | null> = () => readStoredCredentials(),
): Readonly<{ resolve(account: AdmittedAccount): Promise<StoredCredentials> }> {
  const held = new Map<string, Readonly<{ credentials: StoredCredentials; credentialEpoch: number }>>();
  return {
    async resolve(account) {
      const key = `${configuration.privateKeyFile}\u0000${account.accountId}`;
      const entry = held.get(key);
      // Each Session gets its own object, as its own read would give it: per-Session custody bound
      // onto one Session's credentials never reaches another.
      if (entry && entry.credentialEpoch === account.credentialEpoch) return { ...entry.credentials };
      held.delete(key);
      const credentials = await read();
      const identity = credentials ? readStoredCredentialLaunchIdentity(credentials) : null;
      if (!credentials || identity?.accountId !== account.accountId || identity.credentialEpoch !== account.credentialEpoch) {
        throw new SessionHostLaunchAccountChangedError();
      }
      held.set(key, { credentials: { ...credentials }, credentialEpoch: account.credentialEpoch });
      return credentials;
    },
  };
}
