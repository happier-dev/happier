import type {
  ConnectedAccountMetadataList,
  ConnectedAccountsService,
} from '@happier-dev/plugin-sdk/connected-accounts';

/**
 * The one runtime path any first-party Triage source uses to enumerate the accounts
 * authorized for its declared purpose.
 *
 * It exists for a single distinction every source was getting wrong independently:
 * **"nothing is connected yet" is not "the provider could not be read."**
 *
 * The host refuses `listAccounts()` for a purpose it holds no selection for, and that
 * refusal is a throw. Every source caught it and mapped it into its own provider
 * failure vocabulary, so a reader with no Connected Account was told their forge had
 * returned something unreadable — about a provider no request was ever sent to. The
 * page that should have said "connect an account" said "this could not be read".
 *
 * The distinction is decidable, and exactly, because the host resolves both questions
 * with the same authorized-target read: `getBinding()` answers `null` precisely where
 * `listAccounts()` throws. So a throw is re-asked as the nullable question rather than
 * guessed at from an error code, and only a confirmed-null binding becomes `unbound`.
 * Anything else — including a binding read that itself fails — stays the original
 * listing failure, because a source that learned nothing must not claim it learned
 * that there is nothing.
 *
 * 1. **The happy path costs nothing.** `getBinding()` is asked only after a throw.
 * 2. **Cancellation is never absence.** An aborted read is `failed`; the binding is
 *    not re-asked, because a cancelled invocation has no standing to conclude.
 * 3. **The original error survives.** `failed` carries the listing's own throw, never
 *    the binding read's, so each source classifies what actually refused it.
 *
 * How each outcome is worded remains source-specific: this module maps no failure into
 * any source's published vocabulary.
 */

/** The narrow slice of the host Connected Accounts service this module consumes. */
export type TriageSourceAccountListerV1 = Pick<
  ConnectedAccountsService,
  'listAccounts' | 'getBinding'
>;

export type TriageSourceAccountListingOutcomeV1 =
  /** The host answered for the purpose's exact current target. */
  | Readonly<{ kind: 'listed'; listing: ConnectedAccountMetadataList }>
  /** Confirmed: this purpose has no selected account. Not a failure — an empty set. */
  | Readonly<{ kind: 'unbound' }>
  /** The listing refused for any other reason, carrying its own throw. */
  | Readonly<{ kind: 'failed'; error: unknown }>;

function isAbortLike(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal !== undefined && signal.aborted) return true;
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export async function readTriageSourceAccountListingV1(input: Readonly<{
  connectedAccounts: TriageSourceAccountListerV1;
  purpose: string;
  limit?: number;
  signal?: AbortSignal;
}>): Promise<TriageSourceAccountListingOutcomeV1> {
  const options = input.signal === undefined ? {} : { signal: input.signal };
  let listing: ConnectedAccountMetadataList;
  try {
    listing = await input.connectedAccounts.listAccounts(
      { purpose: input.purpose, ...(input.limit === undefined ? {} : { limit: input.limit }) },
      options,
    );
  } catch (error) {
    if (isAbortLike(error, input.signal)) {
      return Object.freeze({ kind: 'failed' as const, error });
    }
    let binding;
    try {
      binding = await input.connectedAccounts.getBinding(input.purpose, options);
    } catch {
      return Object.freeze({ kind: 'failed' as const, error });
    }
    return binding === null
      ? Object.freeze({ kind: 'unbound' as const })
      : Object.freeze({ kind: 'failed' as const, error });
  }
  return Object.freeze({ kind: 'listed' as const, listing });
}
