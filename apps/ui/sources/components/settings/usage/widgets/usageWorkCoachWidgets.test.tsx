import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { router } from 'expo-router';
import {
  getUsageQueryKey,
  normalizeUsageQuery,
} from '@happier-dev/protocol/inputs/usageQuery';
import {
  allocateUsageOutcomes,
  UsageWorkProjectionSchema,
  type UsageWorkContribution,
  type UsageWorkEvidence,
} from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import {
  applyUsageCoachPreferences,
  evaluateUsageCoach,
} from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { UsageProjectLedgerWidget } from './UsageProjectLedgerWidget';
import { UsageSessionValueWidget } from './UsageSessionValueWidget';
import { UsageOutcomesWidget } from './UsageOutcomesWidget';
import { UsageCoachWidget } from './UsageCoachWidget';
import { UsageNightShiftWidget } from './UsageNightShiftWidget';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UsagePlanFitWidget } from './UsagePlanFitWidget';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { resolveUsageHowYouWork } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { projectProviderAccountUsageQuotaReadV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';

const query = normalizeUsageQuery({
  period: { startMs: 0, endMs: 1000 },
  granularity: 'day',
  metric: 'cost',
  costBasis: 'reported',
});
const key = getUsageQueryKey(query);
const tokens = {
  input: 10,
  output: 4,
  reasoning: 1,
  cacheRead: 2,
  cacheWrite: 0,
  total: 14,
};
const contribution = (
  id: string,
  sessionId: string,
  turnId: string | null,
): UsageWorkContribution => ({
  id,
  sessionId,
  turnId,
  observedAtMs: 1,
  agentId: 'claude',
  modelId: 'model',
  machineId: 'machine',
  projectKey: 'p1',
  workspaceId: null,
  source: 'runtime',
  tokens,
  cost: { reportedUsd: 3, estimatedUsd: 4, currency: 'USD' },
});
const evidence = (
  sessionId: string,
  turnId: string,
  number: number,
): UsageWorkEvidence => ({
  sessionId,
  turnId,
  repositoryKey: 'repo',
  checkpointRef: `checkpoint/${sessionId}/${turnId}`,
  checkpointCommitSha: 'a'.repeat(40),
  commitSha: 'b'.repeat(40),
  attributionScope: 'no_happier_checkpoint_overlap_observed',
  pullRequest: {
    provider: {
      id: 'forge',
      kind: 'github',
      displayName: 'Forge',
      baseUrl: 'https://github.com',
      nameWithOwner: 'owner/repo',
      urlSafety: { allowedSchemes: ['https:'] },
    },
    number,
    title: 'Retry relay handshake',
    url: `https://github.com/owner/repo/pull/${number}`,
    baseBranch: 'main',
    headBranch: 'relay-retry',
    state: 'merged',
  },
});
const contributions = [
  contribution('a', 's1', 't1'),
  contribution('b', 's2', 't2'),
  contribution('c', 's1', null),
];
const work = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({
  contributions,
  evidence: [evidence('s1', 't1', 2493)],
}));
const compactions = [
  { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't' },
  { evidenceId: 'c2', observedAtMs: 20, sessionId: 's', turnId: 't' },
];
const coach = evaluateUsageCoach({
  queryKey: key,
  period: { startMs: 0, endMs: 1000 },
  asOfMs: 1000,
  currentness: 'current',
  detail: { coverage: 'partial', compactions },
});
const slice: UsageQueryResultSlice = {
  key,
  requestedQuery: query,
  shownQuery: query,
  work,
  coach,
  pending: false,
  accounting: {
    v: 1,
    totals: {
      eventCount: 3,
      tokens: { ...tokens, total: 42 },
      cost: { reportedUsd: 9, estimatedUsd: 12, currency: 'USD' },
    },
    contributions,
  },
  sources: [
    { source: 'accounting', status: 'available' },
    { source: 'work', status: 'available' },
    { source: 'how_you_work', status: 'available' },
  ],
};
const model: UsageWidgetBodyModel = {
  requestedQuery: null,
  shownQuery: null,
  slice,
  pending: false,
  error: null,
  freshness: 'fresh',
  updatingPreviousPeriod: false,
  refreshing: false,
  refresh: async () => {},
};
const props = { model, slice, query, serverId: 'home' };

describe('Work and Coach widget bodies', () => {
  it('offers digest scheduling only after the person opens its existing Automation editor', async () => {
    const digestSlice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: slice.accounting!, status: 'available', asOfMs: 1000 }] }).results[0]!;
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={digestSlice} id="usage_coach" testID="coach" />);
    expect(screen.findByTestId('coach.digest.configure')).toBeTruthy();
    expect(screen.findByTestId('coach.digest.editor')).toBeNull();
    await screen.pressByTestIdAsync('coach.digest.configure');
    expect(screen.findByTestId('coach.digest.editor')).toBeTruthy();
    expect(screen.findByTestId('coach.digest.editor-submit')?.props.disabled).toBe(true);
  });
  it('shows a standalone exact branch and a separate bound Provider mark without inventing one from the Agent', async () => {
    const bound = { ...contribution('branch', 's1', 't1'), providerId: 'provider.openrouter', providerConnectionId: 'connection' };
    const branch = { ref: 'refs/heads/standalone', headSha: 'c'.repeat(40) };
    const branchWork = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: [bound, contribution('native', 's2', 't2')], evidence: [],
      branchEvidence: [{ sessionId: 's1', turnId: 't1', repositoryKey: 'opaque-repo', checkpointRef: 'checkpoint/s1/t1',
        checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', branch }] }));
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={{ ...slice, work: branchWork }} id="usage_project_ledger" testID="ledger" />);
    expect(screen.findByTestId('ledger.branches')).toBeTruthy();
    expect(screen.getTextContent()).toContain('standalone');
    expect(screen.getTextContent()).toContain(branch.headSha.slice(0, 7));
    expect(screen.findByTestId('ledger.provider.provider.openrouter')).toBeTruthy();
    expect(screen.findAllByTestId('ledger.provider.claude')).toHaveLength(0);
    // The Session without a binding stays unknown in words; it never borrows the Agent's name.
    expect(screen.getTextContent()).toContain('Provider: Not recorded');
  });
  it('opens a selected Session autopsy with exact contribution, checkpoint and witnessed wait phases', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
    const howYouWork = resolveUsageHowYouWork({ period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0,
      detail: { status: 'partial', facts: [
        { workId: JSON.stringify(['s1', 't1']), evidenceId: 't1', agentId: 'claude', machineId: 'machine', kind: 'busy', startMs: 10, endMs: 800 },
        { workId: JSON.stringify(['s1', 't1']), evidenceId: 'approval', agentId: 'claude', machineId: 'machine', kind: 'permission_wait', startMs: 200, endMs: 300 },
        { workId: JSON.stringify(['s1', 't2']), evidenceId: 't2', agentId: 'claude', machineId: 'machine', kind: 'busy', startMs: 900, endMs: null },
      ] } });
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery} slice={{ ...slice, shownQuery: sessionQuery, howYouWork }} id="usage_session_value" testID="value" />);
    expect(screen.findByTestId('value.autopsy')).toBeTruthy();
    const text = screen.getTextContent();
    expect(text).toContain('checkpoint/s1/t1');
    expect(text).toContain('bbbbbbb');
    // Turns are named by their witnessed order and waits by what they waited for, never by a raw id.
    expect(text).toContain('Turn 1');
    expect(text).toContain('no turn recorded');
    expect(text.toLowerCase()).toContain('waiting for your approval');
    expect(text).not.toContain('["s1","t1"]');
    expect(text).not.toContain('b'.repeat(40));
    expect(screen.findByTestId('value.autopsy.summary')).toBeTruthy();
    expect(screen.findByTestId('value.autopsy.turns')).toBeTruthy();
    expect(screen.findByTestId('value.autopsy.unknownEnds')).toBeTruthy();
  });
  it('expands a project row in place into every Session, linked PR and branch, and opens a Session\'s autopsy from there', async () => {
    const navigation = vi.spyOn(router, 'push');
    try {
      const rows = Array.from({ length: 7 }, (_, index) => contribution(`c${index}`, `s${index}`, `t${index}`));
      const branch = { ref: 'refs/heads/glass', headSha: 'c'.repeat(40) };
      const complete = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: rows,
        evidence: [evidence('s0', 't0', 2493)],
        branchEvidence: [{ sessionId: 's1', turnId: 't1', repositoryKey: 'repo', checkpointRef: 'checkpoint/s1/t1',
          checkpointCommitSha: 'a'.repeat(40), commitSha: 'd'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', branch }] }));
      const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 1, width: 'half', height: 'compact' }, geometry: { width: 320, height: 96 } }}>
        <UsageProjectLedgerWidget {...props} slice={{ ...slice, work: complete }} id="usage_project_ledger" testID="ledger" />
      </WidgetPresentationProvider>);
      expect(screen.findByTestId('ledger.project.p1.detail')).toBeFalsy();
      await screen.pressByTestIdAsync('ledger.project.p1.toggle');
      expect(screen.findByTestId('ledger.project.p1.detail')).toBeTruthy();
      for (let index = 0; index < 7; index += 1) expect(screen.findByTestId(`ledger.project.p1.session.open.s${index}`)).toBeTruthy();
      expect(screen.findByTestId('ledger.project.p1.prs')).toBeTruthy();
      expect(screen.findByTestId('ledger.project.p1.branches')).toBeTruthy();
      expect(screen.getTextContent()).toContain('2493');
      expect(screen.getTextContent()).toContain('glass');
      await screen.pressByTestIdAsync('ledger.project.p1.session.open.s6');
      expect(new URL(String(navigation.mock.calls.at(-1)?.[0]), 'https://usage.test').pathname).toBe('/session/s6/usage');
      // Outside the Usage page there is no filter row: narrowing opens Usage on this project.
      await screen.pressByTestIdAsync('ledger.project.p1.filter');
      const narrowed = navigation.mock.calls.at(-1)?.[0] as Readonly<{ params: Readonly<{ scope: string }> }>;
      expect(JSON.parse(narrowed.params.scope)).toMatchObject({ projects: ['p1'] });
      await screen.pressByTestIdAsync('ledger.project.p1.toggle');
      expect(screen.findByTestId('ledger.project.p1.detail')).toBeFalsy();
    } finally { navigation.mockRestore(); }
  });
  it('expands a branch into its commit evidence and Sessions, and a PR into the Sessions that paid for it', async () => {
    const navigation = vi.spyOn(router, 'push');
    try {
      const branch = { ref: 'refs/heads/glass', headSha: 'c'.repeat(40) };
      const branchWork = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions,
        evidence: [evidence('s1', 't1', 2493)],
        branchEvidence: [{ sessionId: 's2', turnId: 't2', repositoryKey: 'repo', checkpointRef: 'checkpoint/s2/t2',
          checkpointCommitSha: 'a'.repeat(40), commitSha: 'd'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', branch }] }));
      const screen = await renderScreen(<>
        <UsageProjectLedgerWidget {...props} slice={{ ...slice, work: branchWork }} id="usage_project_ledger" testID="ledger" />
        <UsageOutcomesWidget {...props} slice={{ ...slice, work: branchWork }} id="usage_outcomes" testID="outcomes" />
      </>);
      const branchKey = branchWork.branches[0]!.key;
      expect(screen.findByTestId(`ledger.branch.${branchKey}.session.open.s2`)).toBeFalsy();
      await screen.pressByTestIdAsync(`ledger.branch.${branchKey}.toggle`);
      expect(screen.getTextContent()).toContain('ddddddd');
      await screen.pressByTestIdAsync(`ledger.branch.${branchKey}.session.open.s2`);
      expect(new URL(String(navigation.mock.calls.at(-1)?.[0]), 'https://usage.test').pathname).toBe('/session/s2/usage');
      const prKey = branchWork.outcomes[0]!.key;
      expect(screen.findByTestId(`outcomes.pr.${prKey}.session.open.s1`)).toBeFalsy();
      await screen.pressByTestIdAsync(`outcomes.pr.${prKey}.toggle`);
      await screen.pressByTestIdAsync(`outcomes.pr.${prKey}.session.open.s1`);
      expect(new URL(String(navigation.mock.calls.at(-1)?.[0]), 'https://usage.test').pathname).toBe('/session/s1/usage');
    } finally { navigation.mockRestore(); }
  });
  it('keeps the fourth Session and seventh PR reachable at compact phone size', async () => {
    const navigation = vi.spyOn(router, 'push');
    try {
    const rows = Array.from({ length: 7 }, (_, index) => contribution(`c${index}`, `s${index}`, `t${index}`));
    const complete = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: rows, evidence: rows.map((row, index) => evidence(row.sessionId!, row.turnId!, 100 + index)) }));
    const compactSlice = { ...slice, work: complete };
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 1, width: 'half', height: 'compact' }, geometry: { width: 320, height: 96 } }}>
      <UsageSessionValueWidget {...props} slice={compactSlice} id="usage_session_value" testID="value" />
      <UsageOutcomesWidget {...props} slice={compactSlice} id="usage_outcomes" testID="outcomes" />
    </WidgetPresentationProvider>);
    expect(screen.findByTestId('value.open.s3')).toBeTruthy();
    expect(screen.findByTestId('outcomes.prs')).toBeTruthy();
    expect(screen.getTextContent()).toContain('106');
      await screen.pressByTestIdAsync('value.open.s3');
      const destination = navigation.mock.calls.at(-1)?.[0];
      expect(typeof destination).toBe('string');
      const route = new URL(String(destination), 'https://usage.test');
      expect(route.pathname).toBe('/session/s3/usage');
      expect(route.searchParams.get('serverId')).toBe('home');
      expect(JSON.parse(route.searchParams.get('scope')!)).toMatchObject({ period: query.period, session: 's3', costBasis: 'reported' });
      expect(JSON.parse(route.searchParams.get('queryOverrides')!)).toMatchObject({ timeZoneOffsetMinutes: query.timeZoneOffsetMinutes });
    } finally { navigation.mockRestore(); }
  });

  it('shows missing Work money as unknown and preserves witnessed zero', async () => {
    const rows = [
      { ...contribution('unknown', 'unpriced', 't1'), cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const } },
      { ...contribution('free', 'free', 't2'), cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const } },
    ];
    const unpriced = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: rows, evidence: [] }));
    const screen = await renderScreen(<UsageSessionValueWidget {...props} slice={{ ...slice, work: unpriced }} id="usage_session_value" testID="value" />);
    const unpricedRow = screen.findByTestId('value.open.unpriced');
    const freeRow = screen.findByTestId('value.open.free');
    expect(unpricedRow).toBeTruthy();
    expect(screen.getTextContent()).toContain('without a price');
    expect(screen.getTextContent()).toContain('$0.00');
    expect(freeRow).toBeTruthy();
  });
  it('does not substitute an earlier quota reset for unused capacity at a later subscription end', async () => {
    const now = Date.UTC(2026, 9, 10, 12);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const recordKey = { providerId: 'codex', accountSubjectId: 'work', subjectKind: 'account' as const, quotaScope: 'account' as const };
      const source = { ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' }, bindingKind: 'account' as const };
      const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'work' }, observedAtMs: now, fetchedAtMs: now,
        staleAfterMs: 3_600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
        subscription: { status: 'subscribed', renewal: 'off', currentPeriodEndAtMs: now + 5_400_000, observedAtMs: now, staleAfterMs: 3_600_000 },
        meters: [{ meterId: 'hour', label: 'Hour', used: 20, remaining: 80, limit: 100, unit: 'requests', utilizationPct: 20,
          resetsAt: now + 1_800_000, windowDurationMs: 3_600_000, status: 'ok', details: {} }] });
      const read = () => projectProviderAccountUsageQuotaReadV1({ input: { source }, current: snapshot, nowMs: now });
      const screened = (quota: ReturnType<typeof read>) => <UsagePlanFitWidget {...props} slice={{ ...slice, quota: [quota] }} id="usage_plan_fit" testID="fit" />;
      const screen = await renderScreen(screened(read()), { wrapper: ({ children }) => <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider> });
      expect(screen.getTextContent()).not.toContain('60%');
      snapshot.subscription!.currentPeriodEndAtMs = now + 1_800_000;
      await screen.update(screened(read()));
      expect(screen.getTextContent()).toContain('60%');
    } finally { clock.mockRestore(); }
  });
  it('requires both chosen night endpoints before persisting the interval and can clear it', async () => {
    await loadSyncSingletonForTests();
    const previousState = storage.getState();
    type PendingState = { pendingSettings: Partial<typeof previousState.settings>; pendingSettingsFlushTimer: ReturnType<typeof setTimeout> | null; pendingSettingsDirty: boolean };
    const runtime = getSyncSingleton() as unknown as PendingState;
    const previousPending = { pendingSettings: runtime.pendingSettings, pendingSettingsFlushTimer: runtime.pendingSettingsFlushTimer, pendingSettingsDirty: runtime.pendingSettingsDirty };
    let rendered: Awaited<ReturnType<typeof renderScreen>> | undefined;
    // Hold the real writer's external network/persistence flush on its clock boundary.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      storage.setState({ settings: settingsParse({}), settingsScope: { serverId: 'home', accountId: 'account' }, settingsVersion: 1 });
      const screen = await renderScreen(<UsageNightShiftWidget {...props} id="usage_night_shift" testID="night" />);
      rendered = screen;
      expect(storage.getState().settings.usageNightHoursV1).toBeNull();
      const controls = screen.findAllByType(DropdownMenu);
      expect(controls).toHaveLength(2);
      await act(async () => controls[0]!.props.onSelect('23'));
      expect(storage.getState().settings.usageNightHoursV1).toBeNull();
      await act(async () => screen.findAllByType(DropdownMenu)[1]!.props.onSelect('7'));
      expect(storage.getState().settings.usageNightHoursV1).toEqual({ startHour: 23, endHour: 7 });
      await act(async () => screen.findAllByType(DropdownMenu)[0]!.props.onSelect('clear'));
      expect(storage.getState().settings.usageNightHoursV1).toBeNull();
      await act(async () => screen.findAllByType(DropdownMenu)[0]!.props.onSelect('23'));
      await act(async () => { storage.setState({ settingsScope: { serverId: 'home', accountId: 'other-account' } }); });
      expect(screen.findAllByType(DropdownMenu).map(control => control.props.selectedId)).toEqual([null, null]);
    } finally {
      await rendered?.unmount();
      vi.clearAllTimers(); vi.useRealTimers();
      Object.assign(runtime, previousPending); storage.setState(previousState, true);
    }
  });
  it('ledger states the PR-linked amount and the unlinked remainder that add back to the total', async () => {
    const screen = await renderScreen(
      <UsageProjectLedgerWidget
        {...props}
        id="usage_project_ledger"
        testID="ledger"
      />,
    );
    const text = screen.getTextContent();
    expect(screen.findByTestId('ledger.conservation')).toBeTruthy();
    expect(text).toContain('$3.00');
    expect(text).toContain('$6.00');
    expect(text).toContain('$9.00');
  });

  it('session value never draws an unlinked session as zero output', async () => {
    const screen = await renderScreen(
      <UsageSessionValueWidget
        {...props}
        id="usage_session_value"
        testID="value"
      />,
    );
    expect(screen.findByTestId('value.merged')).toBeTruthy();
    expect(screen.findByTestId('value.unlinked')).toBeTruthy();
  });

  it('outcomes shows the exact PR and the session funnel', async () => {
    const screen = await renderScreen(
      <UsageOutcomesWidget {...props} id="usage_outcomes" testID="outcomes" />,
    );
    expect(screen.findByTestId('outcomes.funnel')).toBeTruthy();
    expect(screen.getTextContent()).toContain('2493');
  });

  it('coach shows the evidence-backed finding, hides a dismissed one and keeps insufficient checks visible', async () => {
    const screen = await renderScreen(
      <UsageCoachWidget {...props} id="usage_coach" testID="coach" />,
    );
    expect(screen.findByTestId('coach.finding.compaction_storms')).toBeTruthy();
    expect(screen.findByTestId('coach.checks.toggle')).toBeTruthy();
    const dismissed = applyUsageCoachPreferences(
      coach,
      {
        v: 1,
        suppressions: [
          { kind: 'dismissed', evidenceKey: coach.findings[0]!.evidenceKey },
        ],
      },
      500,
    );
    const hidden = await renderScreen(
      <UsageCoachWidget
        {...props}
        slice={{ ...slice, coach: dismissed }}
        id="usage_coach"
        testID="coach"
      />,
    );
    expect(hidden.findByTestId('coach.finding.compaction_storms')).toBeFalsy();
    expect(hidden.findByTestId('coach.empty')).toBeTruthy();
  });
});
