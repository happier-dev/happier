import type {
  ConnectedAccountMaterialization,
  ConnectedAccountRef,
  ConnectedAccountsService,
} from '@happier-dev/plugin-sdk/connected-accounts';

/**
 * The one runtime path any first-party Triage source uses to obtain HTTP authorization
 * for a configured instance.
 *
 * This belongs in the source implementation layer, not `triage-protocol`: it calls
 * the Connected Accounts service and receives ephemeral credential material. The
 * portable protocol owns only schemas and business contracts.
 *
 * 1. **The exact bound account, never the selected binding.** A source that observes
 *    two accounts must reach the one this invocation was asked about, and only that
 *    one. The account and request origin both travel in the materialization request,
 *    so material minted for one account or deployment cannot be sent elsewhere.
 * 2. **`httpHeaders`, carrying a usable `authorization`.** A materialization of another
 *    kind, or one with no authorization value, is refused here. Sending the request
 *    anyway spends the user's read as an anonymous call and then classifies the
 *    provider's `401`/`404` as though the account had been refused.
 * 3. **The credential is returned, never retained.** This module holds nothing across
 *    calls: no cache, memo, or module state. The caller keeps headers inside its own
 *    invocation closure.
 *
 * How a refusal is worded remains source-specific: each source maps these neutral
 * reasons into its own published failure vocabulary.
 */

/** The narrow slice of the host Connected Accounts service this module consumes. */
export type TriageListedAccountMaterializerV1 = Pick<
  ConnectedAccountsService,
  'materializeListedAccount'
>;

export type TriageSourceAuthorizationFailureReasonV1 =
  /** The invocation was cancelled before or during materialization. */
  | 'cancelled'
  /** The host rejected the materialization request. */
  | 'materializationFailed'
  /** The account materialized something other than HTTP headers. */
  | 'unsupportedMaterialization'
  /** The materialized headers carry no usable `authorization`. */
  | 'authorizationHeaderMissing';

export type TriageSourceAuthorizationV1 = Readonly<{
  /** The materialized headers, exactly as the host produced them. */
  headers: Readonly<Record<string, string>>;
  /** The trimmed `authorization` value, for a client that sends only that header. */
  authorization: string;
}>;

/** What a materialization already in hand yields, with no host call of its own. */
export type TriageSourceAuthorizationReadOutcomeV1 =
  | Readonly<{ ok: true } & TriageSourceAuthorizationV1>
  | Readonly<{ ok: false; reason: 'unsupportedMaterialization' | 'authorizationHeaderMissing' }>;

export type TriageSourceAuthorizationOutcomeV1 =
  | Readonly<{ ok: true } & TriageSourceAuthorizationV1>
  | Readonly<{ ok: false; reason: TriageSourceAuthorizationFailureReasonV1 }>;

const AUTHORIZATION_HEADER_NAME = 'authorization';

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
 * Action-owned account materialized against an expected ref, for instance — still
 * admits it by exactly this rule, so the check has one owner rather than one per
 * call path.
 */
export function readTriageSourceAuthorizationV1(
  materialization: ConnectedAccountMaterialization,
): TriageSourceAuthorizationReadOutcomeV1 {
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

export async function materializeTriageSourceAuthorizationV1(input: Readonly<{
  connectedAccounts: TriageListedAccountMaterializerV1;
  /** The Connected Account purpose this source declares. */
  purpose: string;
  /** The exact account the configured instance is bound to. */
  account: ConnectedAccountRef;
  /** The origin the credential is minted for, and the only one it may be sent to. */
  origin: string;
  signal?: AbortSignal;
}>): Promise<TriageSourceAuthorizationOutcomeV1> {
  if (isAborted(input.signal)) {
    return Object.freeze({ ok: false as const, reason: 'cancelled' as const });
  }

  let materialization: ConnectedAccountMaterialization;
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

  return readTriageSourceAuthorizationV1(materialization);
}
