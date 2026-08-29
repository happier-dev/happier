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
 * 3. **Shared lifecycle facts are classified once.** `failed.reason` distinguishes
 *    caller cancellation, an explicit deadline, and an ordinary listing failure.
 * 4. **The original error survives.** `failed.error` carries the listing's own throw,
 *    never the binding read's, so provider-specific detail can still be derived from
 *    what actually refused it.
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
  /** The listing refused, carrying both the shared classification and its original throw. */
  | Readonly<{
    kind: 'failed';
    reason: TriageSourceAccountListingFailureReasonV1;
    error: unknown;
  }>;

export type TriageSourceAccountListingFailureReasonV1 = 'cancelled' | 'deadline' | 'failed';

function errorName(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Readonly<{ name?: unknown }>).name
    : undefined;
}

function classifyListingFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): TriageSourceAccountListingFailureReasonV1 {
  if (signal?.aborted === true) {
    return errorName(signal.reason) === 'TimeoutError' ? 'deadline' : 'cancelled';
  }
  if (errorName(error) === 'TimeoutError') return 'deadline';
  if (errorName(error) === 'AbortError') return 'cancelled';
  return 'failed';
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
    const reason = classifyListingFailure(error, input.signal);
    if (reason !== 'failed') {
      return Object.freeze({ kind: 'failed' as const, reason, error });
    }
    let binding;
    try {
      binding = await input.connectedAccounts.getBinding(input.purpose, options);
    } catch {
      return Object.freeze({ kind: 'failed' as const, reason, error });
    }
    return binding === null
      ? Object.freeze({ kind: 'unbound' as const })
      : Object.freeze({ kind: 'failed' as const, reason, error });
  }
  return Object.freeze({ kind: 'listed' as const, listing });
}
