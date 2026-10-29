import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, renderScreen } from '@/dev/testkit';
import { useUsageWork } from './useUsageWork';
import { router } from 'expo-router';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { HappierDataMetric, HappierDataRows, IntervalTimeline, OutcomeFunnel, OutcomeScatter, RankedRows } from '@happier-dev/plugin-ui/presentation';
import { DEFAULT_USAGE_COACH_PREFERENCES_V1 } from '@happier-dev/protocol/account/settings/usageCoachPreferencesV1';
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
import { UsageHumanLoopWidget } from './UsageHumanLoopWidget';
import { UsageParallelWidget } from './UsageParallelWidget';
import { UsageOutcomesWidget } from './UsageOutcomesWidget';
import { UsageCoachWidget } from './UsageCoachWidget';
import { storage } from '@/sync/domains/state/storage';
import { formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UsagePlanFitWidget } from './UsagePlanFitWidget';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { resolveUsageHowYouWork } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { projectProviderAccountUsageQuotaReadV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { createProjectAccountRowsSync } from '@/sync/engine/projects/projectAccountRowsSync';

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
  { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't', immediateRefillToLimit: true },
  { evidenceId: 'c2', observedAtMs: 20, sessionId: 's', turnId: 't', immediateRefillToLimit: true },
  { evidenceId: 'c3', observedAtMs: 30, sessionId: 's', turnId: 't', immediateRefillToLimit: true },
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
    breakdowns: { project: [{ key: 'p1', label: 'Workspace', eventCount: 3,
      tokens: { ...tokens, total: 42 }, cost: { reportedUsd: 9, estimatedUsd: 12, currency: 'USD' } }] },
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
  it('never falls back to raw opaque Project or Session ids', async () => {
    const opaque = 'a'.repeat(64);
    const rows = [contribution('opaque', 'private-session-identifier', null)].map(row => ({ ...row, projectKey: opaque }));
    const unnamed = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: rows, evidence: [] }));
    for (const accounting of [undefined, { ...slice.accounting!, breakdowns: { project: [{
      ...slice.accounting!.breakdowns!.project![0]!, key: opaque, label: `  ${'b'.repeat(64)}  `,
    }] } }]) {
      const hook = await renderHook(() => useUsageWork({ ...slice, work: unnamed, accounting }, query, 'home'));
      expect(hook.getCurrent().projectLabel(opaque)).toBe(t('usage.board.work.unknownProject'));
      expect(hook.getCurrent().sessionLabel('private-session-identifier')).toBe(t('session.untitled'));
      expect(hook.getCurrent().summary?.projects).toMatchObject([{ projectKey: null, unnamedProjectCount: 1 }]);
      await hook.unmount();
    }
  });
  it('tells apart Sessions that share a title and folders that share a name by where and when they ran', async () => {
    const rows: UsageWorkContribution[] = [
      { ...contribution('u1', 'untitled-1', 't1'), machineId: 'machine-a', observedAtMs: 1_700_000_000_000 },
      { ...contribution('u2', 'untitled-2', 't1'), machineId: 'machine-b', observedAtMs: 1_700_000_900_000 },
      { ...contribution('u3', 'lone-session', 't1'), machineId: 'machine-a' },
    ];
    const projection = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: rows, evidence: [] }));
    const hook = await renderHook(() => useUsageWork({ ...slice, work: projection }, query, 'home'));
    const { sessionLabel } = hook.getCurrent();
    const [first, second] = [sessionLabel('untitled-1'), sessionLabel('untitled-2')];
    expect(first).not.toBe(second);
    expect(first.startsWith(t('session.untitled'))).toBe(true);
    expect(first.length).toBeGreaterThan(t('session.untitled').length);
    await hook.unmount();
  });
  it('keeps a shared Project name whole and tells twins apart by the machine they ran on', async () => {
    const rows: UsageWorkContribution[] = [
      { ...contribution('t1', 'twin-1', 't1'), projectKey: 'tmp-a', machineId: 'machine-a' },
      { ...contribution('t2', 'twin-2', 't1'), projectKey: 'tmp-b', machineId: 'machine-b' },
      { ...contribution('t3', 'lone-1', 't1'), projectKey: 'lone-key', machineId: 'machine-a' },
    ];
    const projection = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: rows, evidence: [] }));
    const project = (key: string, label: string) => ({ ...slice.accounting!.breakdowns!.project![0]!, key, label });
    const accounting = { ...slice.accounting!, breakdowns: { project: [project('tmp-a', 'tmp'), project('tmp-b', 'tmp'), project('lone-key', 'solo')] } };
    const hook = await renderHook(() => useUsageWork({ ...slice, work: projection, accounting }, query, 'home'));
    const { projectLabel, projectPlace } = hook.getCurrent();
    expect([projectLabel('tmp-a'), projectLabel('tmp-b'), projectLabel('lone-key')]).toEqual(['tmp', 'tmp', 'solo']);
    expect(projectPlace('tmp-a')).not.toBe('');
    expect(projectPlace('tmp-a')).not.toBe(projectPlace('tmp-b'));
    expect(projectPlace('lone-key')).toBe('');
    await hook.unmount();
  });
  it('keeps an unanswered first Coach evaluation pending instead of claiming there are no findings', async () => {
    const pendingSlice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting!, asOfMs: 1000 }],
      sources: [{ source: 'how_you_work', status: 'pending' }], nowMs: 1000 }).results[0]!;
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={pendingSlice}
      model={{ ...model, slice: pendingSlice, pending: true }} id="usage_coach" testID="first-coach" />);
    expect(screen.findHostByTestId('first-coach.empty')).toBeNull();
    expect(screen.findHostByTestId('first-coach.loading')).not.toBeNull();
    // A subsequent progress revision retains the incomplete evaluation as stale.
    // That qualification is not proof that the private evidence has answered.
    const retainedPending = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting!, asOfMs: 1000 }],
      previous: { v: 1, results: [pendingSlice] },
      sources: [{ source: 'how_you_work', status: 'pending' }], nowMs: 1000 }).results[0]!;
    expect(retainedPending.coach?.currentness).toBe('stale');
    await screen.update(<UsageCoachWidget {...props} slice={retainedPending}
      model={{ ...model, slice: retainedPending, pending: true }} id="usage_coach" testID="first-coach" />);
    expect(screen.findHostByTestId('first-coach.empty')).toBeNull();
    expect(screen.findHostByTestId('first-coach.loading')).not.toBeNull();
    const settledSlice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting! }],
      howYouWork: [{ query, asOfMs: 1000, detail: { status: 'available', facts: [] } }], nowMs: 1000 }).results[0]!;
    await screen.update(<UsageCoachWidget {...props} slice={settledSlice}
      model={{ ...model, slice: settledSlice }} id="usage_coach" testID="first-coach" />);
    expect(screen.findHostByTestId('first-coach.empty')).not.toBeNull();
  });
  it('shows admitted Sessions checked from the canonical result and recovers after retry', async () => {
    const project = (admitted: number) => resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting!, asOfMs: 1000 }],
      howYouWork: [{ query, asOfMs: 1000, sessionCoverage: { selected: 5, admitted },
        detail: { status: admitted < 5 ? 'partial' : 'available', facts: [] } }], nowMs: 1000 }).results[0]!;
    const partial = project(3);
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={partial} id="usage_coach" testID="coverage-coach" />);
    const metric = (key: string) => screen.findAllByType(HappierDataMetric).find(node => node.props.testID === `coverage-coach.summary.${key}`)?.props.value;
    expect(metric('sessions')).toBe(3);
    expect(metric('insufficient')).toBeGreaterThan(0);
    const recovered = project(5);
    await screen.update(<UsageCoachWidget {...props} slice={recovered} id="usage_coach" testID="coverage-coach" />);
    expect(metric('sessions')).toBe(5);
    expect(screen.findHostByTestId('coverage-coach.summary.sessions')?.props.accessibilityLabel)
      .toContain(`${t('usage.board.coach.summarySessions')}: 5`);
    await screen.update(<UsageCoachWidget {...props} slice={slice} id="usage_coach" testID="coverage-coach" />);
    expect(metric('sessions')).toBe('—');
    expect(screen.findHostByTestId('coverage-coach.summary.sessions')?.props.accessibilityLabel)
      .toContain(`${t('usage.board.coach.summarySessions')}: —`);
  });
  it('holds one finding row of room while a phone-width Coach reads, so its findings land without moving the page', async () => {
    const pendingSlice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting!, asOfMs: 1000 }],
      sources: [{ source: 'how_you_work', status: 'pending' }], nowMs: 1000 }).results[0]!;
    const heldRoom = async (size: 'medium' | 'large') => {
      const screen = await renderScreen(<WidgetPresentationProvider value={{ size,
        footprint: { columns: 1, columnSpan: 1, rowSpan: 2, width: 'full', height: 'regular' }, geometry: { width: 326, height: 260 } }}>
        <UsageCoachWidget {...props} slice={pendingSlice} model={{ ...model, slice: pendingSlice, pending: true }} id="usage_coach" testID="phone-coach" />
      </WidgetPresentationProvider>);
      // The held room is the min height of the wrapper around the body (the body is what gets measured).
      let held = 0;
      for (let node = screen.findHostByTestId('phone-coach.coach')?.parent; node; node = node.parent) {
        for (const entry of ([] as unknown[]).concat(node.props.style ?? []).flat(2)) {
          if (entry && typeof entry === 'object' && 'minHeight' in entry) held = Math.max(held, Number(entry.minHeight));
        }
      }
      return held;
    };
    expect(await heldRoom('medium')).toBeGreaterThan(0);
    // The Coach's own view lists freely: nothing is held there.
    expect(await heldRoom('large')).toBe(0);
  });
  it.each(['plain', 'e2ee'] as const)('names Work from the admitted protected Project producer and retires it on Account loss (%s)', async mode => {
    const previous = storage.getState();
    const scope = { serverId: 'home', accountId: 'work-label-account' };
    const cipher = createProjectAccountRowCipherV1({ mode,
      material: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(5) },
      randomBytes: length => new Uint8Array(length).fill(3) });
    // Native/owner-root accounting has an organization label without fabricating
    // a checkout that would retain a private path (the observed live Work producer).
    const rowKey = { kind: 'project-organization' as const, serverId: 'producer-cli-profile', projectKey: 'p1' };
    const content = cipher.seal({ key: rowKey, value: { label: 'Human project' } });
    // Exercise the exact QA label, distinct from its accounting key, through
    // protected storage; the old accounting-only filter never saw this ingress.
    const opaque = '84ae4f69031158170a5d5dd1f71dce833e983675d3632a33ead3592cba283061';
    const opaqueKey = { ...rowKey, projectKey: 'opaque-project' };
    const opaqueContent = cipher.seal({ key: opaqueKey, value: { label: opaque } });
    const otherOpaqueKey = { ...rowKey, projectKey: 'other-opaque-project' };
    const otherOpaqueContent = cipher.seal({ key: otherOpaqueKey, value: { label: 'b'.repeat(64) } });
    const namedWork = allocateUsageOutcomes({ contributions: [...contributions,
      { ...contribution('opaque', 'opaque-session', null), projectKey: opaqueKey.projectKey },
      { ...contribution('other-opaque', 'other-opaque-session', null), projectKey: otherOpaqueKey.projectKey }], evidence: [] });
    const owner = createProjectAccountRowsSync({ scope, cipher, isCurrent: () => true,
      transport: { list: async () => ({ status: 'listed', coverage: 'complete', rows: [{ key: rowKey, revision: 1, content },
        { key: opaqueKey, revision: 1, content: opaqueContent }, { key: otherOpaqueKey, revision: 1, content: otherOpaqueContent }] }),
        mutate: async () => { throw new Error('Label read must not mutate Project rows'); } },
      apply: (...args) => storage.getState().applyProjectAccountRowsForScope(scope, ...args) });
    try {
      storage.setState({ profileScope: scope });
      storage.getState().activateProjectAccountRowsScope(scope);
      await owner.refresh();
      const workSlice = { ...slice, work: namedWork };
      const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={workSlice} id="usage_project_ledger" testID="label-ledger" />);
      expect(screen.getTextContent()).toContain('Human project');
      expect(screen.getTextContent()).not.toContain(opaque);
      const hook = await renderHook(() => useUsageWork(workSlice, query, 'home'));
      expect(hook.getCurrent().summary?.projects).toMatchObject([
        { projectKey: 'p1' }, { projectKey: null, unnamedProjectCount: 2, amount: 6 },
      ]);
      await hook.unmount();
      await act(async () => storage.getState().setProjectAccountRowsStatusForScope(scope, 'locked'));
      expect(screen.getTextContent()).not.toContain('Human project');
      await act(async () => storage.getState().setProjectAccountRowsStatusForScope(scope, 'ready'));
      expect(screen.getTextContent()).toContain('Human project');
      await act(async () => storage.setState({ profileScope: { ...scope, serverId: 'other-home' } }));
      expect(screen.getTextContent()).not.toContain('Human project');
      await act(async () => storage.setState({ profileScope: scope }));
      expect(screen.getTextContent()).toContain('Human project');
      await act(async () => storage.setState({ profileScope: { ...scope, accountId: 'other-account' } }));
      expect(screen.getTextContent()).not.toContain('Human project');
      await screen.unmount();
    } finally {
      storage.setState({ profileScope: previous.profileScope, projectAccountRows: previous.projectAccountRows,
        pinnedWorkspaceRefIds: previous.pinnedWorkspaceRefIds });
    }
  });
  it('projects the measured growing request into Coach Why after a later zero-input observation', async () => {
    const rows = [100, 200, 300, 200, 0].map((input, index) => {
      const categories = { input, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0, total: input + 10 };
      return { ...contribution(`growth-${index}`, 'growth-session', `turn-${index}`),
        eventCount: 1, observedAtMs: 10 + index * 10, tokens: categories, tokenCategories: categories };
    });
    const evaluation = evaluateUsageCoach({ queryKey: key, period: { startMs: 0, endMs: 1000 }, asOfMs: 1000,
      currentness: 'current', accounting: { ...slice.accounting!, contributions: rows } });
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={{ ...slice, coach: evaluation }}
      id="usage_coach" testID="coach" />);
    await screen.pressByTestIdAsync('coach.finding.context_bloat.why-header');
    const measured = screen.findByTestId('coach.finding.context_bloat.evidence.measurements')!;
    const texts = measured.findAll(node => typeof node.props.children === 'string').map(node => node.props.children);
    expect(texts).toContain(`300 ${t('usage.board.coach.metric_composed_tokens')}`);
    expect(texts).not.toContain(`0 ${t('usage.board.coach.metric_composed_tokens')}`);
  });
  it('draws a finding\'s measured samples as its mini chart on the Coach view, never a single sample as a trend', async () => {
    const rows = [100, 200, 300, 200, 0].map((input, index) => {
      const categories = { input, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0, total: input + 10 };
      return { ...contribution(`growth-${index}`, 'growth-session', `turn-${index}`),
        eventCount: 1, observedAtMs: 10 + index * 10, tokens: categories, tokenCategories: categories };
    });
    const evaluation = evaluateUsageCoach({ queryKey: key, period: { startMs: 0, endMs: 1000 }, asOfMs: 1000,
      currentness: 'current', accounting: { ...slice.accounting!, contributions: rows } });
    const finding = evaluation.findings.find(entry => entry.detectorId === 'context_bloat')!;
    expect(finding.evidenceSeries?.[0]?.points.length).toBeGreaterThan(1);
    const single = { ...evaluation, findings: evaluation.findings.map(entry => entry === finding
      ? { ...entry, evidenceSeries: [{ ...entry.evidenceSeries![0]!, points: [entry.evidenceSeries![0]!.points[0]!] }] } : entry) };
    const wide = (coach: typeof evaluation) => <WidgetPresentationProvider value={{ size: 'large',
      footprint: { columns: 2, columnSpan: 2, rowSpan: 4, width: 'full', height: 'tall' }, geometry: { width: 1000, height: 800 } }}>
      <UsageCoachWidget {...props} slice={{ ...slice, coach }} id="usage_coach" testID="coach" />
    </WidgetPresentationProvider>;
    const once = await renderScreen(wide(single));
    expect(once.findByTestId('coach.finding.context_bloat')).toBeTruthy();
    expect(once.findHostByTestId('coach.finding.context_bloat.trend')).toBeFalsy();
    const screen = await renderScreen(wide(evaluation));
    expect(screen.findHostByTestId('coach.finding.context_bloat.trend')).toBeTruthy();
    // The spark's caption says it is the latest sample, not the finding's headline figure.
    expect(screen.getTextContent()).toContain(t('usage.board.coach.latestSample', { value: '' }).trim());
    // ...and says when that sample was taken, so a latest 0 beside a larger headline reads as a later moment.
    expect(screen.getTextContent()).toContain(formatUsageObservedAt(50));
  });
  it('does not open digest scheduling without a captured Account', async () => {
    const digestSlice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: slice.accounting!, status: 'available', asOfMs: 1000 }] }).results[0]!;
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={digestSlice} id="usage_coach" testID="coach" />);
    expect(screen.findByTestId('coach.digest.configure')).toBeTruthy();
    expect(screen.findByTestId('coach.digest.configure')?.props.disabled).toBe(true);
    expect(screen.findByTestId('coach.digest.editor')).toBeNull();
    await screen.pressByTestIdAsync('coach.digest.configure');
    expect(screen.findByTestId('coach.digest.editor')).toBeNull();
  });
  it('collapses the ledger summary to one sentence when nothing is linked, instead of repeating the total', async () => {
    const unlinked = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions, evidence: [] }));
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={{ ...slice, work: unlinked }} id="usage_project_ledger" testID="ledger" />);
    const summary = screen.findHostByTestId('ledger.conservation')!;
    const text = summary.findAll(node => typeof node.props.children === 'string').map(node => node.props.children as string).join(' ');
    expect(text).toContain(t('usage.board.work.noneLinked'));
    expect(text).not.toContain(t('usage.board.work.notLinked'));
    expect(text).not.toContain(t('usage.board.work.linkedToPrs'));
  });
  it('bounds the project ledger behind Show all and says the PR qualifier once for the band, not on every row', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ ...contribution(`m${index}`, `ms${index}`, null), projectKey: `project-${index}` }));
    const unlinked = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: many, evidence: [] }));
    const accounting = { ...slice.accounting!, breakdowns: { project: many.map(row => ({ key: row.projectKey,
      label: `Project ${row.projectKey}`, eventCount: 1, tokens: row.tokens, cost: row.cost })) } };
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={{ ...slice, work: unlinked, accounting }} id="usage_project_ledger" testID="ledger" />);
    // A long list leads with its largest rows; the rest are one press away, never a wall.
    expect(screen.findByTestId('ledger.project.project-11')).toBeNull();
    expect(screen.findByTestId('ledger.projects.more')).toBeTruthy();
    const text = screen.getTextContent();
    // Nothing is linked anywhere, so no row repeats "0 linked PRs" or its unlinked amount.
    expect(text).not.toContain(t('usage.board.work.ledgerRowLine', { sessions: 1, prs: 0 }));
    expect(text).not.toContain(t('usage.board.work.notLinkedPart', { amount: '' }).trim());
    expect(text).toContain(t('usage.board.work.noneLinked'));
    await screen.pressByTestIdAsync('ledger.projects.more.toggle');
    expect(screen.findByTestId('ledger.project.project-11')).toBeTruthy();
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
    // The Session without a binding never borrows the Agent's name, and an unknown provider is not
    // information: no "Provider: Not recorded" line (quiet truth).
    expect(screen.getTextContent()).not.toContain('Not recorded');
  });
  it('holds How you work bodies in their reading state while that read is pending, never "aren\'t readable here"', async () => {
    const pending = { ...slice, howYouWork: undefined, sources: [...slice.sources.filter(source => source.source !== 'how_you_work'),
      { source: 'how_you_work', status: 'pending' as const }] };
    for (const [Widget, id] of [[UsageHumanLoopWidget, 'usage_human_loop'], [UsageParallelWidget, 'usage_parallel']] as const) {
      const screen = await renderScreen(<Widget {...props} slice={pending} id={id} testID="hyw" />);
      expect(screen.findByTestId('hyw.loading')).toBeTruthy();
      expect(screen.findByTestId('hyw.empty')).toBeFalsy();
    }
  });
  it('leads "What they waited for" with the longest waits and keeps the long tail behind Show all', async () => {
    const base = resolveUsageHowYouWork({ period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0, detail: { status: 'available', facts: [] } });
    const byTool = Array.from({ length: 12 }, (_, index) => ({ toolId: `tool${index}`, requestCount: 1, pairedDecisionCount: 1, decisionLatencyMs: (12 - index) * 60_000 }));
    const howYouWork = { ...base, permissions: { requestCount: 12, pairedDecisionCount: 12, decisionLatencyMs: 78 * 60_000, unknownRequestTimeCount: 0,
      unknownDecisionTimeCount: 0, byAnsweringClient: { ios: 0, android: 0, web: 0, desktop: 0, unknown: 0 }, byTool } };
    const screen = await renderScreen(<UsageHumanLoopWidget {...props} slice={{ ...slice, howYouWork }} id="usage_human_loop" testID="loop" />);
    expect(screen.getTextContent()).toContain('tool0');
    expect(screen.getTextContent()).not.toContain('tool11');
    await screen.pressByTestIdAsync('loop.tools.more.toggle');
    expect(screen.getTextContent()).toContain('tool11');
  });
  it('opens a selected Session autopsy with exact contribution, checkpoint and witnessed wait phases', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
    const howYouWork = resolveUsageHowYouWork({ period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0,
      detail: { status: 'partial', phaseEvents: [{ evidenceId: 'native-compaction', sessionId: 's1', turnId: 't1',
        observedAtMs: 400, kind: 'compaction', method: 'native_event' }], facts: [
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
    expect(screen.findByTestId('value.autopsy.costTimeline')).toBeTruthy();
    expect(screen.findByTestId('value.autopsy.phases-select-checkpoint:' + 'a'.repeat(40))).toBeNull();
    expect(screen.findByTestId('value.autopsy.phases-select-commit:' + 'b'.repeat(40))).toBeNull();
    expect(text).toContain('Compaction');
    expect(screen.findByTestId('value.autopsy.unknownEnds')).toBeTruthy();
  });
  it('says only the PR is missing for a turn whose commit is linked, and keeps the broad absence for a turn with no git evidence', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
    const branch = { ref: 'refs/heads/master', headSha: 'b'.repeat(40) };
    const linked = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({
      contributions: [contribution('with-commit', 's1', 't1'), contribution('bare', 's1', 't2')], evidence: [],
      branchEvidence: [{ sessionId: 's1', turnId: 't1', repositoryKey: 'opaque-repo', checkpointRef: 'checkpoint/s1/t1',
        checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', branch }] }));
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={{ ...slice, shownQuery: sessionQuery, work: linked }} id="usage_session_value" testID="value" />);
    const text = screen.getTextContent();
    expect(text).toContain('bbbbbbb');
    expect(text).toContain(t('usage.board.work.reason_missing_pr'));
    expect(text).toContain(t('usage.board.work.reason_missing_evidence'));
    // The turn's one caption line leads with the PR state and what was linked, and ends with the long checkpoint ref.
    const linkedRow = screen.findAllByType(HappierDataRows).find(rows => rows.props.testID === 'value.autopsy.turns')!.props.rows.find((row: readonly unknown[]) => String(row[3]).includes('bbbbbbb'));
    expect(linkedRow[2]).toBe(t('usage.board.work.reason_missing_pr'));
    expect(String(linkedRow[linkedRow.length - 1])).toContain('checkpoint/s1/t1');
  });
  it('formats witnessed Autopsy git moments in the preferred language without changing their instants', async () => {
    const previous = getPreferredLanguage();
    const committedAtMs = 500;
    const checkpointCommittedAtMs = 300;
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
    const timedWork = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions,
      evidence: [{ ...evidence('s1', 't1', 2493), committedAtMs, checkpointCommittedAtMs }] }));
    try {
      setPreferredLanguageFromSettings('fr');
      await preloadTranslations();
      const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
        slice={{ ...slice, shownQuery: sessionQuery, work: timedWork }} id="usage_session_value" testID="value" />);
      const formatted = new Intl.DateTimeFormat('fr', { dateStyle: 'medium', timeStyle: 'short' }).format(committedAtMs);
      expect(screen.getTextContent()).toContain(formatted);
      expect(screen.findByType(IntervalTimeline).props.intervals).toContainEqual(expect.objectContaining({
        id: `commit:${'b'.repeat(40)}`, start: committedAtMs, end: committedAtMs, annotation: expect.stringContaining(formatted),
      }));
      expect(screen.findByType(IntervalTimeline).props.intervals).toContainEqual(expect.objectContaining({
        id: `checkpoint:${'a'.repeat(40)}`, start: checkpointCommittedAtMs, end: checkpointCommittedAtMs,
      }));
    } finally {
      setPreferredLanguageFromSettings(previous);
      await preloadTranslations();
    }
  });
  it('names the admitted historical model and machine through the existing catalog and display reader', async () => {
    const previous = storage.getState().machineDisplayById;
    const machine = createMachineFixture({ id: 'machine' });
    storage.setState({ machineDisplayById: { ...previous, machine: { ...machine,
      metadata: { ...machine.metadata!, displayName: 'Evidence workstation' } } } });
    try {
      const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
      const namedWork = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: [{ ...contribution('named', 's1', 't1'), modelId: 'claude-opus-4-5' }], evidence: [] }));
      const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
        slice={{ ...slice, shownQuery: sessionQuery, work: namedWork }} id="usage_session_value" testID="value" />);
      expect(screen.getTextContent()).toContain('Opus 4.5');
      expect(screen.getTextContent()).toContain('Evidence workstation');
      const unknownWork = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: [{ ...contribution('unlisted', 's1', 't1'),
        modelId: 'third-party/model-snapshot', machineId: 'unknown-machine-uuid' }], evidence: [] }));
      await screen.update(<UsageSessionValueWidget {...props} query={sessionQuery}
        slice={{ ...slice, shownQuery: sessionQuery, work: unknownWork }} id="usage_session_value" testID="value" />);
      expect(screen.getTextContent()).toContain('third-party/model-snapshot');
      expect(screen.getTextContent()).not.toContain('Third Party Model Snapshot');
      expect(screen.getTextContent()).not.toContain('unknown-machine-uuid');
    } finally { await act(async () => { storage.setState({ machineDisplayById: previous }); }); }
  });
  it('shows independently known Work currencies and kinds without using the mixed whole as their formatter', async () => {
    const rows = [{ ...contribution('eur', 'eur-session', 'eur-turn'), projectKey: 'eur-project',
      cost: { reportedUsd: 3, estimatedUsd: 4, currency: 'EUR' } },
    { ...contribution('usd', 'usd-session', 'usd-turn'), projectKey: 'usd-project',
      cost: { reportedUsd: 0, estimatedUsd: 4, currency: 'USD', costSource: 'pricing_estimate' as const } }];
    const mixedQuery = normalizeUsageQuery({ ...query, costBasis: 'auto' });
    const mixedSlice: UsageQueryResultSlice = { ...slice, shownQuery: mixedQuery,
      work: UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions: rows, evidence: [evidence('eur-session', 'eur-turn', 1),
        evidence('usd-session', 'usd-turn', 2)] })),
      accounting: { ...slice.accounting!, totals: { ...slice.accounting!.totals,
        cost: { reportedUsd: 3, estimatedUsd: 4, currency: 'MIXED' } },
        breakdowns: { project: rows.map(row => ({ key: row.projectKey, label: row.projectKey === 'eur-project' ? 'Europe' : 'America',
          eventCount: 1, tokens: row.tokens, cost: row.cost })) } } };
    for (const [Widget, id] of [[UsageProjectLedgerWidget, 'usage_project_ledger'], [UsageSessionValueWidget, 'usage_session_value'], [UsageOutcomesWidget, 'usage_outcomes']] as const) {
      const screen = await renderScreen(<Widget {...props} query={mixedQuery} slice={mixedSlice} id={id} testID="work" />);
      const text = screen.getTextContent();
      expect(text).toContain('€3.00');
      expect(text).toContain('$4.00');
      expect(text).toContain('reported');
      expect(text).toContain('estimated');
      expect(text).not.toContain('$3.00');
    }
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
      const narrowed = navigation.mock.calls.at(-1)?.[0];
      if (!narrowed || typeof narrowed !== 'object' || !('params' in narrowed) || !narrowed.params
        || !('scope' in narrowed.params) || typeof narrowed.params.scope !== 'string') throw new Error('Expected a scoped Usage route');
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
      <WidgetPresentationProvider value={{ size: 'full',
        footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'tall' },
        geometry: { width: 700, height: 500 } }}>
        <UsageSessionValueWidget {...props} id="usage_session_value" testID="value" />
      </WidgetPresentationProvider>,
    );
    expect(screen.findByType(OutcomeScatter).props.points).toMatchObject([
      { id: 's1', x: 6, y: 1 },
    ]);
    const unlinked = screen.findAllByType(RankedRows).find(rows => rows.props.testID === 'value.unlinked');
    expect(unlinked?.props.rows).toMatchObject([{ id: 's2', value: 3 }]);
    expect(screen.findHostByTestId('value.open.s2')).not.toBeNull();
  });

  it('shows unlinked Sessions once when a wide scatter has no witnessed outcome axis', async () => {
    const unlinked = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions, evidence: [] }));
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'full',
      footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'tall' },
      geometry: { width: 700, height: 500 } }}>
      <UsageSessionValueWidget {...props} slice={{ ...slice, work: unlinked }} id="usage_session_value" testID="value" />
    </WidgetPresentationProvider>);
    expect(screen.findByTestId('value.scatter')).toBeFalsy();
    expect(screen.findAllHostsByTestId('value.open.s1')).toHaveLength(1);
    expect(screen.findAllHostsByTestId('value.open.s2')).toHaveLength(1);
  });

  it('outcomes shows the exact PR and the session funnel', async () => {
    const screen = await renderScreen(
      <UsageOutcomesWidget {...props} id="usage_outcomes" testID="outcomes" />,
    );
    expect(screen.findByType(OutcomeFunnel).props.steps).toMatchObject([
      { id: 'sessions', value: 2 },
      { id: 'witnessed', value: 1 },
      { id: 'allocated', value: 1 },
      { id: 'merged', value: 1 },
    ]);
    expect(screen.getTextContent()).toContain('2493');
  });

  it('outcomes with no PR evidence says so once instead of drawing a funnel that stops at its first step', async () => {
    const bare = UsageWorkProjectionSchema.parse(allocateUsageOutcomes({ contributions, evidence: [] }));
    const screen = await renderScreen(
      <UsageOutcomesWidget {...props} slice={{ ...slice, work: bare }} id="usage_outcomes" testID="outcomes" />,
    );
    expect(screen.findByTestId('outcomes.funnel')).toBeFalsy();
    expect(screen.findByTestId('outcomes.noPrs')).toBeTruthy();
  });

  it('coach on Overview is the findings alone: no facts band, checks, digest or preferences', async () => {
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'full',
      footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'tall' }, geometry: { width: 900, height: 300 } }}>
      <UsageCoachWidget {...props} id="usage_coach" testID="coach" />
    </WidgetPresentationProvider>);
    expect(screen.findByTestId('coach.finding.compaction_storms')).toBeTruthy();
    expect(screen.findByTestId('coach.summary')).toBeFalsy();
    expect(screen.findByTestId('coach.checks')).toBeFalsy();
    expect(screen.findByTestId('coach.configure')).toBeFalsy();
  });

  it('says a finding in its measured facts; observation counts and coverage wait behind Why (R7)', async () => {
    const screen = await renderScreen(
      <UsageCoachWidget {...props} id="usage_coach" testID="coach" />,
    );
    const finding = coach.findings[0]!;
    const meta = screen.findByTestId('coach.finding.compaction_storms.meta')!;
    const metaText = String(meta.props.children);
    expect(metaText).toContain(`${finding.measurements[0]!.value} ${t(`usage.board.coach.metric_${finding.measurements[0]!.metric}`)}`);
    // Mechanism words (observation counts, evidence coverage) are method facts, not the finding's line.
    const evidenceLine = t('usage.board.coach.evidenceLine', { count: finding.evidence.length,
      coverage: t(`usage.board.coach.coverage_${finding.coverage}`) });
    expect(metaText).not.toContain(evidenceLine);
    expect(screen.getTextContent()).not.toContain(evidenceLine);
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.why-header');
    expect(screen.getTextContent()).toContain(evidenceLine);
    await screen.update(<UsageCoachWidget {...props} id="usage_coach" testID="coach"
      model={{ ...props.model, pending: true, refreshing: true, freshness: 'stale' }}
      slice={{ ...slice, pending: true, coach: { ...coach, currentness: 'stale', asOfMs: 1100 } }} />);
    expect(screen.findByTestId('coach.finding.compaction_storms.evidence')).toBeTruthy();
    expect(screen.getTextContent()).toContain(evidenceLine);
  });

  it('lists a finding\'s many observations behind Why as a led list with Show all, not a wall of lines', async () => {
    const first = coach.findings[0]!;
    const observation = first.evidence[0]!;
    const many = { ...coach, findings: [{ ...first,
      evidence: Array.from({ length: 40 }, (_, index) => ({ ...observation, id: `obs-${index}`, observedAtMs: observation.observedAtMs + index * 60_000 })) },
      ...coach.findings.slice(1)] };
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={{ ...slice, coach: many }} id="usage_coach" testID="coach" />);
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.why-header');
    const listed = () => new Set(screen.findAll(node => String(node.props.testID ?? '').startsWith('coach.finding.compaction_storms.evidence.obs-'))
      .map(node => node.props.testID)).size;
    expect(listed()).toBeLessThan(10);
    expect(listed()).toBeGreaterThan(0);
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.evidence.showAll.toggle');
    expect(listed()).toBe(40);
  });

  it('coach shows the evidence-backed finding, hides a dismissed one and keeps insufficient checks visible', async () => {
    const screen = await renderScreen(
      <UsageCoachWidget {...props} id="usage_coach" testID="coach" />,
    );
    expect(screen.findByTestId('coach.finding.compaction_storms')).toBeTruthy();
    expect(screen.findByTestId('coach.finding.compaction_storms.why')).toBeTruthy();
    expect(screen.findByTestId('coach.finding.compaction_storms.evidence')).toBeFalsy();
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.why-header');
    expect(screen.findByTestId('coach.finding.compaction_storms.evidence')).toBeTruthy();
    // A citation reads as its site; its exact address is the link's accessible name and target.
    const citation = coach.findings[0]!.basis.citations[0]!;
    expect(screen.getTextContent()).toContain(new URL(citation.url).host);
    expect(screen.findAll(node => node.props.accessibilityRole === 'link'
      && String(node.props.accessibilityLabel ?? '').startsWith(citation.url))).not.toHaveLength(0);
    expect(screen.getTextContent()).toContain(coach.findings[0]!.basis.limitations[0]!);
    expect(screen.findByTestId('coach.finding.compaction_storms.evidence.c1')).toBeTruthy();
    expect(String(screen.findByTestId('coach.finding.compaction_storms.evidence.c1')!.props.children)).not.toContain('c1');
    const measurements = screen.findByTestId('coach.finding.compaction_storms.evidence.measurements')!;
    const measurementsText = measurements.findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children).join(' ');
    const observedCompactions = coach.findings[0]!.measurements.find(measurement => measurement.metric === 'compactions')!;
    expect(measurementsText).toContain(`${observedCompactions.value} ${t('usage.board.coach.metric_compactions')}`);
    expect(screen.getTextContent()).not.toContain(coach.findings[0]!.basis.method);
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.evidence.diagnostics-header');
    expect(screen.getTextContent()).toContain(coach.findings[0]!.basis.method);
    expect(screen.findByTestId('coach.checks-header')).toBeTruthy();
    const dismissed = applyUsageCoachPreferences(
      coach,
      {
        ...DEFAULT_USAGE_COACH_PREFERENCES_V1,
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
    expect(hidden.findByTestId('coach.hidden-header')).toBeTruthy();
    await hidden.pressByTestIdAsync('coach.hidden-header');
    expect(hidden.findByTestId('coach.hidden.compaction_storms.restore')).toBeTruthy();
  });
});
