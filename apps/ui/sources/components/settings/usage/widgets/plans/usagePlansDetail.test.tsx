import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getPreferredLanguage, preloadTranslationsForSettings, setPreferredLanguageFromSettings } from '@/text';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import {
  ConnectedServiceQuotaGetResultV1Schema,
  type ConnectedServiceQuotaGetResultV1,
} from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { BurnUpChart } from '@happier-dev/plugin-ui/presentation';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { storage } from '@/sync/domains/state/storageStore';
import {
  getAppliedActiveServerSnapshot,
  isAppliedActiveServerRuntimeAvailable,
  publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import type { UsageWidgetBodyModel } from '../../useUsageWidgetResource';

// The Action front door is the network/daemon boundary; everything beneath the bodies stays real.
const execute = vi.hoisted(() => vi.fn());
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
    >()),
    createFrontDoorActionExecute: () => execute,
  }),
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
// The portal cannot position against a real window in the host renderer; the open leaf stays real.
vi.mock('@/components/ui/popover/Popover', () => ({
  Popover: (props: {
    open: boolean;
    children: (render: {
      maxHeight: number;
      maxWidth: number;
    }) => React.ReactNode;
  }) => (props.open ? props.children({ maxHeight: 480, maxWidth: 360 }) : null),
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const service = {
  pluginId: 'happier.agent.claude',
  localId: 'claude-subscription',
};
const query = normalizeUsageQuery({});

let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(() => {
  previousSnapshot = getAppliedActiveServerSnapshot();
  previousAvailable = isAppliedActiveServerRuntimeAvailable();
});
afterEach(async () => {
  standardCleanup();
  execute.mockReset();
  (
    await import('@/sync/domains/scope/activeServerAccountScope')
  ).retireActiveServerAccountScopeLifetime();
  publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
});

type Meter = Readonly<{
  meterId: string;
  label: string;
  usedPct: number;
  resetAtMs: number;
  windowDurationMs: number;
}>;

function quotaRead(
  accountId: string,
  now: number,
  meters: readonly Meter[],
  extra: Record<string, unknown> = {},
  current: Record<string, unknown> = {},
): ConnectedServiceQuotaGetResultV1 {
  const recordKey = {
    providerId: 'anthropic',
    accountSubjectId: accountId,
    subjectKind: 'account',
    quotaScope: 'account',
  } as const;
  const recordId = buildProviderAccountUsageRecordId(recordKey);
  return ConnectedServiceQuotaGetResultV1Schema.parse({
    source: { ref: { service, accountId }, bindingKind: 'account' },
    current: {
      v: 1,
      recordId,
      recordKey,
      providerId: 'anthropic',
      accountSubject: { kind: 'providerSubject', id: accountId },
      observedAtMs: now,
      fetchedAtMs: now,
      staleAfterMs: HOUR,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: `Plan ${accountId}`,
      meters: meters.map((meter) => ({
        ...meter,
        used: null,
        limit: null,
        utilizationPct: meter.usedPct,
        unit: 'count',
        status: 'ok',
        resetsAt: meter.resetAtMs,
      })),
      ...current,
    },
    pace: meters.map((meter) => ({
      meterId: meter.meterId,
      value: {
        status: 'available',
        window: {
          recordId,
          meterId: meter.meterId,
          resetAtMs: meter.resetAtMs,
          windowStartAtMs: meter.resetAtMs - meter.windowDurationMs,
          windowDurationMs: meter.windowDurationMs,
        },
        usedFraction: meter.usedPct / 100,
        elapsedFraction: 0.5,
        evenPaceFraction: 0.5,
        pace: meter.usedPct / 50,
        projectedResetUtilizationFraction: meter.usedPct / 50,
        qualification: 'confirmed',
        sampleCount: 7,
        empiricalRange: { min: 0.6, max: 0.9 },
        observedCurve: [
          { observedAtMs: now - HOUR, usedFraction: meter.usedPct / 200 },
          { observedAtMs: now, usedFraction: meter.usedPct / 100 },
        ],
      },
    })),
    targets: [],
    waitingWork: { status: 'unavailable', reason: 'unsupported' },
    ...extra,
  });
}

function bodyProps(
  quota: readonly ConnectedServiceQuotaGetResultV1[],
  pools?: Parameters<typeof resolveUsagePageAggregation>[0]['pools'],
  shownQuery = query,
) {
  const slice = resolveUsagePageAggregation({
    queries: [shownQuery],
    quota: { status: 'available', value: [...quota] },
    ...(pools ? { pools } : {}),
  }).results[0]!;
  const model = {
    requestedQuery: null,
    shownQuery: null,
    slice,
    pending: false,
    error: null,
    freshness: 'fresh',
    updatingPreviousPeriod: false,
    refreshing: false,
    refresh: async () => {},
  } satisfies UsageWidgetBodyModel;
  return { model, slice, query: shownQuery, serverId: 'home' };
}

const wrap = (node: React.ReactElement) => (
  <InjectedAuthProvider credentials={null}>{node}</InjectedAuthProvider>
);

it("lists a pool in the selector's own order and builds the why detail from its trace only when opened", async () => {
  const now = Date.now();
  const weekly = (usedPct: number): Meter => ({
    meterId: 'weekly',
    label: 'Weekly',
    usedPct,
    resetAtMs: now + 2 * DAY,
    windowDurationMs: 7 * DAY,
  });
  const quota = [
    quotaRead('work', now, [weekly(30)]),
    quotaRead('personal', now, [weekly(10)]),
    quotaRead('side', now, [weekly(100)]),
  ];
  const group = { service, groupId: 'pool' };
  const candidate = (profileId: string, priority: number) => ({
    profileId,
    priority,
    createdAtMs: 1,
    enabled: true,
    leastLimitedScore: 62,
    preferenceDeadlineMs: now + 2 * DAY,
  });
  const selection = {
    selected: candidate('personal', 1),
    reason: 'selected' as const,
    excluded: [
      {
        profileId: 'side',
        reason: 'quota_exhausted' as const,
        retryAtMs: now + 3 * HOUR,
      },
    ],
    decisionTrace: {
      activeProfileId: 'personal',
      reason: 'selected' as const,
      strategy: 'expiry_first' as const,
      selectionBasis: 'active_stickiness' as const,
      sticky: true,
      orderedEligibleCandidates: [
        candidate('personal', 1),
        candidate('work', 0),
      ],
      candidates: [
        {
          profileId: 'work',
          decision: 'eligible' as const,
          quotaEvidence: {
            status: 'fresh' as const,
            remainingPercent: 62,
            capturedAtMs: now - 120_000,
          },
        },
        {
          profileId: 'personal',
          decision: 'selected' as const,
          quotaEvidence: { status: 'stale_or_missing' as const },
        },
        {
          profileId: 'side',
          decision: 'excluded' as const,
          exclusionReason: 'quota_exhausted' as const,
          retryAtMs: now + 3 * HOUR,
          quotaEvidence: {
            status: 'fresh' as const,
            remainingPercent: 0,
            capturedAtMs: now - 120_000,
            exhausted: true,
          },
        },
      ],
    },
  };
  const props = bodyProps(quota, [
    {
      query,
      value: [
        {
          group,
          memberAccountIds: ['work', 'personal', 'side'],
          activeAccountId: 'personal',
          selection: {
            status: 'available',
            value: { group, observedAtMs: now, selection },
          },
        },
      ],
    },
  ]);
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const screen = await renderScreen(
    wrap(<UsageCapacityWidget {...props} id="usage_capacity" testID="cap" />),
  );
  const queue = ['personal', 'work', 'side'].map((id) =>
    screen.findHostByTestId(`cap.usedFirst.pool.${id}`),
  );
  expect(queue.every(Boolean)).toBe(true);
  // The Account's own read order is work, personal: the queue follows the selector's order instead.
  const order = screen
    .findAll(
      (node) =>
        typeof node.props.testID === 'string' &&
        /^cap\.usedFirst\.pool\.(work|personal|side)$/.test(
          node.props.testID,
        ) &&
        typeof node.type === 'string',
    )
    .map((node) => node.props.testID as string);
  expect([...new Set(order)]).toEqual([
    'cap.usedFirst.pool.personal',
    'cap.usedFirst.pool.work',
    'cap.usedFirst.pool.side',
  ]);
  expect(screen.getTextContent()).toContain('Expiring first');
  expect(screen.findByTestId('cap.usedFirst.pool.why.detail')).toBeNull();
  expect(screen.getTextContent()).not.toContain('62%');
  await screen.pressByTestIdAsync('cap.usedFirst.pool.why');
  expect(screen.findByTestId('cap.usedFirst.pool.why.detail')).toBeTruthy();
  expect(
    screen.findByTestId('cap.usedFirst.pool.why.candidate.work'),
  ).toBeTruthy();
  // The evidence is the trace's own number (62), not the meter's (70% left).
  expect(screen.getTextContent()).toContain('62%');
  expect(
    screen.findHostByTestId('cap.usedFirst.pool.why.candidate.side')!.props
      .accessibilityLabel,
  ).toContain('used up');
});

/** One earlier week of the same record and meter in accepted history: two readings, one and three days in. */
function withEarlierWeek(read: ConnectedServiceQuotaGetResultV1, weekly: Meter): ConnectedServiceQuotaGetResultV1 {
  const current = read.current!;
  const earlierReset = weekly.resetAtMs - weekly.windowDurationMs;
  const reading = (id: string, observedAtMs: number, usedPct: number) => ({ id, observedAtMs, snapshot: { ...current,
    observedAtMs, fetchedAtMs: observedAtMs,
    meters: current.meters.map((meter) => meter.meterId === 'weekly'
      ? { ...meter, usedPct, utilizationPct: usedPct, resetAtMs: earlierReset, resetsAt: earlierReset } : meter) } });
  const start = earlierReset - weekly.windowDurationMs;
  return ConnectedServiceQuotaGetResultV1Schema.parse({ ...read, history: { nextCursor: null,
    entries: [reading('w1', start + DAY, 10), reading('w3', start + 3 * DAY, 50)] } });
}

it('charts the picked window in the same chart, labels the empirical range with its readings and discloses past cycles', async () => {
  const now = Date.now();
  const weekly: Meter = {
    meterId: 'weekly',
    label: 'Weekly',
    usedPct: 80,
    resetAtMs: now + 2 * DAY,
    windowDurationMs: 7 * DAY,
  };
  const session: Meter = {
    meterId: 'session',
    label: 'Five hour',
    usedPct: 20,
    resetAtMs: now + 2 * HOUR,
    windowDurationMs: 5 * HOUR,
  };
  const base = quotaRead('work', now, [weekly, session]);
  const recordId = base.current!.recordId;
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({
    ...base,
    unusedCapacity: {
      historyStatus: 'returned_page',
      windows: [
        {
          window: {
            recordId,
            meterId: 'weekly',
            resetAtMs: weekly.resetAtMs - 7 * DAY,
            windowStartAtMs: weekly.resetAtMs - 14 * DAY,
            windowDurationMs: 7 * DAY,
          },
          value: {
            status: 'available',
            unusedAmount: 23,
            unusedFraction: 0.23,
            unit: 'percent',
            observedAtMs: now - 5 * DAY,
            sampleCount: 5,
            qualification: 'confirmed',
            method: 'terminal_observation',
          },
        },
      ],
    },
  });
  const props = bodyProps([withEarlierWeek(read, weekly)]);
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(
    wrap(
      <UsageProjectionsWidget
        {...props}
        id="usage_projections"
        testID="proj"
      />,
    ),
  );
  const chart = () =>
    screen
      .findAllByType(BurnUpChart)
      .find((node) => node.props.testID === 'proj.burnUp')!;
  const first = chart();
  expect(first.props.label).toContain('Weekly');
  // The earlier comparable week is a ghost curve on this window's axis; the spread lines are not.
  const ghosts = first.props.series.filter((entry: { id: string }) => entry.id.startsWith('earlier:'));
  expect(ghosts).toHaveLength(1);
  expect(ghosts[0].points.map((point: { x: number; y: number }) => [point.x - (weekly.resetAtMs - weekly.windowDurationMs), point.y]))
    .toEqual([[DAY, 10], [3 * DAY, 50]]);
  expect(first.props.series.some((entry: { id: string }) => entry.id === 'rangeLow')).toBe(true);
  expect(screen.findHostByTestId('proj.earlier')!.props.accessibilityLabel).toContain('1');
  const range = screen.findHostByTestId('proj.range')!.props.accessibilityLabel as string;
  // The owner's own spread (0.6–0.9 of the window at the reset) with its real reading count.
  expect(range).toContain('60%');
  expect(range).toContain('90%');
  expect(range).toContain('7');
  expect(screen.findByTestId('proj.multiple.work.session')).toBeTruthy();
  expect(screen.findByTestId('proj.pastCycles.row.0')).toBeNull();
  await screen.pressByTestIdAsync('proj.pastCycles-header');
  // 1 − 0.23 unused: the ended window's recorded used share.
  expect(
    screen.findHostByTestId('proj.pastCycles.row.0')!.props.accessibilityLabel,
  ).toContain('77%');
  const picker = screen
    .findAllByType(DropdownMenu)
    .find((node) => node.props.testID === 'proj.windowPicker')!;
  expect(
    picker.props.items.map((item: { id: string }) => item.id),
  ).toHaveLength(2);
  const sessionKey = picker.props.items.find((item: { title: string }) =>
    item.title.includes('Five hour'),
  ).id;
  await act(async () => picker.props.onSelect(sessionKey));
  expect(chart().props.label).toContain('Five hour');
  expect(chart()).toBe(first);
});

it("binds one Session's pending message to a reset with the exact witnessed input, and withholds the control without a witness", async () => {
  const now = Date.now();
  const runtime = await import('@/sync/domains/server/serverRuntime');
  const server = await runtime.upsertAndActivateServer({
    serverUrl: 'http://usage-plans.test',
    name: 'Plans',
  });
  publishAppliedActiveServerSnapshot(runtime.getActiveServerSnapshot());
  const previous = storage.getState();
  storage.setState({
    profileScope: { serverId: server.id, accountId: 'account-a' },
    sessionPending: {
      ...previous.sessionPending,
      s1: {
        messages: [
          {
            id: 'p1',
            localId: 'local-1',
            createdAt: now,
            updatedAt: now,
            text: 'Run the big refactor',
            rawRecord: null,
          },
        ],
        discarded: [],
        isLoaded: true,
      },
    },
  } as Partial<typeof previous> as typeof previous);
  try {
    const weekly: Meter = {
      meterId: 'weekly',
      label: 'Weekly',
      usedPct: 80,
      resetAtMs: now + 2 * DAY,
      windowDurationMs: 7 * DAY,
    };
    const bare = quotaRead('work', now, [weekly]);
    const witnessed = ConnectedServiceQuotaGetResultV1Schema.parse({
      ...bare,
      history: {
        nextCursor: null,
        entries: [{ id: 'entry-9', observedAtMs: now, snapshot: bare.current }],
      },
    });
    const sessionQuery = normalizeUsageQuery({ session: 's1' });
    const { UsageResetPlannerWidget } =
      await import('../UsageResetPlannerWidget');
    const none = await renderScreen(
      wrap(
        <UsageResetPlannerWidget
          {...bodyProps([bare], undefined, sessionQuery)}
          serverId={server.id}
          id="usage_resets"
          testID="reset"
        />,
      ),
    );
    expect(none.findByTestId('reset.resetStart.unavailable')).toBeTruthy();
    expect(
      none
        .findAllByType(DropdownMenu)
        .some((node) => node.props.testID === 'reset.resetStart.local-1.pick'),
    ).toBe(false);
    none.unmount();
    execute.mockResolvedValue({
      ok: true,
      result: { didUpdate: true, requestedAction: { v: 1, kind: 'enqueue' } },
    });
    const screen = await renderScreen(
      wrap(
        <UsageResetPlannerWidget
          {...bodyProps([witnessed], undefined, sessionQuery)}
          serverId={server.id}
          id="usage_resets"
          testID="reset"
        />,
      ),
    );
    const picker = screen
      .findAllByType(DropdownMenu)
      .find((node) => node.props.testID === 'reset.resetStart.local-1.pick')!;
    await act(async () => {
      picker.props.onSelect(picker.props.items[0].id);
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toBe('session.pending.resetStart.set');
    expect(execute.mock.calls[0]![1]).toEqual({
      sessionId: 's1',
      localId: 'local-1',
      serverId: server.id,
      reset: {
        source: witnessed.source,
        recordId: witnessed.current!.recordId,
        meterId: 'weekly',
        witness: { id: 'entry-9', observedAtMs: now },
      },
    });
  } finally {
    storage.setState({
      profileScope: previous.profileScope,
      sessionPending: previous.sessionPending,
    });
  }
});

it("says what a banked reset's expiry means against the natural reset, and counts plan fit over witnessed windows only", async () => {
  const now = Date.now();
  const weekly: Meter = {
    meterId: 'weekly',
    label: 'Weekly',
    usedPct: 80,
    resetAtMs: now + 2 * DAY,
    windowDurationMs: 7 * DAY,
  };
  const base = quotaRead(
    'work',
    now,
    [weekly],
    {},
    {
      recoveryCredits: {
        availableCount: 1,
        nextExpiresAtMs: now + DAY,
        credits: [
          {
            kind: 'usage_limit_reset',
            status: 'available',
            expiresAtMs: now + DAY,
          },
        ],
      },
    },
  );
  const recordId = base.current!.recordId;
  const ended = (weeks: number, unusedFraction: number) => ({
    window: {
      recordId,
      meterId: 'weekly',
      resetAtMs: weekly.resetAtMs - weeks * 7 * DAY,
      windowStartAtMs: weekly.resetAtMs - (weeks + 1) * 7 * DAY,
      windowDurationMs: 7 * DAY,
    },
    value: {
      status: 'available',
      unusedAmount: unusedFraction * 100,
      unusedFraction,
      unit: 'percent',
      observedAtMs: now - weeks * 7 * DAY,
      sampleCount: 3,
      qualification: 'confirmed',
      method: 'terminal_observation',
    },
  });
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({
    ...base,
    unusedCapacity: {
      historyStatus: 'returned_page',
      windows: [ended(1, 0), ended(2, 0.4), ended(3, 0.5)],
    },
  });
  const { UsageResetPlannerWidget } =
    await import('../UsageResetPlannerWidget');
  const resets = await renderScreen(
    wrap(
      <UsageResetPlannerWidget
        {...bodyProps([read])}
        id="usage_resets"
        testID="reset"
      />,
    ),
  );
  expect(
    resets.findHostByTestId('reset.wallet.work.advice')!.props.children,
  ).toBeTruthy();
  expect(resets.findByTestId('reset.list.0')).toBeTruthy();
  expect(resets.findByTestId('reset.resetStart')).toBeNull();
  resets.unmount();
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const fit = await renderScreen(
    wrap(
      <UsagePlanFitWidget
        {...bodyProps([read, quotaRead('other', now, [weekly])])}
        id="usage_plan_fit"
        testID="fit"
      />,
    ),
  );
  const label = fit.findHostByTestId('fit.plan.work.fit')!.props
    .accessibilityLabel as string;
  expect(label).toContain('1');
  expect(label).toContain('3');
  expect(fit.findByTestId('fit.plan.other.fit.insufficient')).toBeTruthy();
  expect(fit.findByTestId('fit.notRecorded')).toBeTruthy();
});

it('shows the list-price observation date in the selected app language', async () => {
  const previousLanguage = getPreferredLanguage();
  const appLanguage = new Intl.DateTimeFormat().resolvedOptions().locale.startsWith('fr') ? 'de' : 'fr';
  await preloadTranslationsForSettings(appLanguage);
  setPreferredLanguageFromSettings(appLanguage);
  try {
    const now = Date.now();
    const asOfMs = now - 30 * DAY;
    const period = { startAtMs: now - DAY, endAtMs: now + 2 * DAY };
    const read = quotaRead('work', now, [], {}, {
      subscription: {
        status: 'subscribed', renewal: 'on', observedAtMs: now, staleAfterMs: HOUR,
        currentPeriodStartAtMs: period.startAtMs, currentPeriodEndAtMs: period.endAtMs,
        monetaryFacts: [{
          kind: 'list', amount: 20, currency: 'USD', period,
          source: { kind: 'published', id: 'provider-list', version: '2026-09' },
          effectiveAtMs: asOfMs, asOfMs,
        }],
      },
    });
    const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
    const screen = await renderScreen(wrap(
      <UsagePlanFitWidget {...bodyProps([read])} id="usage_plan_fit" testID="fit" />,
    ));
    const options = { day: 'numeric', month: 'short', year: 'numeric' } as const;
    const expected = new Intl.DateTimeFormat(appLanguage, options).format(asOfMs);
    const deviceDate = new Intl.DateTimeFormat(undefined, options).format(asOfMs);
    expect(expected).not.toBe(deviceDate);
    expect(screen.findHostByTestId('fit.plan.work')!.props.accessibilityLabel).toContain(expected);
  } finally {
    setPreferredLanguageFromSettings(previousLanguage);
  }
});
