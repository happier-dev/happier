// @vitest-environment jsdom
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { useForgeCiQueryV1, useForgeCiQueryValueV1 } from '@happier-dev/forge-ci/ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue, PluginClientApi, PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiContextEnrichmentV1, PluginUiPageNavigationV1 } from '@happier-dev/plugin-sdk/ui';
import { ForgeCiMountedIntentInputV1Schema } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { buildForgeCiFailureSummaryV1, forgeCiSelectionKeyV1 } from '@happier-dev/forge-ci/runtime';
import { ForgeCiActionInputSchemasV1 } from '@happier-dev/triage-protocol/ci/v1';
import { formatTriageTimestampV1, TriageSessionHandoffInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../observations/githubProviderContracts.js';
import { useGithubCiBindingV1 } from '../../actions/useGithubCiBinding.js';
import { activate, GITHUB_CI_MOUNTED_ACTION_ID_V1 } from '../../../actions/mounted.js';
import { GITHUB_CI_ACTION_IDS_V1 } from '../../../actions/actionIds.js';
import { LOCAL_ACT_ACTION_IDS, LocalActRunFormInputV1Schema } from '../../../actions/local/contracts.js';
import { GithubActionsPage } from './ActionsPage.js';
import { GithubSessionCiPanel } from '../session/SessionCiPanel.js';
import { GithubChecksRunDrilldown } from '../../detail/checksRunDrilldown.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const native = createForgeCiConformanceVectorsV1().github;
const repository = native.run.ref.repository;
const page = { rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null };
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { await act(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); }); });

// The renderer scope and host Action transport are the system boundaries; page, hook, binder and schema stay real.
function scope(): PluginEphemeralSharedScope {
  const values = new Map<string, { value: unknown; dispose(): void }>();
  function acquire<T>(key: string, create: () => { value: T; dispose(): void }) {
    if (!values.has(key)) values.set(key, create());
    const entry = values.get(key)!;
    return { value: entry.value as T, release() {}, retire() {
      if (values.get(key) !== entry) return;
      values.delete(key); entry.dispose();
    } };
  }
  return { acquire, acquireExecutionBound: acquire };
}

describe('the mounted Actions page through public Action transport', () => {
  it('opens a selected failed-job log without replaying navigation or aborting its read', async () => {
    const text = readFileSync('src/ui/forge/actions/ActionsPage.failed-job.fixture.txt', 'utf8');
    const selection = native.job.ref.selection;
    if (selection.kind !== 'attempt') throw new Error('Fixture must pin one attempt');
    const subPath = `runs/${native.run.ref.runId}/attempts/${selection.attempt.attemptId}/jobs/${native.job.ref.jobId}`;
    const locations: string[] = [];
    const calls: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'job-log-selection', mountNonce: 'job-log-selection' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => <GithubActionsPage context={{ ...context, subPath }} />),
        surfaceContext: createSurfaceContextFixture({ mountId: 'job-log-selection',
          target: { kind: 'project', projectKey: 'project', repository } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope() }),
        handlers: {
          watchResource: async () => ({}),
          replacePageLocation: async ({ subPath: next }) => {
            locations.push(next);
            // Bound the defective host navigation loop in the test boundary;
            // a rejected navigation never produces the expected loaded log.
            return locations.length > 4 ? subPath : next;
          },
          executeAction: async ({ action }): Promise<JsonValue> => {
            const id = typeof action === 'string' ? action : action.localId;
            calls.push(id);
            const value: JsonValue = id === GITHUB_CI_ACTION_IDS_V1.readRun ? native.run
              : id === GITHUB_CI_ACTION_IDS_V1.readJob ? native.job
                : id === GITHUB_CI_ACTION_IDS_V1.readJobLog
                  ? { kind: 'available', job: native.job.ref, logId: 'failed-job-capture', text,
                    startLine: 1, startByte: 0, complete: true, continuation: null }
                  : { ...page, rows: id === GITHUB_CI_ACTION_IDS_V1.listJobs ? [native.job]
                    : id === GITHUB_CI_ACTION_IDS_V1.listRuns ? [native.run] : [] };
            return { kind: 'value', value };
          },
        },
      });
    });
    mounted.push(fixture);
    expect(locations).toEqual([]);
    expect(calls.filter(id => id === GITHUB_CI_ACTION_IDS_V1.readJobLog)).toHaveLength(1);
    expect(calls).not.toContain(GITHUB_CI_ACTION_IDS_V1.readJob);
    await fixture.getByRole('button', { name: 'Copy log' });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Find in this job’s log' })); });
    await fixture.getByRole('textbox', { label: 'Find in this job’s log' });
    // The captured real log passes through the real read/index/ANSI/view path.
    expect(text).toContain('Fake test failure for QA');
  });

  it('opens with 25 runs and reads the next 25 only when the reader reaches the end of the list', async () => {
    // The browser viewport is the system boundary: a fake IntersectionObserver reports what is on screen.
    const observers: { callback: IntersectionObserverCallback; nodes: Element[] }[] = [];
    const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      readonly entry: { callback: IntersectionObserverCallback; nodes: Element[] };
      constructor(callback: IntersectionObserverCallback) { this.entry = { callback, nodes: [] }; observers.push(this.entry); }
      observe(node: Element) { this.entry.nodes.push(node); }
      disconnect() { this.entry.nodes = []; }
      unobserve() {}
    };
    const reach = (isIntersecting: boolean) => { for (const observer of observers) for (const target of observer.nodes) {
      observer.callback([{ target, isIntersecting } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
    } };
    const runs = (offset: number) => Array.from({ length: 25 }, (_, index) => ({ ...native.run,
      ref: { ...native.run.ref, runId: String(5000 + offset + index) }, title: `Run ${offset + index}` }));
    const reads: Readonly<Record<string, unknown>>[] = [];
    try {
      let fixture!: PluginUiTestkit;
      await act(async () => {
        fixture = await createPluginUiTestkit({
          identity: { instanceId: 'ci-runs-paging', mountNonce: 'ci-runs-paging' },
          authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
          surface: defineUiSurface(context => <GithubActionsPage context={context} />),
          surfaceContext: createSurfaceContextFixture({ mountId: 'ci-runs-paging',
            target: { kind: 'project', projectKey: 'project', repository } }),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope() }),
          handlers: {
            watchResource: async () => ({}),
            executeAction: async ({ action, input }): Promise<JsonValue> => {
              const id = typeof action === 'string' ? action : action.localId;
              if (id !== GITHUB_CI_ACTION_IDS_V1.listRuns) return { kind: 'value', value: page };
              const operands = input as Readonly<Record<string, unknown>>;
              reads.push(operands);
              return { kind: 'value', value: operands.cursor === undefined
                ? { ...page, rows: runs(0), continuation: 'older-runs' } : { ...page, rows: runs(25) } } as JsonValue;
            },
          },
        });
      });
      mounted.push(fixture);
      await fixture.getByText('Run 0');
      expect({ requests: reads.length, pageSize: reads[0]?.pageSize, cursor: reads[0]?.cursor }).toEqual({ requests: 1, pageSize: 25, cursor: undefined });
      // Still above the end: no further read.
      await act(async () => { reach(false); });
      expect(reads).toHaveLength(1);
      await act(async () => { reach(true); });
      await fixture.getByText('Run 49');
      expect(reads.map(read => [read.pageSize, read.cursor])).toEqual([[25, undefined], [25, 'older-runs']]);
    } finally {
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
    }
  });

  it('waits for host execution admission and loads runs on the same mounted page when it becomes ready', async () => {
    const run = { ...native.run, title: 'Admitted workflow run' };
    let admitted = false;
    let watches = 0;
    const calls: string[] = [];
    const initial = createSurfaceContextFixture({
      mountId: 'ci-host-readiness',
      target: { kind: 'project', projectKey: 'project', repository },
      machineConnectionPending: true, machineExecutionReady: false,
    });
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'ci-host-readiness', mountNonce: 'ci-host-readiness' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => <GithubActionsPage context={context} />),
        surfaceContext: initial,
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope() }),
        handlers: {
          watchResource: async () => {
            watches++;
            if (!admitted) throw new Error('Host execution is not admitted');
            return {};
          },
          executeAction: async ({ action }) => {
            const id = typeof action === 'string' ? action : action.localId;
            calls.push(id);
            return { kind: 'value', value: { ...page, rows: id === GITHUB_CI_ACTION_IDS_V1.listRuns ? [run] : [] } };
          },
        },
      });
    });
    mounted.push(fixture);
    expect(watches).toBe(0);
    expect(calls).toEqual([]);
    admitted = true;
    const ready = { ...initial, machineConnectionPending: false, machineExecutionReady: true };
    await act(async () => { await fixture.updateSurface(ready); });
    await fixture.getByText(run.title);
    expect(watches).toBe(1);
    expect(calls.filter(id => id === GITHUB_CI_ACTION_IDS_V1.listRuns)).toHaveLength(1);
    await act(async () => {
      for (let n = 0; n < 100; n++) await fixture.updateSurface({ ...ready, textScale: n % 2 === 0 ? 1.1 : 1 });
    });
    expect(watches).toBe(1);
    expect(calls.filter(id => id === GITHUB_CI_ACTION_IDS_V1.listRuns)).toHaveLength(1);
  });

  it('keeps two Session purpose bindings isolated on the same Machine and repository', async () => {
    const shared = scope();
    const calls: string[] = [];
    function Probe() {
      const ci = useGithubCiBindingV1(repository);
      const query = useForgeCiQueryV1(ci.reads, 'readRun', { repository, runId: native.run.ref.runId });
      const value = useForgeCiQueryValueV1(query);
      return <Text value={value?.title ?? 'authority unavailable'} />;
    }
    async function mountSession(sessionId: string) {
      let fixture!: PluginUiTestkit;
      await act(async () => {
        fixture = await createPluginUiTestkit({
          identity: { instanceId: sessionId, mountNonce: sessionId },
          authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
          surface: defineUiSurface(() => <Probe />),
          surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId, repository } }),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: shared }),
          handlers: { watchResource: async () => ({}), executeAction: async () => {
            calls.push(sessionId);
            return { kind: 'value', value: { ...native.run, title: sessionId } };
          } },
        });
      });
      mounted.push(fixture);
      return fixture;
    }
    const first = await mountSession('purpose-a');
    await first.getByText('purpose-a');
    const second = await mountSession('purpose-b');
    expect(calls).toEqual(['purpose-a', 'purpose-b']);
    await second.getByText('purpose-b');
  });

  it('settles a refused read-authority watch without provider reads or automatic retries', async () => {
    let watches = 0;
    let reads = 0;
    let rerender: (() => void) | undefined;
    function Probe() {
      const [, setRevision] = React.useState(0);
      rerender = () => setRevision(value => value + 1);
      const ci = useGithubCiBindingV1(repository);
      const query = useForgeCiQueryV1(ci.reads, 'readRun', { repository, runId: native.run.ref.runId });
      const value = useForgeCiQueryValueV1(query);
      return <Text value={value ? 'incorrect disclosure' : 'authority unavailable'} />;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'ci-authority-refusal', mountNonce: 'ci-authority-refusal' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: {
          watchResource: async () => { watches++; throw new Error('Read authority is unavailable'); },
          executeAction: async () => { reads++; return { kind: 'value', value: native.run }; },
        },
      });
    });
    mounted.push(fixture);
    await fixture.getByText('authority unavailable');
    vi.useFakeTimers();
    try {
      await act(async () => { for (let n = 0; n < 100; n++) rerender?.(); await vi.advanceTimersByTimeAsync(300_000); });
      expect(watches).toBe(1);
      expect(reads).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('admits exact CI read authority before loading and retains the admitted result after withdrawal', async () => {
    const authority = { readAuthority: {
      consumer: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_CI_ACTION_IDS_V1.listRuns },
      purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, input: { repository, filters: {} },
    } };
    const requests: unknown[] = [];
    const watched: unknown[] = [];
    let admit: (() => void) | undefined;
    let generation = 1;
    function Probe() {
      const ci = useGithubCiBindingV1(repository);
      const query = useForgeCiQueryV1(ci.reads, 'readRun', { repository, runId: native.run.ref.runId });
      const value = useForgeCiQueryValueV1(query);
      return <Text value={value?.title ?? 'authority unavailable'} />;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'ci-authority', mountNonce: 'ci-authority' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: {
          watchResource: async ({ resource }) => {
            watched.push(resource);
            if (watched.length === 1) await new Promise<void>(resolve => { admit = resolve; });
            return {};
          },
          executeAction: async ({ input }) => {
            requests.push(input);
            return { kind: 'value', validator: `generation-${generation}`, value: { ...native.run, title: `authority ${generation}` } };
          },
        },
      });
    });
    mounted.push(fixture);
    expect(requests).toEqual([]);
    expect(watched).toEqual([authority]);
    await act(async () => { admit?.(); });
    await fixture.getByText('authority 1');
    expect(requests).toHaveLength(1);
    await act(async () => {
      for (let n = 0; n < 100; n++) fixture.retireReadAuthority({ readAuthority: { ...authority.readAuthority, purpose: 'another-purpose' } });
    });
    expect(requests).toHaveLength(1);
    expect(watched).toHaveLength(1);
    generation = 2;
    await act(async () => { fixture.retireReadAuthority(authority); });
    // TRIAGE-CHALLENGE step 4 / Triage natural-boundary ruling: withdrawal
    // closes the observation, not admitted work. A later Action admits itself;
    // withdrawal alone must not force a cold read or a new authority watch.
    await fixture.getByText('authority 1');
    expect(await fixture.queryByText('authority 2')).toBeUndefined();
    expect(watched).toEqual([authority]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('validator');
  });

  it.each(['pane', 'page'] as const)('opens the local form from the actual %s job panel when its run is outside the loaded list', async (presentation) => {
    const selection = native.job.ref.selection;
    const attempt = selection.kind === 'attempt' ? selection.attempt.attemptId : '1';
    const run = { ...native.run, workflow: { id: '42', path: '.github/workflows/detail.yml' }, headSha: 'a'.repeat(40) };
    const checkout = { id: 'checkout', serverId: 'home', machineId: 'primary', rootPath: '/repo', label: null, createdAtMs: 1, lastOpenedAtMs: null };
    const calls: string[] = [];
    const navigation: Array<PluginUiPageNavigationV1 | null> = [];
    const opened: unknown[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: `local-job-${presentation}`, mountNonce: `local-job-${presentation}` },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => <GithubActionsPage context={{ ...context, subPath: `runs/${run.ref.runId}/attempts/${attempt}/jobs/${native.job.ref.jobId}${presentation === 'page' ? '/page' : ''}` }} />),
        surfaceContext: createSurfaceContextFixture({ mountId: `local-job-${presentation}`, target: { kind: 'project', projectKey: 'project', repository, checkout } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope() }),
        handlers: { setPageNavigation: ({ navigation: value }) => { navigation.push(value); },
          watchResource: async () => ({}), executeAction: async ({ action, input }): Promise<JsonValue> => {
          const id = typeof action === 'string' ? action : action.localId;
          calls.push(id);
          if (id === LOCAL_ACT_ACTION_IDS.form) {
            opened.push(LocalActRunFormInputV1Schema.parse(input));
            return { kind: 'opened', mountId: 'local-form' };
          }
          if (id === GITHUB_CI_ACTION_IDS_V1.readRun) return { kind: 'value', value: run };
          if (id === GITHUB_CI_ACTION_IDS_V1.readJob) return { kind: 'value', value: native.job };
          if (id === GITHUB_CI_ACTION_IDS_V1.listJobs) return { kind: 'value', value: { ...page, rows: [native.job] } };
          if (id === GITHUB_CI_ACTION_IDS_V1.listRuns) return { kind: 'value', value: { ...page, rows: [{ ...native.run, ref: { ...native.run.ref, runId: '999' }, workflow: { id: '43', path: '.github/workflows/other.yml' }, headSha: 'b'.repeat(40) }] } };
          return { kind: 'unsupported', reason: 'Not requested by this fixture' };
        } },
      });
    });
    mounted.push(fixture);
    await fixture.getByText(native.job.name);
    if (presentation === 'page') expect(navigation.at(-1)).toMatchObject({
      pageKind: { pluginId: GITHUB_PLUGIN_ID, localId: 'actions/run' }, value: 'jobs',
    });
    else expect(navigation).toEqual([]);
    const reproduce = await fixture.getByRole('button', { name: 'Reproduce locally' });
    expect(opened).toEqual([]);
    const readsBeforeOpen = calls.filter(id => id !== LOCAL_ACT_ACTION_IDS.form);
    await act(async () => { await fixture.press(reproduce); });
    expect(opened).toEqual([{ operation: { kind: 'open', seed: {
      target: { kind: 'project', projectId: 'project' },
      workspace: { serverId: 'home', workspaceId: 'checkout', machineId: 'primary', rootPath: '/repo' },
      workflowPath: '.github/workflows/detail.yml', sourceHeadSha: 'a'.repeat(40),
    } } }]);
    expect(calls.filter(id => id === LOCAL_ACT_ACTION_IDS.form)).toHaveLength(1);
    expect(calls.filter(id => id !== LOCAL_ACT_ACTION_IDS.form)).toEqual(readsBeforeOpen);
    expect(calls).not.toContain(LOCAL_ACT_ACTION_IDS.run);
    expect(calls).not.toContain('projects.compute.exec');
  });

  it('hands the selected failed run through the offered configured Fix without acquiring evidence on mount', async () => {
    const selection = native.job.ref.selection;
    const attempt = selection.kind === 'attempt' ? selection.attempt.attemptId : '1';
    const calls: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'run-fix', mountNonce: 'run-fix' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => <GithubActionsPage context={{ ...context, subPath: `runs/${native.run.ref.runId}/attempts/${attempt}/page` }} />),
        surfaceContext: createSurfaceContextFixture({ mountId: 'run-fix', target: { kind: 'project', projectKey: 'project', repository } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope() }),
        handlers: { watchResource: async () => ({}), executeAction: async ({ action, input }): Promise<JsonValue> => {
          const id = typeof action === 'string' ? action : action.localId;
          calls.push(id);
          if (id === 'actions/read-v1') return { v: 1, kind: 'choices', defaultActionId: 'repair-ci', actions: [{ label: 'Repair CI', selection: { configuredActionId: 'repair-ci', sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'compose' } }] };
          if (id === GITHUB_CI_ACTION_IDS_V1.readFailureContext) {
            const request = ForgeCiActionInputSchemasV1.readFailureContext.parse(input);
            expect(forgeCiSelectionKeyV1(request.selection)).toBe(forgeCiSelectionKeyV1(selection));
            return buildForgeCiFailureSummaryV1({ run: native.run, selection, jobs: [native.job], logs: [], excerpt: request.excerpt, maxSerializedBytes: request.maxSerializedBytes });
          }
          if (id === 'sessions/run-configured-v1') {
            const handoff = TriageSessionHandoffInputV1Schema.parse((input as { handoff: unknown }).handoff);
            expect(handoff).toMatchObject({ task: 'fix', configuredActionId: 'repair-ci', delivery: 'compose', evidence: [{ kind: 'hostedCi', summary: { selection } }] });
            return { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } };
          }
          if (id === GITHUB_CI_ACTION_IDS_V1.readRun) return { kind: 'value', value: native.run };
          return { kind: 'value', value: { ...page, rows: id === GITHUB_CI_ACTION_IDS_V1.listRuns ? [native.run] : id === GITHUB_CI_ACTION_IDS_V1.listJobs ? [native.job] : [] } };
        } },
      });
    });
    mounted.push(fixture);
    await fixture.getByRole('button', { name: 'Re-run failed jobs' });
    const fix = await fixture.getByRole('button', { name: 'Fix in a session' });
    expect(calls).not.toContain(GITHUB_CI_ACTION_IDS_V1.readFailureContext);
    expect(calls).not.toContain('actions/read-v1');
    await act(async () => { await fixture.press(fix); });
    expect(calls.filter(id => id === 'actions/read-v1' || id === GITHUB_CI_ACTION_IDS_V1.readFailureContext || id === 'sessions/run-configured-v1')).toEqual(['actions/read-v1', GITHUB_CI_ACTION_IDS_V1.readFailureContext, 'sessions/run-configured-v1']);
  });

  it('reads back the workflow itself after enable/disable and updates the selected workflow state', async () => {
    let enabled = true;
    const calls: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'workflow-state', mountNonce: 'workflow-state' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => <GithubActionsPage context={{ ...context, subPath: 'workflows/42' }} />),
        surfaceContext: createSurfaceContextFixture({ mountId: 'workflow-state', target: { kind: 'project', projectKey: 'project', repository } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope() }),
        handlers: { watchResource: async () => ({}), executeAction: async ({ action }): Promise<JsonValue> => {
          const id = typeof action === 'string' ? action : action.localId;
          calls.push(id);
          if (id === GITHUB_CI_ACTION_IDS_V1.disableWorkflow || id === GITHUB_CI_ACTION_IDS_V1.enableWorkflow) {
            enabled = id === GITHUB_CI_ACTION_IDS_V1.enableWorkflow;
            return { kind: 'confirmed', affected: { repository }, receipt: { id: '42' } };
          }
          return { kind: 'value', value: { ...page, rows: id === GITHUB_CI_ACTION_IDS_V1.listWorkflows ? [{ id: '42', name: 'CI', nativeState: enabled ? 'active' : 'disabled_manually' }] : [] } };
        } },
      });
    });
    mounted.push(fixture);
    const toggle = await fixture.getByRole('switch', { name: 'Status' });
    expect(toggle.state?.checked).toBe(true);
    await act(async () => { await fixture.press(toggle); });
    expect((await fixture.getByRole('switch', { name: 'Status' })).state?.checked).toBe(false);
    await act(async () => { await fixture.press(await fixture.getByRole('switch', { name: 'Status' })); });
    expect((await fixture.getByRole('switch', { name: 'Status' })).state?.checked).toBe(true);
    expect(calls.filter(id => id === GITHUB_CI_ACTION_IDS_V1.listWorkflows)).toHaveLength(3);
    expect(calls.filter(id => id === GITHUB_CI_ACTION_IDS_V1.listRuns)).toHaveLength(2);
  });

  it('does not invent deployment review from a generic waiting run or crawl its pending environments', async () => {
    const calls: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'waiting-run', mountNonce: 'waiting-run' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => <GithubActionsPage context={context} />),
        surfaceContext: createSurfaceContextFixture({ mountId: 'waiting-run', target: { kind: 'project', projectKey: 'project', repository } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope() }),
        handlers: { watchResource: async () => ({}), executeAction: async ({ action }) => {
          const id = typeof action === 'string' ? action : action.localId;
          calls.push(id);
          return { kind: 'value', value: { ...page, rows: id === GITHUB_CI_ACTION_IDS_V1.listRuns ? [{ ...native.run, title: 'Runner unavailable', state: { phase: 'waiting', outcome: null, outcomeBucket: 'pending', nativeLabel: 'waiting' } }] : [] } };
        } },
      });
    });
    mounted.push(fixture);
    await fixture.getByText('Runner unavailable');
    expect(await fixture.queryByRole('button', { name: 'Review' })).toBeUndefined();
    // The presented waiting run asks its own pending environments once (F14); nothing else is crawled.
    expect(calls.filter(id => id === GITHUB_CI_ACTION_IDS_V1.listDeployments)).toHaveLength(1);
    expect(calls.every(id => id === GITHUB_CI_ACTION_IDS_V1.listRuns || id === GITHUB_CI_ACTION_IDS_V1.listWorkflows
      || id === GITHUB_CI_ACTION_IDS_V1.listDeployments)).toBe(true);
  });

  it('raises the pending-environment banner only for an environment GitHub says the person may answer', async () => {
    const waiting = { ...native.run, title: 'Deploy docs', number: 1207, headRef: 'main', state: { phase: 'waiting', outcome: null, outcomeBucket: 'pending', nativeLabel: 'waiting' } } as const;
    const approval = (id: string, name: string, eligible: boolean) => ({ id, selection: { kind: 'run', run: waiting.ref }, environment: { id, name }, eligible });
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'eligible-run', mountNonce: 'eligible-run' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => <GithubActionsPage context={context} />),
        surfaceContext: createSurfaceContextFixture({ mountId: 'eligible-run', target: { kind: 'project', projectKey: 'project', repository } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope() }),
        handlers: { watchResource: async () => ({}), executeAction: async ({ action }) => {
          const id = typeof action === 'string' ? action : action.localId;
          const rows = id === GITHUB_CI_ACTION_IDS_V1.listRuns ? [waiting]
            : id === GITHUB_CI_ACTION_IDS_V1.listDeployments ? [approval('42', 'docs-production', true), approval('43', 'restricted', false)] : [];
          return { kind: 'value', value: { ...page, rows } };
        } },
      });
    });
    mounted.push(fixture);
    await fixture.getByText('A deployment is waiting for you');
    await fixture.getByText('Deploy docs #1207 on main wants to deploy to docs-production');
    await fixture.getByRole('button', { name: 'Review' });
  });

  it('names each run by its workflow from the repository workflow list (lab a2 "CI #4821 · branch")', async () => {
    const run = { ...native.run, title: 'fix(ui): key settings modal by route', number: 4821, headRef: 'fix-settings-modal', workflow: { id: '42' } } as const;
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'workflow-names', mountNonce: 'workflow-names' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => <GithubActionsPage context={context} />),
        surfaceContext: createSurfaceContextFixture({ mountId: 'workflow-names', target: { kind: 'project', projectKey: 'project', repository } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope() }),
        handlers: { watchResource: async () => ({}), executeAction: async ({ action }) => {
          const id = typeof action === 'string' ? action : action.localId;
          // The workflow list answers after the runs, as it does live: rows already drawn learn their workflow's name.
          if (id === GITHUB_CI_ACTION_IDS_V1.listWorkflows) await new Promise(resolve => setTimeout(resolve, 50));
          const rows = id === GITHUB_CI_ACTION_IDS_V1.listRuns ? [run]
            : id === GITHUB_CI_ACTION_IDS_V1.listWorkflows ? [{ id: '42', name: 'CI', nativeState: 'active' }] : [];
          return { kind: 'value', value: { ...page, rows } };
        } },
      });
    });
    mounted.push(fixture);
    await fixture.getByText('fix(ui): key settings modal by route');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    await fixture.getByText('CI #4821 · fix-settings-modal');
  });

  it('says how each workflow last went rather than repeating its last run title (lab a3)', async () => {
    const failed = { ...native.run, title: 'fix(ui): key settings modal by route', number: 4821, headRef: 'main', workflow: { id: '42' },
      state: { phase: 'completed', outcome: 'failure', outcomeBucket: 'failed', nativeLabel: 'failure' } } as const;
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'workflow-byline', mountNonce: 'workflow-byline' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => <GithubActionsPage context={{ ...context, subPath: 'workflows' }} />),
        surfaceContext: createSurfaceContextFixture({ mountId: 'workflow-byline', target: { kind: 'project', projectKey: 'project', repository } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope() }),
        handlers: { watchResource: async () => ({}), executeAction: async ({ action }) => {
          const id = typeof action === 'string' ? action : action.localId;
          const rows = id === GITHUB_CI_ACTION_IDS_V1.listRuns ? [failed]
            : id === GITHUB_CI_ACTION_IDS_V1.listWorkflows ? [{ id: '42', name: 'CI', nativeState: 'active' }] : [];
          return { kind: 'value', value: { ...page, rows } };
        } },
      });
    });
    mounted.push(fixture);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    const at = failed.completedAtMs ?? failed.createdAtMs;
    await fixture.getByText(at === undefined ? 'Failed' : `Failed · ${formatTriageTimestampV1(createSurfaceContextFixture().locale, at, 'relative', Date.now())}`);
    expect(await fixture.queryByText('fix(ui): key settings modal by route')).toBeUndefined();
  });

  it('drives the visible lens and exact query for one host mount and refuses a retired retained tree', async () => {
    const shared = scope();
    const registrations = new Map<string, PluginClientActionHandler>();
    // Client registration is the host boundary; the artifact's actual activation installs its real handler.
    const unusedRegistration = () => { throw new Error('Unexpected client registration family'); };
    const client: PluginClientApi = {
      // Host registration erases per-Action generics; the real handler parses its own input.
      actions: { register: (id, handler) => { registrations.set(id, handler as unknown as PluginClientActionHandler); } },
      workItems: { register: unusedRegistration }, dragSources: { register: unusedRegistration },
      dropTargets: { register: unusedRegistration }, voiceProviders: { register: unusedRegistration },
    };
    activate(client);
    const handler = registrations.get(GITHUB_CI_MOUNTED_ACTION_ID_V1)!;
    const calls: { id: string; input: unknown }[] = [];
    async function mount(mountId: string, entry: 'actions' | 'session' | 'checks' = 'actions') {
      const renderer = new AbortController();
      let published: PluginUiContextEnrichmentV1 | null = null;
      let settledOverride: string | null = null;
      let heldRun: { started(): void; released: Promise<void> } | null = null;
      const locations: string[] = [];
      let fixture!: PluginUiTestkit;
      await act(async () => {
        fixture = await createPluginUiTestkit({
          identity: { instanceId: mountId, mountNonce: mountId },
          authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
          surface: defineUiSurface(context => entry === 'actions' ? <GithubActionsPage context={{ ...context, signal: renderer.signal }} />
            : entry === 'session' ? <GithubSessionCiPanel context={{ ...context, signal: renderer.signal }} />
              : <GithubChecksRunDrilldown target={{ selection: native.job.ref.selection, checkRunId: 'check', headSha: 'b'.repeat(40) }} checksLabel="Checks" onBack={() => {}} signal={renderer.signal} />),
          surfaceContext: createSurfaceContextFixture({ mountId,
            mount: { kind: 'destination', destination: { pluginId: GITHUB_PLUGIN_ID, localId: entry === 'session' ? 'session-ci' : 'actions' },
              container: entry === 'actions' ? 'appPage' : entry === 'session' ? 'rightSidebarTab' : 'detailsTab' },
            target: entry === 'session'
            ? { kind: 'session', sessionId: 'session', repository, branch: 'main', headOid: 'b'.repeat(40) }
            : { kind: 'project', projectKey: 'project', repository } }),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: shared }),
          handlers: {
            watchResource: async () => ({}),
            publishCurrentUiContext: async ({ enrichment }) => { published = enrichment; },
            replacePageLocation: async ({ subPath }) => { locations.push(subPath); return settledOverride ?? subPath; },
            executeAction: async ({ action, input, signal }): Promise<JsonValue> => {
              const localId = typeof action === 'string' ? action : action.localId;
              if (localId === GITHUB_CI_MOUNTED_ACTION_ID_V1) {
                const result = await handler(ForgeCiMountedIntentInputV1Schema.parse(input), {
                  plugin: fixture.context.plugin,
                  contribution: { id: localId, qualifiedId: `${GITHUB_PLUGIN_ID}/${localId}` },
                  invocationSurface: 'agent', signal,
                  ui: { ...fixture.context.hostApi, context: async options => ({
                    targetedContributions: (await fixture.context.hostApi.context(options)).targetedContributions ?? null,
                  }) },
                  ephemeralSharedScope: shared,
                });
                if (result === undefined) throw new Error('Mounted CI Action returned no result');
                return result;
              }
              calls.push({ id: localId, input });
              if (localId === GITHUB_CI_ACTION_IDS_V1.readRun) {
                const holding = heldRun;
                heldRun = null;
                if (holding) { holding.started(); await holding.released; }
                const runId = typeof input === 'object' && input !== null && 'runId' in input ? String(input.runId) : native.run.ref.runId;
                const run = { ...native.run.ref, runId };
                return { kind: 'value', value: { ...native.run, ref: run, currentAttempt: { run, attemptId: '2', number: 2 }, attemptCount: 2, title: `Observed run ${runId}` } };
              }
              return { kind: 'value', value: page };
            },
          },
        });
      });
      mounted.push(fixture);
      return { fixture, renderer, locations, currentContext: () => published, settleAt: (value: string | null) => { settledOverride = value; },
        holdNextRun() {
          let started!: () => void;
          let release!: () => void;
          const ready = new Promise<void>(resolve => { started = resolve; });
          const released = new Promise<void>(resolve => { release = resolve; });
          heldRun = { started, released };
          return { started: ready, release };
        } };
    }
    const first = await mount('host-ci-one');
    const second = await mount('host-ci-two');
    const control = (fixture: PluginUiTestkit, mountId: string, operation: unknown) => fixture.context.hostApi.executeAction(
      { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_CI_MOUNTED_ACTION_ID_V1 },
      ForgeCiMountedIntentInputV1Schema.parse({ mountId, operation }),
    );
    let result: unknown;
    await act(async () => { result = await control(first.fixture, 'host-ci-one', { kind: 'selectView', view: 'workflows' }); });
    expect(result).toEqual({ status: 'applied' });
    expect((await first.fixture.getByRole('radio', { name: 'Workflows' })).state?.checked).toBe(true);
    expect((await second.fixture.getByRole('radio', { name: 'Runs' })).state?.checked).toBe(true);
    const beforeEqualLens = calls.length;
    await act(async () => { for (let i = 0; i < 30; i++) await control(first.fixture, 'host-ci-one', { kind: 'selectView', view: 'workflows' }); });
    expect(calls).toHaveLength(beforeEqualLens);
    const command = first.currentContext()?.commands?.find(entry => entry.title === 'Runs');
    if (!command || command.command.kind !== 'executeAction') throw new Error('Missing parameterless current-context command');
    const semanticCommand = command.command;
    await act(async () => { await first.fixture.context.hostApi.executeAction(semanticCommand.action, semanticCommand.input); });
    expect((await first.fixture.getByRole('radio', { name: 'Runs' })).state?.checked).toBe(true);
    first.settleAt('runs');
    await act(async () => { expect(await control(first.fixture, 'host-ci-one', { kind: 'selectView', view: 'workflows' })).toEqual({ status: 'unavailable' }); });
    expect((await first.fixture.getByRole('radio', { name: 'Runs' })).state?.checked).toBe(true);
    first.settleAt(null);
    await act(async () => { await control(first.fixture, 'host-ci-one', { kind: 'setFilters', filters: { branch: 'release/current', excludePullRequests: false } }); });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.listRuns).at(-1)?.input).toMatchObject({ filters: { branch: 'release/current', excludePullRequests: false } });
    const beforeEqualFilters = calls.length;
    await act(async () => { for (let i = 0; i < 30; i++) await control(first.fixture, 'host-ci-one', { kind: 'setFilters', filters: { branch: 'release/current', excludePullRequests: false } }); });
    expect(calls).toHaveLength(beforeEqualFilters);
    const beforeRetirement = calls.length;
    await act(async () => { first.renderer.abort(); });
    expect(await control(first.fixture, 'host-ci-one', { kind: 'selectView', view: 'runs' })).toEqual({ status: 'unavailable' });
    expect(calls).toHaveLength(beforeRetirement);
    expect(first.currentContext()).toBeNull();
    expect(calls.every(call => call.id === GITHUB_CI_ACTION_IDS_V1.listRuns || call.id === GITHUB_CI_ACTION_IDS_V1.listWorkflows)).toBe(true);
    const arbitraryRun = { ...native.run.ref, runId: '98765' };
    await act(async () => { expect(await control(second.fixture, 'host-ci-two', { kind: 'selectRun', run: arbitraryRun })).toEqual({ status: 'applied' }); });
    expect(second.locations.at(-1)).toBe('runs/98765/attempts/2');
    await second.fixture.getByText('Observed run 98765');
    const retiring = await mount('host-ci-retiring');
    const held = retiring.holdNextRun();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = control(retiring.fixture, 'host-ci-retiring', { kind: 'selectRun', run: { ...arbitraryRun, runId: '98766' } });
      await held.started;
    });
    await act(async () => { retiring.renderer.abort(); held.release(); expect(await pending).toEqual({ status: 'unavailable' }); });
    expect(retiring.locations).toEqual([]);
    expect((await retiring.fixture.getByRole('radio', { name: 'Runs' })).state?.checked).toBe(true);
    for (const entry of ['session', 'checks'] as const) {
      const surface = await mount(`host-ci-${entry}`, entry);
      const selection = { kind: 'attempt', attempt: { run: { ...native.run.ref, runId: '98765' }, attemptId: '2' } } as const;
      await act(async () => { expect(await control(surface.fixture, `host-ci-${entry}`, { kind: 'selectAttempt', selection })).toEqual({ status: 'applied' }); });
      await surface.fixture.getByText('Observed run 98765');
      await act(async () => { surface.renderer.abort(); });
      expect(await control(surface.fixture, `host-ci-${entry}`, { kind: 'selectAttempt', selection })).toEqual({ status: 'unavailable' });
    }
  });
});
