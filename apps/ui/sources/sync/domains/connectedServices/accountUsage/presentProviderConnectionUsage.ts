import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { resolveQuotaMeterTone } from '@happier-dev/protocol/connect/accountHealth';
import type { ProviderUsageSourceV1 } from '@happier-dev/protocol/providers/contributions';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import { deriveQuotaMeterValues } from '../deriveQuotaUtilizationPct';
import type { ProviderConnectionUsageRefreshView } from './providerConnectionUsageRefreshResource';

/**
 * Whose money a meter describes. A source read with the connection's own key reports that key unless the
 * provider marks the meter as account-wide; a source read with a separate billing key is the account's.
 */
export type ProviderUsageScope = 'key' | 'account';

/** What the provider reported, never a figure the UI derived a cap or a balance for. */
export type ProviderUsageAmount =
  | Readonly<{ kind: 'remainingOfLimit'; remaining: number; limit: number }>
  | Readonly<{ kind: 'remaining'; remaining: number }>
  | Readonly<{ kind: 'used'; used: number }>;

export type ProviderUsageMeterPresentation = Readonly<{
  meterId: string;
  label: string;
  unit: ConnectedServiceQuotaMeterV1['unit'];
  currency?: ConnectedServiceQuotaMeterV1['currency'];
  /** Null when the provider reported no amount: it reads as unknown, never as zero. */
  amount: ProviderUsageAmount | null;
  /** What is left of the provider's own cap; null without one, so no bar is drawn. */
  remainingPct: number | null;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  estimated: boolean;
}>;

export type ProviderUsageGroupPresentation = Readonly<{
  scope: ProviderUsageScope;
  meters: readonly ProviderUsageMeterPresentation[];
}>;

/** One optional billing key a usage source asks for, as its declaration names it. */
export type ProviderUsageBillingSlot = Readonly<{
  slotId: string;
  title: string | null;
  keyUrl: string | null;
  bound: boolean;
}>;

export type ProviderUsageSourceError = Readonly<{
  sourceId: string;
  scope: ProviderUsageScope;
  /** The billing key slot this source reads with; null when it reads with the connection's own key. */
  billingSlotId: string | null;
  error: ProviderErrorV1;
  /** The source's last good figures are still shown beside the failure. */
  lastGood: boolean;
}>;

export type ProviderConnectionUsagePresentation = Readonly<{
  groups: readonly ProviderUsageGroupPresentation[];
  billingSlots: readonly ProviderUsageBillingSlot[];
  /** A refresh has answered at least once in this page's lifetime. */
  checked: boolean;
  /** The oldest displayed source snapshot, so retained facts never claim a newer read. */
  fetchedAt: number | null;
  sourceErrors: readonly ProviderUsageSourceError[];
  connectionError: ProviderErrorV1 | null;
  unsupported: boolean;
}>;

const ACCOUNT_LIMIT_SCOPES = new Set<
  NonNullable<ConnectedServiceQuotaMeterV1['limitScope']>
>(['account', 'workspace', 'organization']);

/** The source's compact fact: account balance first, then a key allowance, then reported usage. */
export function selectProviderConnectionUsageSummaryMeter(
  presentation: Pick<ProviderConnectionUsagePresentation, 'groups'>,
): ProviderUsageMeterPresentation | null {
  const account = presentation.groups.find(group => group.scope === 'account');
  const key = presentation.groups.find(group => group.scope === 'key');
  const hasRemaining = (meter: ProviderUsageMeterPresentation) =>
    meter.amount !== null && meter.amount.kind !== 'used';
  return account?.meters.find(hasRemaining) ?? key?.meters.find(hasRemaining)
    ?? account?.meters[0] ?? key?.meters[0] ?? null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function presentAmount(
  meter: ConnectedServiceQuotaMeterV1,
): ProviderUsageAmount | null {
  if (meter.status === 'unavailable') return null;
  const used = finite(meter.used);
  const limit = finite(meter.limit);
  const remaining =
    finite(meter.remaining) ??
    (limit !== null && used !== null ? limit - used : null);
  if (limit !== null && remaining !== null)
    return { kind: 'remainingOfLimit', remaining, limit };
  // A reported negative balance stays negative: it is what the provider will bill against.
  if (remaining !== null) return { kind: 'remaining', remaining };
  if (used !== null) return { kind: 'used', used };
  return null;
}

function presentMeter(
  meter: ConnectedServiceQuotaMeterV1,
): ProviderUsageMeterPresentation {
  const amount = presentAmount(meter);
  const { remainingPct } = deriveQuotaMeterValues(meter);
  const overdrawn =
    amount !== null && amount.kind !== 'used' && amount.remaining < 0;
  return {
    meterId: meter.meterId,
    label: meter.label,
    unit: meter.unit,
    ...(meter.currency ? { currency: meter.currency } : {}),
    amount,
    remainingPct,
    tone: overdrawn
      ? 'danger'
      : resolveQuotaMeterTone({ remainingPct, status: meter.status }),
    estimated: meter.status === 'estimated',
  };
}

function scopeOf(
  source: ProviderUsageSourceV1,
  meter: ConnectedServiceQuotaMeterV1,
): ProviderUsageScope {
  return source.billingCredential ||
    (meter.limitScope && ACCOUNT_LIMIT_SCOPES.has(meter.limitScope))
    ? 'account'
    : 'key';
}

/**
 * The Provider connection's Usage section: the declared usage sources' last refresh as amounts grouped by
 * whose money they describe, plus the billing keys those sources ask for. A source whose billing key is not
 * bound contributes no figures and no failure: without that key there is nothing to read.
 */
export function presentProviderConnectionUsage(
  input: Readonly<{
    sources: readonly ProviderUsageSourceV1[];
    isBillingSlotBound: (slotId: string) => boolean;
    view: ProviderConnectionUsageRefreshView | null;
  }>,
): ProviderConnectionUsagePresentation {
  const billingSlots: ProviderUsageBillingSlot[] = [];
  for (const source of input.sources) {
    const billing = source.billingCredential;
    if (!billing || billingSlots.some((slot) => slot.slotId === billing.slotId))
      continue;
    billingSlots.push({
      slotId: billing.slotId,
      title: billing.title ?? null,
      keyUrl: billing.keyUrl ?? null,
      bound: input.isBillingSlotBound(billing.slotId),
    });
  }
  const unbound = (source: ProviderUsageSourceV1) =>
    Boolean(source.billingCredential) &&
    !input.isBillingSlotBound(source.billingCredential!.slotId);
  const result = input.view?.result ?? null;
  const byScope: Record<ProviderUsageScope, ProviderUsageMeterPresentation[]> =
    { key: [], account: [] };
  const sourceErrors: ProviderUsageSourceError[] = [];
  let fetchedAt: number | null = null;
  if (result) {
    for (const source of input.sources) {
      if (unbound(source)) continue;
      const snapshot = input.view?.snapshotsBySourceId[source.id];
      if (snapshot) {
        if (snapshot.meters.length > 0)
          fetchedAt = Math.min(fetchedAt ?? snapshot.fetchedAtMs, snapshot.fetchedAtMs);
        for (const meter of snapshot.meters)
          byScope[scopeOf(source, meter)].push(presentMeter(meter));
      }
      const outcome = result.status === 'success' ? result.sources.find(
        (candidate) => candidate.sourceId === source.id,
      ) : undefined;
      if (outcome?.status === 'error') {
        sourceErrors.push({
          sourceId: source.id,
          scope: source.billingCredential ? 'account' : 'key',
          billingSlotId: source.billingCredential?.slotId ?? null,
          error: outcome.error,
          lastGood: Boolean(snapshot),
        });
      }
    }
  }
  return {
    groups: (['key', 'account'] as const).flatMap((scope) =>
      byScope[scope].length > 0 ? [{ scope, meters: byScope[scope] }] : [],
    ),
    billingSlots,
    checked: result !== null,
    fetchedAt,
    sourceErrors,
    connectionError: result?.status === 'error' ? result.error : null,
    unsupported: result?.status === 'not_supported',
  };
}
