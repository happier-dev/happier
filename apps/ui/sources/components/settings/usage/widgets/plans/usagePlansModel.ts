import type { ConnectedServiceQuotaGetResultV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import {
  deriveProviderAccountUsageEarlierWindowCurves,
  type ProviderAccountUsageEarlierWindowCurvesV1,
  type ProviderAccountUsagePaceV1,
} from '@happier-dev/protocol/connect/deriveProviderAccountUsagePace';
import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';
import { projectUsageScheduledEvents } from '@happier-dev/protocol/usage/usageCalendarExport';
import type { UsageQueryPoolSnapshot } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { PendingResetStartBindingV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { MeterTone } from '@/components/ui/lists/MeterBar';
import { deriveQuotaUtilizationPct } from '@/sync/domains/connectedServices/deriveQuotaUtilizationPct';
import { resolveQuotaMeterTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { isConnectedServiceQuotaMeterPercentRankable } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { projectProviderAccountSubscriptionMonetaryFacts } from '@happier-dev/protocol/connect/accountSubscription';

type QuotaRead = ConnectedServiceQuotaGetResultV1;
type Snapshot = NonNullable<QuotaRead['current']>;
type UnavailableReason = Extract<
  ProviderAccountUsagePaceV1,
  { status: 'unavailable' }
>['reason'];

/** The B pace owner's numbers in the meter's own "what is left" axis; nothing is re-derived here. */
export type UsagePlanPace = Readonly<{
  /** Where an even pace through the window would leave it now (1 − elapsed fraction). */
  evenPaceRemainingFraction: number;
  /** What this pace leaves at the reset; 0 when it runs out first. */
  projectedRemainingFraction: number;
  projectedUsedFraction: number;
  /** When this pace reaches the limit, only when that is before the reset. */
  depletesAtMs: number | null;
  observedCurve: NonNullable<Extract<ProviderAccountUsagePaceV1, { status: 'available' }>['observedCurve']>;
  qualification: 'confirmed' | 'estimated';
  sampleCount: number;
  empiricalRange: Readonly<{ min: number; max: number }> | null;
  windowStartAtMs: number;
}>;

export type UsagePlanWindow = Readonly<{
  key: string;
  meterId: string;
  label: string;
  /** 0–1 of the window still available; null when the provider reported no comparable value. */
  remainingFraction: number | null;
  resetAtMs: number | null;
  windowDurationMs: number | null;
  tone: MeterTone;
  estimated: boolean;
  /** Only a percent-rankable meter (usage/rate limit) can be compared across accounts. */
  comparable: boolean;
  pace: UsagePlanPace | null;
  /** The owner's reason, or `not_derived` when the read carries no pace for this meter. */
  paceUnavailable: UnavailableReason | 'not_derived' | null;
}>;

export type UsagePlanAccount = Readonly<{
  key: string;
  read: QuotaRead;
  service: QuotaRead['source']['ref']['service'];
  accountId: string;
  groupId: string | null;
  planLabel: string | null;
  accountLabel: string | null;
  windows: readonly UsagePlanWindow[];
  /** The longest comparable window: "this week" in the lab's every-plan question. */
  headline: UsagePlanWindow | null;
  stale: boolean;
  observedAtMs: number | null;
  subscription: Snapshot['subscription'] | null;
  prices: ReturnType<typeof projectProviderAccountSubscriptionMonetaryFacts>;
  recoveryCredits: Snapshot['recoveryCredits'] | null;
}>;

export type UsagePlanPool = Readonly<{
  key: string;
  service: UsagePlanAccount['service'];
  groupId: string;
  accountKeys: readonly string[];
}>;

export type UsagePlanEvent = Readonly<{
  key: string;
  accountKey: string;
  kind: 'reset' | 'renews' | 'ends' | 'credit_expires';
  atMs: number;
  /** The window's name for a reset; absent for account-level facts. */
  label?: string;
  window?: UsagePlanWindow;
}>;

export type UsagePlansProjection = Readonly<{
  accounts: readonly UsagePlanAccount[];
  pools: readonly UsagePlanPool[];
  /** The least room left among the accounts' headline windows. A fact, not a rank or a weighting. */
  tightest: Readonly<{
    account: UsagePlanAccount;
    window: UsagePlanWindow;
  }> | null;
  events: readonly UsagePlanEvent[];
}>;

const serviceKey = (service: UsagePlanAccount['service']) =>
  `${service.pluginId}/${service.localId}`;

function readPace(
  value: ProviderAccountUsagePaceV1 | undefined,
): Pick<UsagePlanWindow, 'pace' | 'paceUnavailable'> {
  if (!value) return { pace: null, paceUnavailable: 'not_derived' };
  if (value.status === 'unavailable')
    return { pace: null, paceUnavailable: value.reason };
  const { window } = value;
  const projected = value.projectedResetUtilizationFraction;
  return {
    paceUnavailable: null,
    pace: {
      evenPaceRemainingFraction: Math.max(0, 1 - value.evenPaceFraction),
      projectedRemainingFraction: Math.max(0, 1 - projected),
      projectedUsedFraction: projected,
      depletesAtMs: value.depletesAtMs ?? null,
      observedCurve: value.observedCurve ?? [],
      qualification: value.qualification,
      sampleCount: value.sampleCount,
      empiricalRange: value.empiricalRange ?? null,
      windowStartAtMs: window.windowStartAtMs,
    },
  };
}

function projectWindow(
  accountKey: string,
  meter: ConnectedServiceQuotaMeterV1,
  pace: ProviderAccountUsagePaceV1 | undefined,
): UsagePlanWindow {
  const used = deriveQuotaUtilizationPct(meter);
  const remainingPct = used === null ? null : 100 - used;
  return {
    key: `${accountKey}:${meter.meterId}`,
    meterId: meter.meterId,
    label: meter.label,
    remainingFraction: remainingPct === null ? null : remainingPct / 100,
    resetAtMs: meter.resetAtMs ?? meter.resetsAt ?? null,
    windowDurationMs: meter.windowDurationMs ?? null,
    tone: resolveQuotaMeterTone({ remainingPct, status: meter.status }),
    estimated: meter.status === 'estimated',
    comparable: isConnectedServiceQuotaMeterPercentRankable(meter),
    ...readPace(pace),
  };
}

function pickHeadline(
  windows: readonly UsagePlanWindow[],
): UsagePlanWindow | null {
  let best: UsagePlanWindow | null = null;
  for (const window of windows) {
    if (!window.comparable || window.remainingFraction === null) continue;
    if (!best) {
      best = window;
      continue;
    }
    const duration = window.windowDurationMs ?? -1;
    const bestDuration = best.windowDurationMs ?? -1;
    if (
      duration > bestDuration ||
      (duration === bestDuration &&
        window.remainingFraction < best.remainingFraction!)
    )
      best = window;
  }
  return best;
}

/**
 * Projects admitted `connectedServices.quota.get` reads for the Plans bodies. The read order is the
 * Account's own connected-account order; pools keep their members in that order. Nothing here ranks
 * accounts, weights plans or recomputes a pace.
 */
export function projectUsagePlans(
  quota: readonly QuotaRead[] | undefined,
  nowMs: number,
  memberships?: readonly UsageQueryPoolSnapshot[],
): UsagePlansProjection {
  const accounts: UsagePlanAccount[] = [];
  const pools = new Map<
    string,
    {
      key: string;
      service: UsagePlanAccount['service'];
      groupId: string;
      accountKeys: string[];
    }
  >();
  const events: UsagePlanEvent[] = [];
  for (const read of quota ?? []) {
    const ref = read.source.ref;
    const groupId =
      read.source.bindingKind === 'group_member' ? read.source.groupId : null;
    const key = `${serviceKey(ref.service)}:${ref.accountId}`;
    if (accounts.some((account) => account.key === key)) continue;
    const snapshot = read.current;
    const paceByMeter = new Map(
      read.pace.map((entry) => [entry.meterId, entry.value]),
    );
    const windows = (snapshot?.meters ?? []).map((meter) =>
      projectWindow(key, meter, paceByMeter.get(meter.meterId)),
    );
    const account: UsagePlanAccount = {
      key,
      read,
      service: ref.service,
      accountId: ref.accountId,
      groupId,
      planLabel: snapshot?.planLabel ?? null,
      accountLabel: snapshot?.accountLabel ?? null,
      windows,
      headline: pickHeadline(windows),
      stale:
        !snapshot ||
        snapshot.state !== 'loaded_data' ||
        nowMs >= snapshot.observedAtMs + snapshot.staleAfterMs,
      observedAtMs: snapshot?.observedAtMs ?? null,
      subscription: snapshot?.subscription ?? null,
      prices: projectProviderAccountSubscriptionMonetaryFacts({ subscription: snapshot?.subscription, nowMs, tier: snapshot?.planLabel }),
      recoveryCredits: snapshot?.recoveryCredits ?? null,
    };
    accounts.push(account);
    if (groupId) {
      const poolKey = `${serviceKey(ref.service)}:${groupId}`;
      const pool = pools.get(poolKey) ?? {
        key: poolKey,
        service: ref.service,
        groupId,
        accountKeys: [],
      };
      pool.accountKeys.push(key);
      pools.set(poolKey, pool);
    }
    for (const event of projectUsageScheduledEvents([read])) {
      if (event.atMs <= nowMs) continue;
      const window = event.kind === 'reset' ? windows.find(window => window.meterId === event.meterId) : undefined;
      events.push({ key: event.key, accountKey: key, atMs: event.atMs,
        kind: event.kind === 'renewal' ? 'renews' : event.kind === 'ending' ? 'ends' : event.kind === 'credit_expiry' ? 'credit_expires' : 'reset',
        ...(event.label ? { label: event.label } : {}), ...(window ? { window } : {}) });
    }
  }
  let tightest: UsagePlansProjection['tightest'] = null;
  for (const account of accounts) {
    const window = account.headline;
    if (window?.remainingFraction == null) continue;
    if (
      !tightest ||
      window.remainingFraction < tightest.window.remainingFraction!
    )
      tightest = { account, window };
  }
  events.sort(
    (left, right) =>
      left.atMs - right.atMs || left.key.localeCompare(right.key),
  );
  const qualifiedPools = memberships?.map(pool => ({
    key: `${serviceKey(pool.group.service)}:${pool.group.groupId}`,
    service: pool.group.service, groupId: pool.group.groupId,
    accountKeys: pool.memberAccountIds.map(accountId => `${serviceKey(pool.group.service)}:${accountId}`)
      .filter(key => accounts.some(account => account.key === key)),
  }));
  return { accounts, pools: qualifiedPools ?? [...pools.values()], tightest, events };
}

/** Every window the B pace owner derived a pace for, in the Account's own order. */
export function selectUsagePacedWindows(
  accounts: readonly UsagePlanAccount[],
): ReadonlyArray<Readonly<{ account: UsagePlanAccount; window: UsagePlanWindow }>> {
  return accounts.flatMap((account) =>
    account.windows.filter((window) => window.pace !== null).map((window) => ({ account, window })),
  );
}

export type UsagePlanPastCycle = Readonly<{
  key: string;
  meterId: string;
  /** The current window of the same meter names it; an ended meter the read no longer lists has none. */
  label: string | null;
  resetAtMs: number;
  value:
    | Readonly<{
        status: 'available';
        /** 1 − the recorded unused fraction: the same row said the other way round. */
        usedFraction: number;
        unusedFraction: number;
        unusedAmount: number;
        unit: string;
        qualification: 'confirmed' | 'estimated';
        method: 'terminal_observation' | 'linear_pace_at_last_observation';
        sampleCount: number;
      }>
    | Readonly<{ status: 'insufficient'; reason: string }>;
}>;

export type UsagePlanPastCycles = Readonly<{
  cycles: readonly UsagePlanPastCycle[];
  /** Why there are no rows; null when the read returned some. */
  reason: 'not_loaded' | 'unavailable' | 'none_ended' | null;
  /** The read returned one page of a longer history. */
  partial: boolean;
}>;

/** The B owner's ended windows for one account (optionally one meter), newest first. Rows only; nothing is averaged. */
export function projectUsagePastCycles(account: UsagePlanAccount, meterId?: string): UsagePlanPastCycles {
  const history = account.read.unusedCapacity;
  if (!history || history.historyStatus === 'not_loaded') return { cycles: [], reason: 'not_loaded', partial: false };
  if (history.historyStatus === 'unavailable') return { cycles: [], reason: 'unavailable', partial: false };
  const cycles = history.windows
    .filter((entry) => meterId === undefined || entry.window.meterId === meterId)
    .map((entry): UsagePlanPastCycle => ({
      key: `${account.key}:${entry.window.meterId}:${entry.window.resetAtMs}`,
      meterId: entry.window.meterId,
      label: account.windows.find((window) => window.meterId === entry.window.meterId)?.label ?? null,
      resetAtMs: entry.window.resetAtMs,
      value: entry.value.status === 'available'
        ? {
            status: 'available',
            usedFraction: 1 - entry.value.unusedFraction,
            unusedFraction: entry.value.unusedFraction,
            unusedAmount: entry.value.unusedAmount,
            unit: entry.value.unit,
            qualification: entry.value.qualification,
            method: entry.value.method,
            sampleCount: entry.value.sampleCount,
          }
        : { status: 'insufficient', reason: entry.value.reason },
    }))
    .sort((left, right) => right.resetAtMs - left.resetAtMs);
  return { cycles, reason: cycles.length === 0 ? 'none_ended' : null, partial: history.historyStatus === 'partial' };
}

export type UsagePlanFit = Readonly<{
  /** The window the counts are about: the plan's headline window when it has one. */
  window: UsagePlanWindow | null;
  /** Ended windows with a recorded result. Every other number is a count of these rows. */
  observed: number;
  usedUp: number;
  leftUnused: number;
  /** Ended above the viewer's own target; null when they set none. */
  aboveTarget: number | null;
  reason: UsagePlanPastCycles['reason'];
  partial: boolean;
}>;

/** Plain counts of witnessed ended windows; no score, threshold or average is made here. */
export function summarizeUsagePlanFit(account: UsagePlanAccount, targetFraction: number | null): UsagePlanFit {
  const window = account.headline;
  const past = projectUsagePastCycles(account, window?.meterId);
  const measured = past.cycles.flatMap((cycle) => (cycle.value.status === 'available' ? [cycle.value] : []));
  return {
    window,
    observed: measured.length,
    usedUp: measured.filter((value) => value.unusedFraction === 0).length,
    leftUnused: measured.filter((value) => value.unusedFraction > 0).length,
    aboveTarget: targetFraction === null ? null : measured.filter((value) => value.usedFraction > targetFraction).length,
    reason: measured.length === 0 ? (past.reason ?? 'none_ended') : null,
    partial: past.partial,
  };
}

export type UsageResetStartBinding =
  | Readonly<{ status: 'available'; reset: PendingResetStartBindingV1 }>
  | Readonly<{ status: 'unavailable'; reason: 'no_reading' | 'no_reset' | 'no_witness' }>;

/**
 * The pending owner's reset binding for one window: the read's own source and record, witnessed by the
 * latest accepted history entry of that record. Without such an entry there is nothing to bind to.
 */
export function resolveUsageResetStartBinding(account: UsagePlanAccount, meterId: string): UsageResetStartBinding {
  const current = account.read.current;
  if (!current) return { status: 'unavailable', reason: 'no_reading' };
  const window = account.windows.find((candidate) => candidate.meterId === meterId);
  if (!window || window.resetAtMs === null) return { status: 'unavailable', reason: 'no_reset' };
  let witness: Readonly<{ id: string; observedAtMs: number }> | null = null;
  for (const entry of account.read.history?.entries ?? []) {
    if (entry.snapshot.recordId !== current.recordId) continue;
    if (!witness || entry.observedAtMs > witness.observedAtMs) witness = { id: entry.id, observedAtMs: entry.observedAtMs };
  }
  if (!witness) return { status: 'unavailable', reason: 'no_witness' };
  return { status: 'available', reset: { source: account.read.source, recordId: current.recordId, meterId, witness } };
}

export type UsageBankedResetAdvice = Readonly<{
  kind: 'expires_before_reset' | 'outlasts_reset';
  expiresAtMs: number;
  resetAtMs: number;
  window: UsagePlanWindow;
}>;

/**
 * Two shown facts side by side: when the next banked reset expires and when the window it applies to
 * (the provider limit it names, else the plan's headline window) resets on its own.
 */
export function adviseUsageBankedReset(account: UsagePlanAccount): UsageBankedResetAdvice | null {
  const credits = account.recoveryCredits;
  const expiresAtMs = credits?.nextExpiresAtMs ?? null;
  if (!credits || credits.availableCount === 0 || expiresAtMs === null) return null;
  const limitId = credits.credits.find((credit) => credit.status === 'available' && credit.expiresAtMs === expiresAtMs)
    ?.appliesToProviderLimitId ?? null;
  const namedMeterIds = limitId === null ? [] : (account.read.current?.meters ?? [])
    .filter((meter) => meter.providerLimitId === limitId).map((meter) => meter.meterId);
  const window = account.windows.find((candidate) => namedMeterIds.includes(candidate.meterId) && candidate.resetAtMs !== null)
    ?? account.headline;
  if (!window || window.resetAtMs === null) return null;
  return { kind: expiresAtMs < window.resetAtMs ? 'expires_before_reset' : 'outlasts_reset', expiresAtMs, resetAtMs: window.resetAtMs, window };
}

/**
 * Earlier ended windows of one meter as curves, from the read's own accepted history. The pace owner
 * decides which earlier windows are comparable; this only hands it the read's snapshots.
 */
export function projectUsageEarlierCurves(account: UsagePlanAccount, meterId: string): ProviderAccountUsageEarlierWindowCurvesV1 {
  const current = account.read.current;
  if (!current) return { status: 'unavailable', reason: 'unknown_window' };
  const history = account.read.history?.entries.map((entry) => entry.snapshot);
  return deriveProviderAccountUsageEarlierWindowCurves({ current, meterId, ...(history ? { history } : {}) });
}
