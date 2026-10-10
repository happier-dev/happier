import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import {
  ConnectedServiceQuotaGetResultV1Schema,
  type ConnectedServiceQuotaGetResultV1,
} from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import {
  adviseUsageBankedReset,
  projectUsagePastCycles,
  projectUsagePlans,
  resolveUsageResetStartBinding,
  summarizeUsagePlanFit,
} from './usagePlansModel';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 8, 12);
const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };

type MeterInput = Readonly<{
  meterId: string;
  label: string;
  usedPct: number | null;
  resetAtMs?: number;
  windowDurationMs?: number;
  unit?: 'count' | 'tokens';
}>;

/** Real schema-validated reads, as U3's `connectedServices.quota.get` produces them. */
function quotaRead(
  input: Readonly<{
    accountId: string;
    groupId?: string;
    planLabel?: string;
    observedAtMs?: number;
    meters: readonly MeterInput[];
    pace?: ConnectedServiceQuotaGetResultV1['pace'];
    subscription?: Readonly<{
      renewal: 'on' | 'off';
      currentPeriodEndAtMs: number;
    }>;
  }>,
): ConnectedServiceQuotaGetResultV1 {
  const recordKey = {
    providerId: 'anthropic',
    accountSubjectId: input.accountId,
    subjectKind: 'account' as const,
    quotaScope: 'account' as const,
  };
  const ref = { service, accountId: input.accountId };
  return ConnectedServiceQuotaGetResultV1Schema.parse({
    source: input.groupId
      ? { ref, bindingKind: 'group_member', groupId: input.groupId }
      : { ref, bindingKind: 'account' },
    current: {
      v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: 'anthropic',
      accountSubject: { kind: 'providerSubject', id: input.accountId },
      observedAtMs: input.observedAtMs ?? NOW - 60_000,
      fetchedAtMs: input.observedAtMs ?? NOW - 60_000,
      staleAfterMs: HOUR,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: input.planLabel ?? null,
      ...(input.subscription
        ? {
            subscription: {
              status: 'subscribed',
              observedAtMs: NOW - 60_000,
              staleAfterMs: DAY,
              ...input.subscription,
            },
          }
        : {}),
      meters: input.meters.map((meter) => ({
        meterId: meter.meterId,
        label: meter.label,
        used: null,
        limit: null,
        usedPct: meter.usedPct,
        utilizationPct: meter.usedPct,
        unit: meter.unit ?? 'count',
        status: 'ok',
        resetAtMs: meter.resetAtMs ?? null,
        resetsAt: meter.resetAtMs ?? null,
        ...(meter.windowDurationMs
          ? { windowDurationMs: meter.windowDurationMs }
          : {}),
      })),
    },
    pace: input.pace ?? [],
    targets: [],
    waitingWork: { status: 'unavailable', reason: 'unsupported' },
  });
}

describe('Plans projection of admitted allowance reads', () => {
  it('keeps each Account fact unique while showing every qualified overlapping pool and standalone account', () => {
    const reads = ['work', 'personal', 'standalone'].map(accountId => quotaRead({ accountId, meters: [] }));
    const pools = [
      { group: { service, groupId: 'first' }, memberAccountIds: ['work', 'personal'], activeAccountId: 'work', selection: { status: 'pending' as const } },
      { group: { service, groupId: 'second' }, memberAccountIds: ['work'], activeAccountId: null, selection: { status: 'unsupported' as const } },
    ];
    const projection = projectUsagePlans(reads, NOW, pools);
    expect(projection.accounts.map(account => account.accountId)).toEqual(['work', 'personal', 'standalone']);
    expect(projection.pools).toEqual([
      { key: 'happier.agent.claude/claude-subscription:first', service, groupId: 'first',
        accountKeys: ['happier.agent.claude/claude-subscription:work', 'happier.agent.claude/claude-subscription:personal'] },
      { key: 'happier.agent.claude/claude-subscription:second', service, groupId: 'second',
        accountKeys: ['happier.agent.claude/claude-subscription:work'] },
    ]);
  });
  it('shows what is left, the even-pace point and the paced projection exactly as the B pace owner derived them', () => {
    const resetAtMs = NOW + 3 * DAY;
    const read = quotaRead({
      accountId: 'max',
      planLabel: 'Max 20×',
      meters: [
        {
          meterId: 'five-hour',
          label: '5-hour',
          usedPct: 40,
          resetAtMs: NOW + 2 * HOUR,
          windowDurationMs: 5 * HOUR,
        },
        {
          meterId: 'weekly',
          label: 'Weekly',
          usedPct: 64,
          resetAtMs,
          windowDurationMs: 7 * DAY,
        },
      ],
      pace: [
        {
          meterId: 'weekly',
          value: {
            status: 'available',
            window: {
              recordId: buildProviderAccountUsageRecordId({
                providerId: 'anthropic',
                accountSubjectId: 'max',
                subjectKind: 'account',
                quotaScope: 'account',
              }),
              meterId: 'weekly',
              resetAtMs,
              windowStartAtMs: resetAtMs - 7 * DAY,
              windowDurationMs: 7 * DAY,
            },
            usedFraction: 0.64,
            elapsedFraction: 4 / 7,
            evenPaceFraction: 4 / 7,
            pace: 1.12,
            projectedResetUtilizationFraction: 1.12,
            qualification: 'estimated',
            sampleCount: 3,
            depletesAtMs: Math.round(resetAtMs - 7 * DAY + (7 * DAY) / 1.12),
            observedCurve: [],
          },
        },
      ],
    });
    const plans = projectUsagePlans([read], NOW);
    const account = plans.accounts[0]!;
    // The headline answers "this week": the account's longest comparable window.
    expect(account.headline?.meterId).toBe('weekly');
    expect(account.headline?.remainingFraction).toBeCloseTo(0.36);
    expect(account.headline?.pace?.evenPaceRemainingFraction).toBeCloseTo(
      3 / 7,
    );
    expect(account.headline?.pace?.projectedRemainingFraction).toBe(0);
    // Over-pace runs out before the reset, at the instant the owner's rate reaches the limit.
    expect(account.headline?.pace?.depletesAtMs).toBe(
      Math.round(resetAtMs - 7 * DAY + (7 * DAY) / 1.12),
    );
    const fiveHour = account.windows.find(
      (window) => window.meterId === 'five-hour',
    )!;
    expect(fiveHour.remainingFraction).toBeCloseTo(0.6);
    expect(fiveHour.pace).toBeNull();
    expect(fiveHour.paceUnavailable).toBe('not_derived');
  });

  it('never invents a projection when the pace owner refused one, and keeps an unknown meter unknown, not empty', () => {
    const read = quotaRead({
      accountId: 'pro',
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          usedPct: 10,
          resetAtMs: NOW + DAY,
          windowDurationMs: 7 * DAY,
        },
        {
          meterId: 'opus',
          label: 'Opus',
          usedPct: null,
          resetAtMs: NOW + DAY,
          windowDurationMs: 7 * DAY,
        },
      ],
      pace: [
        {
          meterId: 'weekly',
          value: { status: 'unavailable', reason: 'denominator_changed' },
        },
      ],
    });
    const account = projectUsagePlans([read], NOW).accounts[0]!;
    const weekly = account.windows.find(
      (window) => window.meterId === 'weekly',
    )!;
    expect(weekly.pace).toBeNull();
    expect(weekly.paceUnavailable).toBe('denominator_changed');
    expect(
      account.windows.find((window) => window.meterId === 'opus')!
        .remainingFraction,
    ).toBeNull();
  });

  it('keeps pool membership and display order, with no rank across pools or accounts', () => {
    const reads = [
      quotaRead({
        accountId: 'b',
        groupId: 'claude-pool',
        meters: [{ meterId: 'w', label: 'Weekly', usedPct: 90 }],
      }),
      quotaRead({
        accountId: 'solo',
        meters: [{ meterId: 'w', label: 'Weekly', usedPct: 5 }],
      }),
      quotaRead({
        accountId: 'a',
        groupId: 'claude-pool',
        meters: [{ meterId: 'w', label: 'Weekly', usedPct: 20 }],
      }),
    ];
    const plans = projectUsagePlans(reads, NOW);
    expect(plans.accounts.map((account) => account.accountId)).toEqual([
      'b',
      'solo',
      'a',
    ]);
    expect(plans.pools).toHaveLength(1);
    expect(plans.pools[0]!.accountKeys).toEqual([
      plans.accounts[0]!.key,
      plans.accounts[2]!.key,
    ]);
    expect(plans.tightest?.account.accountId).toBe('b');
  });

  it('marks a read past its freshness window stale instead of presenting it as current', () => {
    const read = quotaRead({
      accountId: 'old',
      observedAtMs: NOW - 2 * HOUR,
      meters: [{ meterId: 'w', label: 'Weekly', usedPct: 50 }],
    });
    expect(projectUsagePlans([read], NOW).accounts[0]!.stale).toBe(true);
  });

  it('lists every known reset, renewal and ending in time order without a horizon of its own', () => {
    const read = quotaRead({
      accountId: 'pro',
      planLabel: 'Claude Pro',
      meters: [
        {
          meterId: 'w',
          label: 'Weekly',
          usedPct: 50,
          resetAtMs: NOW + 5 * DAY,
          windowDurationMs: 7 * DAY,
        },
        {
          meterId: 'h',
          label: '5-hour',
          usedPct: 50,
          resetAtMs: NOW + HOUR,
          windowDurationMs: 5 * HOUR,
        },
      ],
      subscription: { renewal: 'off', currentPeriodEndAtMs: NOW + 30 * DAY },
    });
    const events = projectUsagePlans([read], NOW).events;
    expect(events.map((event) => [event.kind, event.atMs - NOW])).toEqual([
      ['reset', HOUR],
      ['reset', 5 * DAY],
      ['ends', 30 * DAY],
    ]);
  });
});

describe('Plans detail projections', () => {
  const weekly = { meterId: 'weekly', label: 'Weekly', usedPct: 40, resetAtMs: NOW + 2 * DAY, windowDurationMs: 7 * DAY };
  const base = quotaRead({ accountId: 'work', planLabel: 'Max', meters: [weekly] });
  const recordId = base.current!.recordId;
  const ended = (weeksAgo: number, unusedFraction: number | null) => ({
    window: { recordId, meterId: 'weekly', resetAtMs: NOW + 2 * DAY - weeksAgo * 7 * DAY,
      windowStartAtMs: NOW + 2 * DAY - (weeksAgo + 1) * 7 * DAY, windowDurationMs: 7 * DAY },
    value: unusedFraction === null
      ? { status: 'insufficient_basis' as const, reason: 'no_terminal_observation' }
      : { status: 'available' as const, unusedAmount: unusedFraction * 100, unusedFraction, unit: 'percent',
          observedAtMs: NOW - weeksAgo * 7 * DAY, sampleCount: 4, qualification: 'confirmed' as const, method: 'terminal_observation' as const },
  });
  const withHistory = (read: ConnectedServiceQuotaGetResultV1, fractions: readonly (number | null)[]) =>
    ConnectedServiceQuotaGetResultV1Schema.parse({ ...read,
      unusedCapacity: { historyStatus: 'returned_page', windows: fractions.map((fraction, index) => ended(index + 1, fraction)) } });
  const accountOf = (read: ConnectedServiceQuotaGetResultV1) => projectUsagePlans([read], NOW).accounts[0]!;

  it('reads each ended window as its recorded used share and keeps an unmeasured one as its reason', () => {
    const cycles = projectUsagePastCycles(accountOf(withHistory(base, [0.2, null])), 'weekly');
    expect(cycles.cycles.map((cycle) => cycle.value.status === 'available' ? cycle.value.usedFraction : cycle.value.reason))
      .toEqual([0.8, 'no_terminal_observation']);
    expect(projectUsagePastCycles(accountOf(base), 'weekly')).toMatchObject({ cycles: [], reason: 'not_loaded' });
  });

  it('counts plan fit only over witnessed ended windows and shows the count it used', () => {
    const fit = summarizeUsagePlanFit(accountOf(withHistory(base, [0, 0.5, 0.1, null])), 0.8);
    expect(fit).toMatchObject({ observed: 3, usedUp: 1, leftUnused: 2, aboveTarget: 2 });
    expect(summarizeUsagePlanFit(accountOf(withHistory(base, [0.5])), null).aboveTarget).toBeNull();
    expect(summarizeUsagePlanFit(accountOf(base), 0.8).observed).toBe(0);
  });

  it('binds a reset start to the latest accepted entry of the current record, or says why it cannot', () => {
    expect(resolveUsageResetStartBinding(accountOf(base), 'weekly')).toEqual({ status: 'unavailable', reason: 'no_witness' });
    const other = quotaRead({ accountId: 'other', meters: [weekly] });
    const read = ConnectedServiceQuotaGetResultV1Schema.parse({ ...base, history: { nextCursor: null, entries: [
      { id: 'old', observedAtMs: NOW - 3 * HOUR, snapshot: base.current },
      { id: 'latest', observedAtMs: NOW - HOUR, snapshot: base.current },
      { id: 'foreign', observedAtMs: NOW - 60_000, snapshot: other.current },
    ] } });
    expect(resolveUsageResetStartBinding(accountOf(read), 'weekly')).toEqual({ status: 'available',
      reset: { source: read.source, recordId, meterId: 'weekly', witness: { id: 'latest', observedAtMs: NOW - HOUR } } });
    expect(resolveUsageResetStartBinding(accountOf(read), 'missing')).toEqual({ status: 'unavailable', reason: 'no_reset' });
  });

  it('advises a banked reset only by comparing its expiry with the natural reset it would replace', () => {
    const credits = (expiresAtMs: number | null) => ConnectedServiceQuotaGetResultV1Schema.parse({ ...base,
      current: { ...base.current!, recoveryCredits: { availableCount: 1, nextExpiresAtMs: expiresAtMs,
        credits: [{ kind: 'usage_limit_reset', status: 'available', expiresAtMs }] } } });
    expect(adviseUsageBankedReset(accountOf(credits(NOW + DAY)))).toMatchObject({ kind: 'expires_before_reset', resetAtMs: NOW + 2 * DAY });
    expect(adviseUsageBankedReset(accountOf(credits(NOW + 5 * DAY)))).toMatchObject({ kind: 'outlasts_reset' });
    expect(adviseUsageBankedReset(accountOf(credits(null)))).toBeNull();
  });
});
