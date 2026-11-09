// @vitest-environment jsdom
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginUiPageNavigationV1 } from '@happier-dev/plugin-sdk/ui';
import {
  ForgeCiActionInputSchemasV1,
  ForgeCiJobV1Schema,
  type ForgeCiOperationIdV1,
  type ForgeCiRunV1,
} from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { createForgeCiAdapterV1 } from '../../runtime/adapter.js';
import { createForgeCiReadsV1 } from '../../runtime/reads.js';
import type { ForgeCiBindingV1 } from './binding.js';
import { presentForgeCiStatusV1 } from './ciStatus.js';
import { formatForgeCiDurationV1 } from './format.js';
import { ForgeCiRunDetailView } from './ForgeCiRunDetailView.js';
import { ForgeCiRailPanel } from './ForgeCiRailPanel.js';
import { ForgeCiStateNotice } from './ForgeCiStateNotice.js';
import { createForgeCiMountedViewV1 } from '../mountedCiIntent.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  await act(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
  });
});

const RUNNING = {
  phase: 'running',
  outcome: null,
  nativeLabel: 'in_progress',
  outcomeBucket: 'pending',
} as const;

/** The real adapter and read owner over a boundary invoker; only the host Action transport is a fixture. */
function boundary(
  options: Readonly<{
    run?: Partial<ForgeCiRunV1>;
    cancel?: 'accepted' | 'lost';
    declined?: 'forceCancelRun' | 'approveForkRun';
  }> = {},
) {
  const native = createForgeCiConformanceVectorsV1().github;
  const run = {
    ...native.run,
    title: 'feat(protocol): project source schema',
    ...options.run,
  } as ForgeCiRunV1;
  const job = {
    ...native.job,
    state: run.state.phase === 'completed' ? native.job.state : run.state,
  };
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const actionRefs = Object.fromEntries(
    Object.keys(ForgeCiActionInputSchemasV1).map((key) => [
      key,
      { pluginId: 'fixture.forge', localId: key },
    ]),
  ) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
  const adapter = createForgeCiAdapterV1({
    actionRefs,
    invoke: async (action, input) => {
      calls.push(action.localId);
      inputs.push(input);
      if (action.localId === options.declined) throw new PluginError({ code: 'denied', diagnostics: [
        { severity: 'error', code: 'plugin_action_current_intent_rejected' },
      ] });
      if (action.localId === 'approveForkRun') return { kind: 'accepted', affected: { repository: run.ref.repository, run: run.ref } };
      if (action.localId === 'cancelRun') {
        if (options.cancel === 'lost')
          throw new Error('transport closed before the answer');
        return {
          kind: 'accepted',
          affected: { repository: run.ref.repository, run: run.ref },
        };
      }
      const value =
        action.localId === 'readRun'
          ? run
          : {
              rows: action.localId === 'listJobs' ? [job] : [],
              omittedRowCount: 0,
              projectionTruncated: false,
              continuation: null,
              incomplete: null,
            };
      return { kind: 'value', value };
    },
  });
  const reads = createForgeCiReadsV1({
    adapter,
    scopeKey: 'account/credential/origin',
  });
  const ci: ForgeCiBindingV1 = {
    reads,
    adapter,
    actionRefs,
    account: null,
    about: {
      forgeName: 'GitHub',
      accountLabel: 'leeroybrun',
      machineLabel: null,
    },
    fix: () => undefined,
  };
  return { run, job, calls, inputs, reads, ci };
}

async function mount(element: React.ReactElement, navigation?: Array<PluginUiPageNavigationV1 | null>) {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'ci-views', mountNonce: 'ci-views-mount' },
      authorPlugin: { id: 'fixture.forge', version: '0.0.0' },
      surface: defineUiSurface(() => element),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({}),
      launchInput: null,
      handlers: navigation === undefined ? {} : { setPageNavigation: ({ navigation: value }) => { navigation.push(value); } },
    });
  });
  mounted.push(fixture);
  return fixture;
}

describe('shared CI status presentation', () => {
  it('sends the displayed full fork provenance through the one declared approval Action', async () => {
    const headSha = 'f'.repeat(40);
    const contributor = 'fork-contributor';
    const sourceRepository = { ...createForgeCiConformanceVectorsV1().github.repository, repository: 'fork-contributor/project' };
    const b = boundary({ run: { headSha, forkApproval: { required: true, contributor, sourceRepository },
      state: { phase: 'waiting', outcome: null, nativeLabel: 'action_required', outcomeBucket: 'pending' } } });
    try {
      const fixture = await mount(<ForgeCiRunDetailView ci={b.ci} selection={b.job.ref.selection} presentation="embedded" onOpenJob={() => undefined} />);
      await fixture.press(await fixture.getByRole('button', { name: 'Approve fork run' }));
      const index = b.calls.indexOf('approveForkRun');
      expect(index).toBeGreaterThanOrEqual(0);
      expect(b.inputs[index]).toMatchObject({ repository: b.run.ref.repository, runId: b.run.ref.runId,
        attempt: '2', headSha, contributor, sourceRepository });
      expect(b.calls.filter(call => call === 'approveForkRun')).toHaveLength(1);
    } finally { b.reads.retire(); }
  });

  it('never draws an unknown or stale outcome as a pass, and keeps waiting distinct from running', () => {
    expect(
      presentForgeCiStatusV1({
        phase: 'unknown',
        outcome: 'unknown',
        nativeLabel: 'x',
        outcomeBucket: 'unknown',
      }).kind,
    ).toBe('unknown');
    expect(
      presentForgeCiStatusV1({
        phase: 'completed',
        outcome: 'stale',
        nativeLabel: 'stale',
        outcomeBucket: 'neutral',
      }).kind,
    ).toBe('neutral');
    expect(
      presentForgeCiStatusV1({
        phase: 'completed',
        outcome: 'timed_out',
        nativeLabel: 'timed_out',
        outcomeBucket: 'failed',
      }),
    ).toMatchObject({ kind: 'failed', word: 'Timed out' });
    expect(
      presentForgeCiStatusV1({
        phase: 'waiting',
        outcome: null,
        nativeLabel: 'waiting',
        outcomeBucket: 'pending',
      }).kind,
    ).toBe('waiting');
  });
});

describe('rate-limit read recovery', () => {
  it('attributes a refused execution to the project Machine instead of a GitHub request', async () => {
    const fixture = await mount(<ForgeCiStateNotice presentation="surface"
      about={{ forgeName: 'GitHub', subject: 'runs' }}
      state={{ kind: 'failure', failure: { class: 'transient', code: 'ci_execution_unavailable' }, stale: false, recovery: 'none' }} />);
    await fixture.getByText('This project’s Machine can’t run GitHub Actions right now. Nothing on GitHub was changed.');
    expect(await fixture.queryByText('GitHub didn’t answer. Nothing on GitHub was changed.')).toBeUndefined();
  });

  it.each(['surface', 'line'] as const)('keeps explicit recovery reachable in the %s notice without a provider deadline', async presentation => {
    let refreshes = 0;
    const fixture = await mount(<ForgeCiStateNotice
      state={{ kind: 'failure', failure: { class: 'rateLimit', code: 'provider_throttled' }, stale: presentation === 'line', recovery: 'none' }}
      about={{ forgeName: 'GitHub', subject: 'this run' }}
      presentation={presentation}
      onRetry={() => { refreshes++; }}
    />);
    const retry = await fixture.getByRole('button', { name: presentation === 'line' ? 'Retry' : 'Try again' });
    await fixture.press(retry);
    expect(refreshes).toBe(1);
  });
});

describe('ForgeCiRunDetailView', () => {
  it('opens a routed job on Jobs and returns to the real Summary through the same controlled page Tabs', async () => {
    const b = boundary();
    const navigation: Array<PluginUiPageNavigationV1 | null> = [];
    const pageKind = { pluginId: 'fixture.forge', localId: 'ci-run' };
    function RoutedRun() {
      const [jobId, setJobId] = React.useState<string | null>(b.job.ref.jobId);
      return <ForgeCiRunDetailView ci={b.ci} selection={b.job.ref.selection} presentation="page" pageKind={pageKind}
        selectedJobId={jobId} jobView={<Text value="Selected CI output" />}
        onOpenJob={job => setJobId(job.jobId)} onOpenSummary={() => setJobId(null)} />;
    }
    try {
      const fixture = await mount(<RoutedRun />, navigation);
      expect(navigation.at(-1)).toMatchObject({ value: 'jobs' });
      await expect(fixture.getByText('Selected CI output')).resolves.toBeDefined();
      await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({ page: { columnVisible: true,
        navigation: { pageKind, presentation: 'top', tabIds: ['jobs', 'summary'], request: 'summary' },
      } })); });
      expect(navigation.at(-1)).toMatchObject({ value: 'summary' });
      const tabs = await fixture.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      expect(tabs[0]?.name).toMatch(/^Jobs\b/u);
      expect(tabs[1]?.name).toBe('Summary');
      expect(await fixture.queryByText('Selected CI output')).toBeUndefined();
      await expect(fixture.getByText(b.run.title ?? '')).resolves.toBeDefined();
      expect(b.calls).not.toContain('readJobLog');
    } finally { b.reads.retire(); }
  });

  it('publishes Summary and Jobs for a page, selects the real Jobs view from the phone host, and keeps pane tabs local', async () => {
    const b = boundary();
    const navigation: Array<PluginUiPageNavigationV1 | null> = [];
    const pageKind = { pluginId: 'fixture.forge', localId: 'ci-run' };
    try {
      const fixture = await mount(<ForgeCiRunDetailView ci={b.ci} selection={b.job.ref.selection}
        presentation="page" pageKind={pageKind} onOpenJob={() => undefined} />, navigation);
      expect(navigation.at(-1)).toMatchObject({ pageKind, value: 'summary', items: [
        { value: 'summary', title: 'Summary' }, { value: 'jobs', title: 'Jobs' },
      ] });
      await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({ platform: 'ios', page: { columnVisible: true,
        navigation: { pageKind, presentation: 'bottom', tabIds: [], request: 'jobs' },
      } })); });
      expect(navigation.at(-1)).toMatchObject({ value: 'jobs' });
      expect(await fixture.queryAllByRole('tab')).toHaveLength(0);
      await expect(fixture.getByText(b.job.name)).resolves.toBeDefined();
      expect(b.calls.filter(id => id === 'readRun')).toHaveLength(1);
      expect(b.calls.filter(id => id === 'listJobs')).toHaveLength(1);
      expect(b.calls.some(id => ['readJobLog', 'listAnnotations', 'readWorkflow'].includes(id))).toBe(false);
      const paneNavigation: Array<PluginUiPageNavigationV1 | null> = [];
      const pane = await mount(<ForgeCiRunDetailView ci={b.ci} selection={b.job.ref.selection}
        presentation="pane" onOpenJob={() => undefined} />, paneNavigation);
      expect(paneNavigation).toEqual([]);
      const paneTabs = await pane.getAllByRole('tab');
      expect(paneTabs).toHaveLength(2);
      expect(paneTabs[0]?.name).toBe('Summary');
      expect(paneTabs[1]?.name).toMatch(/^Jobs\b/u);
    } finally { b.reads.retire(); }
  });

  it('leads a failed run with what failed from the jobs projection, reading no logs, annotations or workflow files', async () => {
    const { ci, calls, reads, job } = boundary();
    try {
      const fixture = await mount(
        <ForgeCiRunDetailView
          ci={ci}
          selection={job.ref.selection}
          presentation="embedded"
          onOpenJob={() => undefined}
        />,
      );
      await fixture.getByText('feat(protocol): project source schema');
      await fixture.getByRole('button', { name: 'Re-run failed jobs' });
      await fixture.getByRole('button', { name: 'Fix in a session' });
      await fixture.getByText('failed in “Test”');
      expect(calls).not.toContain('readJobLog');
      expect(calls).not.toContain('listAnnotations');
      expect(calls).not.toContain('readFailureContext');
      expect(calls).not.toContain('readTrigger');
      expect(calls).not.toContain('readJob');
    } finally {
      await act(async () => {
        reads.retire();
      });
    }
  });

  it('offers Force-cancel only once a normal cancel was accepted and the run is still going', async () => {
    const { ci, reads, job } = boundary({
      run: { state: RUNNING, webUrl: 'https://github.com/example/project/actions/runs/101' },
      cancel: 'accepted',
    });
    try {
      const fixture = await mount(
        <ForgeCiRunDetailView
          ci={ci}
          selection={job.ref.selection}
          presentation="embedded"
          onOpenJob={() => undefined}
        />,
      );
      expect(await fixture.queryByRole('button', { name: 'Force-cancel…' })).toBeUndefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Cancel run' }));
      await fixture.getByRole('button', { name: 'Cancelling…' });
      await fixture.getByRole('button', { name: 'Force-cancel…' });
    } finally {
      await act(async () => {
        reads.retire();
      });
    }
  });

  it.each(['forceCancelRun', 'approveForkRun'] as const)('shows a declined %s as not done with its cause and no reread', async operation => {
    const native = createForgeCiConformanceVectorsV1().github;
    const b = boundary({ declined: operation, run: { state: RUNNING,
      ...(operation === 'approveForkRun' ? { headSha: 'f'.repeat(40), forkApproval: {
        required: true, contributor: 'fixture-contributor', sourceRepository: native.repository,
      } } : {}),
    } });
    try {
      const fixture = await mount(<ForgeCiRunDetailView ci={b.ci} selection={b.job.ref.selection}
        presentation="embedded" onOpenJob={() => undefined} />);
      if (operation === 'forceCancelRun') await fixture.press(await fixture.getByRole('button', { name: 'Cancel run' }));
      const readsBefore = b.calls.filter(call => call === 'readRun' || call === 'listJobs').length;
      await fixture.press(await fixture.getByRole('button', { name: operation === 'forceCancelRun' ? 'Force-cancel…' : 'Approve fork run' }));
      await fixture.getByText('You declined the confirmation. Nothing on GitHub was changed.');
      expect(await fixture.queryByText('Result unknown — check on GitHub')).toBeUndefined();
      expect(b.calls.filter(call => call === 'readRun' || call === 'listJobs')).toHaveLength(readsBefore);
    } finally { await act(async () => { b.reads.retire(); }); }
  });

  it('says a lost cancel answer is unknown and never sends it again', async () => {
    const { ci, calls, reads, job } = boundary({
      run: { state: RUNNING },
      cancel: 'lost',
    });
    try {
      const fixture = await mount(
        <ForgeCiRunDetailView
          ci={ci}
          selection={job.ref.selection}
          presentation="embedded"
          onOpenJob={() => undefined}
        />,
      );
      await fixture.press(
        await fixture.getByRole('button', { name: 'Cancel run' }),
      );
      await fixture.getByText('Result unknown — check on GitHub');
      expect(calls.filter((call) => call === 'cancelRun')).toHaveLength(1);
      expect(await fixture.queryByRole('button', { name: 'Force-cancel…' })).toBeUndefined();
    } finally {
      await act(async () => {
        reads.retire();
      });
    }
  });
});

describe('live durations', () => {
  it('opens output GitHub cannot pin to one step under the failed step it may belong to, keeping its uncertainty', async () => {
    // The captured job (four steps in one whole second) and its real log: every line fits all four steps.
    const captured = ForgeCiJobV1Schema.parse(JSON.parse(readFileSync('src/runtime/logs/github-failed-job.fixture.json', 'utf8')));
    // GitHub's step times are whole seconds; the native mapper declares that, as the live job carries it.
    const job = captured.steps.kind === 'available'
      ? { ...captured, steps: { ...captured.steps, values: captured.steps.values.map((step) => ({ ...step, timestampPrecision: 'second' as const })) } }
      : captured;
    const text = readFileSync('../plugins/scm-github/src/ui/forge/actions/ActionsPage.failed-job.fixture.txt', 'utf8');
    const native = createForgeCiConformanceVectorsV1().github;
    const run = { ...native.run, ref: job.ref.selection.kind === 'attempt' ? job.ref.selection.attempt.run : native.run.ref } as ForgeCiRunV1;
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map((key) => [key, { pluginId: 'fixture.forge', localId: key }])) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
    const adapter = createForgeCiAdapterV1({
      actionRefs,
      invoke: async (action) => {
        const id = action.localId;
        const value = id === 'readRun' ? run
          : id === 'readJob' ? job
            : id === 'readJobLog' ? { kind: 'available', job: job.ref, logId: 'captured', text, startLine: 1, startByte: 0, complete: true, continuation: null }
              : { rows: id === 'listJobs' ? [job] : [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null };
        return { kind: 'value', value };
      },
    });
    const reads = createForgeCiReadsV1({ adapter, scopeKey: 'account/credential/origin' });
    const ci: ForgeCiBindingV1 = { reads, adapter, actionRefs, account: null, about: { forgeName: 'GitHub', accountLabel: null, machineLabel: null } };
    // The log needs the mounted view a real host mount supplies; the bare fixture context carries no mount id.
    const view = createForgeCiMountedViewV1({ mountId: 'log-placement', phone: false });
    try {
      const fixture = await mount(
        <ForgeCiRunDetailView ci={ci} view={view} selection={job.ref.selection} presentation="pane" selectedJobId={job.ref.jobId} onOpenJob={() => undefined} />,
      );
      await fixture.findByRole('button', { name: 'Copy log' });
      const buttons = await fixture.getAllByRole('button');
      const names = buttons.map((target) => target.name);
      const failed = names.indexOf('forge-qa matrix test');
      expect(failed, JSON.stringify(names)).toBeGreaterThanOrEqual(0);
      // It sits right under the failed step and still says it is shared, never relabelled as that step's output.
      const shared = buttons[failed + 1];
      expect(shared?.name, JSON.stringify(names)).toBe('Output between Set up job and Complete job');
      // It opens with the log, so the failure's lines are there to read without hunting for them.
      expect(shared?.state?.expanded).toBe(true);
    } finally {
      await act(async () => { view.dispose(); reads.retire(); });
    }
  });

  it('shows Took from the admitted completed run update without another timing read', async () => {
    const { ci, reads, calls, job } = boundary({ run: { startedAtMs: 1000, updatedAtMs: 19000 } });
    try {
      const fixture = await mount(<ForgeCiRunDetailView ci={ci} selection={job.ref.selection} presentation="embedded" onOpenJob={() => undefined} />);
      await fixture.getByText('Took');
      await fixture.getByText('18s');
      expect(calls.filter(call => call === 'readRun')).toHaveLength(1);
      expect(calls).not.toContain('readJob');
      expect(calls).not.toContain('readJobLog');
    } finally {
      await act(async () => { reads.retire(); });
    }
  });

  it('ticks only the running duration leaf: the panel and its rows are not re-projected each second', async () => {
    const native = createForgeCiConformanceVectorsV1().github;
    const startedAtMs = Date.now() - 65_000;
    const run = (index: number, running: boolean): ForgeCiRunV1 => ({
      ...native.run,
      ref: { ...native.run.ref, runId: String(500 + index) },
      number: 500 + index,
      headSha: 'a'.repeat(40),
      headRef: 'main',
      workflow: { id: `wf-${index}` },
      startedAtMs: running ? startedAtMs : startedAtMs - 600_000,
      // Completed rows must not match the running leaf's one-minute text query.
      ...(running ? { state: RUNNING } : { completedAtMs: startedAtMs - 420_000, state: { phase: 'completed', outcome: 'success', nativeLabel: 'success', outcomeBucket: 'passed' } }),
    }) as ForgeCiRunV1;
    let projections = 0;
    // Every row asks this map for its workflow name while the panel renders, so its reads count re-projections.
    class CountingNames extends Map<string, string> {
      override get(key: string) { projections++; return super.get(key); }
    }
    const names = new CountingNames(Array.from({ length: 12 }, (_, index) => [`wf-${index}`, `Workflow ${index}`]));
    const ci: ForgeCiBindingV1 = {
      reads: null, adapter: null, account: null, actionRefs: {} as ForgeCiBindingV1['actionRefs'],
      about: { forgeName: 'GitHub', accountLabel: null, machineLabel: null },
    };
    const fixture = await mount(
      <ForgeCiRailPanel ci={ci} context={{ kind: 'ready', branch: 'main', headSha: 'a'.repeat(40) }}
        headRuns={[run(0, true), ...Array.from({ length: 11 }, (_, index) => run(index + 1, false))]}
        branchRuns={null} failure={null} checkedAtMs={null} onRetry={() => undefined} onOpenRun={() => undefined}
        workflowNames={names} />,
    );
    const durationShown = async () => {
      for (let second = 0; second < 60; second++) {
        const text = formatForgeCiDurationV1((60 + second) * 1000, 'en-GB');
        if (await fixture.queryByText(text)) return text;
      }
      return null;
    };
    let before: string | null = null;
    await vi.waitFor(async () => { before = await durationShown(); expect(before).not.toBeNull(); }, { timeout: 2_000, interval: 100 });
    const settled = projections;
    await vi.waitFor(async () => { expect(await durationShown()).not.toBe(before); }, { timeout: 3_000, interval: 250 });
    expect(projections).toBe(settled);
  });
});
