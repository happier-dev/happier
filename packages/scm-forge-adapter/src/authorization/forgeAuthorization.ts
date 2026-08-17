import type {
  ConnectedAccountMaterialization,
  ConnectedAccountRef,
  ConnectedAccountsService,
} from '@happier-dev/plugin-sdk/connected-accounts';

/**
 * The one way a forge source obtains HTTP authorization for a configured instance.
 *
 * Three rules are identical for every forge, and each one is a place a single source
 * could drift silently:
 *
 * 1. **The exact bound account, never the selected binding.** A source that observes
 *    two accounts must reach the one this invocation was asked about, and only that
 *    one. The account and the request origin both travel in the materialization
 *    request, so material minted for one account or one deployment cannot be sent
 *    elsewhere.
 * 2. **`httpHeaders`, carrying a usable `authorization`.** A materialization of another
 *    kind, or one with no authorization value, is refused here. Sending the request
 *    anyway spends the user's read as an anonymous call and then classifies the forge's
 *    `401`/`404` as though the account had been refused.
 * 3. **The credential is returned, never retained.** This module holds nothing across
 *    calls: no cache, no memo, no module state. The caller keeps the headers inside its
 *    own invocation closure.
 *
 * How a refusal is reported to a user is NOT shared: each forge maps these reasons into
 * its own published failure vocabulary.
 */

/** The narrow slice of the host Connected Accounts service this module consumes. */
export type ForgeListedAccountMaterializer = Pick<
  ConnectedAccountsService,
  'materializeListedAccount'
>;

export type ForgeAuthorizationFailureReason =
  /** The invocation was cancelled before or during materialization. */
  | 'cancelled'
  /** The host rejected the materialization request. */
  | 'materializationFailed'
  /** The account materialized something other than HTTP headers. */
  | 'unsupportedMaterialization'
  /** The materialized headers carry no usable `authorization`. */
  | 'authorizationHeaderMissing';

export type ForgeAuthorization = Readonly<{
  /** The materialized headers, exactly as the host produced them. */
  headers: Readonly<Record<string, string>>;
  /** The trimmed `authorization` value, for a client that sends only that header. */
  authorization: string;
}>;

/** What a materialization already in hand yields, with no host call of its own. */
export type ForgeAuthorizationReadOutcome =
  | Readonly<{ ok: true } & ForgeAuthorization>
  | Readonly<{ ok: false; reason: 'unsupportedMaterialization' | 'authorizationHeaderMissing' }>;

export type ForgeAuthorizationOutcome =
  | Readonly<{ ok: true } & ForgeAuthorization>
  | Readonly<{ ok: false; reason: ForgeAuthorizationFailureReason }>;

const AUTHORIZATION_HEADER_NAME = 'authorization';

/**
 * Read through a function rather than inline: a signal can be aborted DURING the await,
 * and an inline read would be narrowed away by the pre-flight check above it.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function isAbortLikeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function readAuthorizationHeader(headers: Readonly<Record<string, string>>): string | null {
  const entry = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === AUTHORIZATION_HEADER_NAME);
  const value = entry?.[1]?.trim();
  return value === undefined || value === '' ? null : value;
}

/**
 * Admits a materialization the caller already holds.
 *
 * A source whose surrounding contract obtains the materialization another way — an
 * Action-owned account materialized against an expected ref, for instance — still admits
 * it by exactly this rule, so the check has one owner rather than one per call path.
 */
export function readForgeAuthorization(
  materialization: ConnectedAccountMaterialization,
): ForgeAuthorizationReadOutcome {
  if (materialization.kind !== 'httpHeaders') {
    return Object.freeze({ ok: false as const, reason: 'unsupportedMaterialization' as const });
  }
  const authorization = readAuthorizationHeader(materialization.headers);
  if (authorization === null) {
    return Object.freeze({ ok: false as const, reason: 'authorizationHeaderMissing' as const });
  }
  return Object.freeze({
    ok: true as const,
    headers: Object.freeze({ ...materialization.headers }),
    authorization,
  });
}

export async function materializeForgeAuthorization(input: Readonly<{
  connectedAccounts: ForgeListedAccountMaterializer;
  /** The Connected Account purpose this source declares. */
  purpose: string;
  /** The exact account the configured instance is bound to. */
  account: ConnectedAccountRef;
  /** The origin the credential is minted for, and the only one it may be sent to. */
  origin: string;
  signal?: AbortSignal;
}>): Promise<ForgeAuthorizationOutcome> {
  if (isAborted(input.signal)) {
    return Object.freeze({ ok: false as const, reason: 'cancelled' as const });
  }

  let materialization;
  try {
    materialization = await input.connectedAccounts.materializeListedAccount(
      {
        purpose: input.purpose,
        account: input.account,
        materialization: {
          kind: 'httpHeaders',
          origin: input.origin,
          headerNames: [AUTHORIZATION_HEADER_NAME],
        },
      },
      { ...(input.signal === undefined ? {} : { signal: input.signal }) },
    );
  } catch (rejection) {
    // The rejection itself is never returned: a materialization error can carry the very
    // material it failed to deliver, and every caller reports failures to a user.
    const cancelled = isAbortLikeError(rejection) || isAborted(input.signal);
    return Object.freeze({
      ok: false as const,
      reason: cancelled ? ('cancelled' as const) : ('materializationFailed' as const),
    });
  }

  return readForgeAuthorization(materialization);
}
