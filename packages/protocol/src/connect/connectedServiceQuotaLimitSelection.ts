import type {
  ConnectedServiceAuthGroupQuotaLimitSelectionV1,
  ConnectedServiceQuotaMeterV1,
} from './connectedServiceSchemas.js';

function readQuotaLimitIdentity(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Resolves the stable allowance identity shared by policy authoring and enforcement. */
export function resolveConnectedServiceQuotaMeterLimitIdentity(
  meter: ConnectedServiceQuotaMeterV1,
): string {
  return readQuotaLimitIdentity(meter.providerLimitId) ?? meter.meterId;
}

/**
 * Provider credits are a pay-as-you-go balance the provider spends only once the included
 * allowances are used up (Codex `credits`, Claude `extra_usage`). They are classified from existing
 * fields so released readers need no new enum value: a `unit: 'credits'` meter that no adapter
 * categorized as an allowance (`details.limitCategory`). A credit meter is never an included
 * allowance: pools rank accounts by included limits first and treat credits as the fallback that
 * keeps an account usable.
 */
export function isConnectedServiceQuotaCreditMeter(
  meter: Pick<ConnectedServiceQuotaMeterV1, 'unit' | 'details'>,
): boolean {
  return meter.unit === 'credits' && meter.details?.limitCategory === undefined;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Whether a credit meter shows the provider will still bill requests to credits. An explicit
 * provider verdict (`isExhausted`) wins; then the remaining share of a capped spend limit; then a
 * remaining balance. A meter that only says "not exhausted" (unlimited credits) has headroom.
 */
export function hasConnectedServiceQuotaCreditHeadroom(meter: ConnectedServiceQuotaMeterV1): boolean {
  if (!isConnectedServiceQuotaCreditMeter(meter) || meter.status === 'unavailable') return false;
  if (meter.isExhausted === true) return false;
  const utilizationPct = finiteOrNull(meter.utilizationPct);
  const remainingPct = finiteOrNull(meter.remainingPct) ?? (utilizationPct === null ? null : 100 - utilizationPct);
  if (remainingPct !== null) return remainingPct > 0;
  const remaining = finiteOrNull(meter.remaining);
  if (remaining !== null) return remaining > 0;
  return meter.isExhausted === false;
}

export type ConnectedServiceQuotaCreditSummary = Readonly<{
  /** True when any credit meter still has headroom. */
  available: boolean;
  /** Remaining credit balance when the provider reports one (Codex). */
  balance: number | null;
}>;

/** One summary of an account's provider credits; null when the account reports none. */
export function summarizeConnectedServiceQuotaCredits(
  meters: readonly ConnectedServiceQuotaMeterV1[],
): ConnectedServiceQuotaCreditSummary | null {
  const creditMeters = meters.filter(isConnectedServiceQuotaCreditMeter);
  if (creditMeters.length === 0) return null;
  const balances = creditMeters
    .map((meter) => finiteOrNull(meter.remaining))
    .filter((value): value is number => value !== null);
  return {
    available: creditMeters.some(hasConnectedServiceQuotaCreditHeadroom),
    balance: balances.length > 0 ? balances.reduce((total, value) => total + value, 0) : null,
  };
}

/**
 * Applies a pool's allowance selection to provider quota meters.
 *
 * `meterId` remains the compatibility identity for providers which predate
 * `providerLimitId`; multi-allowance providers preserve `providerLimitId`.
 * Credit meters are account-wide spend, not a selectable allowance, so every
 * selection keeps them.
 */
export function selectConnectedServiceQuotaMetersForLimitSelection(
  meters: readonly ConnectedServiceQuotaMeterV1[],
  selection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1,
): readonly ConnectedServiceQuotaMeterV1[] {
  if (!selection || selection.mode === 'all') return meters;
  const selectedIds = new Set(selection.providerLimitIds);
  return meters.filter((meter) => isConnectedServiceQuotaCreditMeter(meter) || selectedIds.has(
    resolveConnectedServiceQuotaMeterLimitIdentity(meter),
  ));
}
