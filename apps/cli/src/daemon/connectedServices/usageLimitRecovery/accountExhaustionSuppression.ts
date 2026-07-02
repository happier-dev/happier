/**
 * Account-level "known-exhausted until reset" suppression.
 *
 * When one session observes a connected-service account as quota-exhausted, many sibling
 * sessions bound to the SAME account will independently observe the same exhaustion and each
 * try to restart/recover. That produces a per-session storm against an account that cannot
 * recover until its provider reset time. This suppression lets the runtime mark an account as
 * known-exhausted for a reset bucket so siblings skip the restart-loop until the window passes.
 *
 * It is provider-agnostic in shape; the Codex runtime (and any future provider) can consult it.
 * It intentionally stores no secrets — only the service id, an opaque account identifier, and a
 * reset bucket time.
 */

export type AccountExhaustionKey = Readonly<{
  serviceId: string;
  accountId: string;
}>;

export type AccountExhaustionWindow = Readonly<{
  serviceId: string;
  accountId: string;
  resetAtMs: number | null;
}>;

const DEFAULT_SUPPRESSION_WINDOW_MS = 5 * 60_000;

function normalizeKeyPart(value: string): string {
  return value.trim();
}

function suppressionKey(input: AccountExhaustionKey): string {
  return `${normalizeKeyPart(input.serviceId)} ${normalizeKeyPart(input.accountId)}`;
}

export type SuppressionRecord = Readonly<{
  /** The reset bucket this exhaustion belongs to (provider reset time, or null when unknown). */
  resetAtMs: number | null;
  /** Wall-clock time after which the suppression no longer applies. */
  expiresAtMs: number;
}>;

export class AccountExhaustionSuppression {
  private readonly records = new Map<string, SuppressionRecord>();
  private readonly defaultWindowMs: number;

  constructor(private readonly deps: Readonly<{
    nowMs: () => number;
    defaultWindowMs?: number;
  }>) {
    this.defaultWindowMs = typeof deps.defaultWindowMs === 'number' && Number.isFinite(deps.defaultWindowMs) && deps.defaultWindowMs > 0
      ? Math.trunc(deps.defaultWindowMs)
      : DEFAULT_SUPPRESSION_WINDOW_MS;
  }

  markExhausted(input: AccountExhaustionWindow): void {
    const key = suppressionKey(input);
    const expiresAtMs = typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs)
      ? Math.trunc(input.resetAtMs)
      : this.deps.nowMs() + this.defaultWindowMs;
    this.records.set(key, {
      resetAtMs: typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs) ? Math.trunc(input.resetAtMs) : null,
      expiresAtMs,
    });
  }

  isSuppressed(input: AccountExhaustionWindow): boolean {
    return this.getActiveSuppression(input) !== null;
  }

  /**
   * Return the active suppression record for this account/reset-bucket, or `null`
   * when the account is not currently suppressed. Consumers use the returned
   * `resetAtMs`/`expiresAtMs` to schedule a wait-until-reset instead of looping.
   */
  getActiveSuppression(input: AccountExhaustionWindow): SuppressionRecord | null {
    const key = suppressionKey(input);
    const record = this.records.get(key);
    if (!record) return null;
    const nowMs = this.deps.nowMs();
    if (nowMs >= record.expiresAtMs) {
      this.records.delete(key);
      return null;
    }
    // A genuinely newer reset bucket is a distinct exhaustion window and must not be
    // suppressed by an older window for the same account.
    const queryResetAtMs = typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs)
      ? Math.trunc(input.resetAtMs)
      : null;
    if (
      queryResetAtMs !== null
      && record.resetAtMs !== null
      && queryResetAtMs > record.resetAtMs
    ) {
      return null;
    }
    return record;
  }

  clear(input: AccountExhaustionKey): void {
    this.records.delete(suppressionKey(input));
  }
}

/**
 * Process-wide suppression shared across per-session runtimes so that many sessions bound to
 * the same exhausted connected-service account do not each independently restart-loop. Provider
 * runtimes consult this singleton; tests construct their own instances directly.
 */
let sharedAccountExhaustionSuppression: AccountExhaustionSuppression | null = null;

export function getSharedAccountExhaustionSuppression(): AccountExhaustionSuppression {
  if (!sharedAccountExhaustionSuppression) {
    sharedAccountExhaustionSuppression = new AccountExhaustionSuppression({ nowMs: () => Date.now() });
  }
  return sharedAccountExhaustionSuppression;
}
