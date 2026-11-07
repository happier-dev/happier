// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit, type PluginUiTestkitHostHandlers } from '@happier-dev/plugin-sdk/testing';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import { ForgeCiActionInputSchemasV1, type ForgeCiLogV1, type ForgeCiOperationIdV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { createForgeCiAdapterV1 } from '../runtime/adapter.js';
import { createForgeCiReadsV1 } from '../runtime/reads.js';
import type { ForgeCiLogIndexV1 } from '../runtime/logs/index.js';
import type { ForgeCiActionInputByOperationV1 } from '@happier-dev/triage-protocol/ci/v1';
import { ForgeCiJobView } from './ForgeCiJobView.js';
import { ForgeCiRunDetail } from './ForgeCiRunDetail.js';
import { useForgeCiMountedViewV1, useForgeCiMountedViewStateV1 } from './useForgeCiMountedView.js';
import { useForgeCiReadsV1, useForgeCiQueryV1, useForgeCiQueryValueV1 } from './useForgeCiReads.js';
import { createForgeCiMountedViewV1 } from './mountedCiIntent.js';
import { useForgeCiLogViewerV1 } from './useForgeCiLogViewer.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { await act(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); }); });

function boundary(logResponse?: (input: ForgeCiActionInputByOperationV1['readJobLog'], log: Extract<ForgeCiLogV1, { kind: 'available' }>) => Promise<unknown> | unknown) {
  const native = createForgeCiConformanceVectorsV1().github;
  const vectors = { ...native, job: { ...native.job, checkRunId: 'check-202' } };
  const calls: string[] = [];
  const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key, { pluginId: 'fixture.forge', localId: key }])) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
  const adapter = createForgeCiAdapterV1({ actionRefs, activeRunPollIntervalMs: 3000, invoke: async (action, input) => {
    calls.push(action.localId);
    const log = { kind: 'available', job: vectors.job.ref, logId: 'immutable', text: 'failure\ncontext', startLine: 1, startByte: 0, complete: true, continuation: null } as const;
    if (action.localId === 'readJobLog' && logResponse) return logResponse(ForgeCiActionInputSchemasV1.readJobLog.parse(input), log);
    const value = action.localId === 'readRun' ? vectors.run
      : action.localId === 'readJob' ? vectors.job
      : action.localId === 'readJobLog' ? log
        : { rows: action.localId === 'listJobs' ? [vectors.job] : [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null };
    return { kind: 'value', value };
  } });
  return { vectors, calls, adapter, reads: createForgeCiReadsV1({ adapter, scopeKey: 'account/credential/origin' }) };
}

async function mount(Body: () => React.ReactElement, adapterOptions: Parameters<typeof createPluginUiRnwSemanticSurfaceAdapter>[0] = {}, handlers?: PluginUiTestkitHostHandlers) {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'ci-data', mountNonce: 'ci-data-mount' }, authorPlugin: { id: 'fixture.forge', version: '0.0.0' },
      surface: defineUiSurface(() => <Body />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(adapterOptions), launchInput: null,
      ...(handlers === undefined ? {} : { handlers }),
    });
  });
  mounted.push(fixture);
  return fixture;
}

describe('public mounted CI data wiring', () => {
  it.each([false, true])('finishes an admitted mounted read across revoke without requiring shared retirement (%s)', async supportsRetire => {
    const native = createForgeCiConformanceVectorsV1().github;
    const authority = { readAuthority: { consumer: { pluginId: 'fixture.forge', localId: 'read-run' },
      purpose: 'forge-account', input: { repository: native.run.ref.repository, runId: native.run.ref.runId } } };
    let settle!: (value: unknown) => void;
    let requestSignal: AbortSignal | undefined;
    let authoritySignal: AbortSignal | undefined;
    let requests = 0;
    let retirements = 0;
    let releases = 0;
    let watches = 0;
    let acquisitions = 0;
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key,
      key === 'readRun' ? authority.readAuthority.consumer : { pluginId: 'fixture.forge', localId: key }])) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
    const adapter = createForgeCiAdapterV1({ actionRefs, activeRunPollIntervalMs: 3000, invoke: async (_action, _input, options) => {
      requests++;
      requestSignal = options?.signal;
      return new Promise(resolve => { settle = resolve; });
    } });
    const input = { repository: native.run.ref.repository, runId: native.run.ref.runId };
    const fixture = await mount(() => {
      const reads = useForgeCiReadsV1({ adapter, scopeKey: 'retained-authority', readAuthority: authority });
      const query = useForgeCiQueryV1(reads, 'readRun', input);
      const value = useForgeCiQueryValueV1(query);
      return <Text value={value?.ref.runId ?? 'pending'} />;
    }, { ephemeralSharedScope: {
      acquire() { return null; },
      acquireExecutionBound(_key, create) {
        acquisitions++;
        const created = create();
        return { value: created.value, release() { releases++; void created.dispose?.(); },
          ...(supportsRetire ? { retire() { retirements++; void created.dispose?.(); } } : {}) };
      },
    } }, { watchResource: ({ signal }) => { watches++; authoritySignal = signal; return {}; } });
    expect(watches).toBe(1);
    expect(acquisitions).toBe(1);
    expect(requests).toBe(1);
    const admittedSignal = requestSignal;
    const admittedAuthoritySignal = authoritySignal;
    const settleAdmitted = settle;
    await act(async () => { fixture.retireReadAuthority(authority); });
    expect(admittedAuthoritySignal?.aborted).toBe(true);
    expect(admittedSignal?.aborted).toBe(false);
    await act(async () => { settleAdmitted({ kind: 'value', value: native.run }); });
    await fixture.getByText(native.run.ref.runId);
    expect(retirements).toBe(0);
    expect(releases).toBe(0);
    expect(watches).toBe(1);
    expect(acquisitions).toBe(1);
    await act(async () => { await fixture.dispose(); });
    mounted.splice(mounted.indexOf(fixture), 1);
    expect(releases).toBe(1);
  });

  it('keeps a valid continuation incomplete and demands the next exact jobs page only on load more', async () => {
    const native = createForgeCiConformanceVectorsV1().github;
    const inputs: ForgeCiActionInputByOperationV1['listJobs'][] = [];
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key, { pluginId: 'fixture.forge', localId: key }])) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
    const adapter = createForgeCiAdapterV1({ actionRefs, activeRunPollIntervalMs: 3000, invoke: async (action, input) => {
      if (action.localId === 'readRun') return { kind: 'value', value: native.run };
      const query = ForgeCiActionInputSchemasV1.listJobs.parse(input);
      inputs.push(query);
      return { kind: 'value', value: { rows: [{ ...native.job, ref: { ...native.job.ref, jobId: query.cursor ? 'later-job' : native.job.ref.jobId } }], omittedRowCount: 0, projectionTruncated: false, continuation: query.cursor ? null : 'next-exact-page', incomplete: null } };
    } });
    const reads = createForgeCiReadsV1({ adapter, scopeKey: 'paging-account' });
    let query: unknown;
    try {
      const fixture = await mount(() => <ForgeCiRunDetail reads={reads} selection={native.job.ref.selection}>{model => {
        query = model.jobsQuery;
        return <Text value={`${model.jobs?.rows.map(row => row.ref.jobId).join(',')}:${model.jobs?.continuation ?? 'end'}`} />;
      }}</ForgeCiRunDetail>);
      await fixture.getByText(`${native.job.ref.jobId}:next-exact-page`);
      expect(inputs).toHaveLength(1);
      expect(query).toHaveProperty('loadMore', expect.any(Function));
      const paging = query as { loadMore(): Promise<void> };
      await act(async () => { await paging.loadMore(); });
      await fixture.getByText(`${native.job.ref.jobId},later-job:end`);
      expect(inputs).toEqual([
        { repository: native.run.ref.repository, runId: native.run.ref.runId, attempt: native.job.ref.selection.kind === 'attempt' ? native.job.ref.selection.attempt.attemptId : undefined },
        { repository: native.run.ref.repository, runId: native.run.ref.runId, attempt: native.job.ref.selection.kind === 'attempt' ? native.job.ref.selection.attempt.attemptId : undefined, cursor: 'next-exact-page' },
      ]);
      await act(async () => { await paging.loadMore(); });
      expect(inputs).toHaveLength(2);
    } finally { await act(async () => { reads.retire(); }); }
  });

  it('demands annotations and original log ranges one page at a time through the selected job', async () => {
    const native = createForgeCiConformanceVectorsV1().github;
    const job = { ...native.job, checkRunId: 'check-202' };
    const calls: Array<Readonly<{ operation: string; cursor?: string }>> = [];
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key, { pluginId: 'fixture.forge', localId: key }])) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
    const adapter = createForgeCiAdapterV1({ actionRefs, activeRunPollIntervalMs: 3000, invoke: async (action, input) => {
      if (action.localId === 'readJobLog') {
        const query = ForgeCiActionInputSchemasV1.readJobLog.parse(input);
        calls.push({ operation: action.localId, ...(query.cursor ? { cursor: query.cursor } : {}) });
        return { kind: 'value', value: { kind: 'available', job: job.ref, logId: 'paged-log', text: query.cursor ? 'last\n' : 'first\n', startLine: query.cursor ? 2 : 1, startByte: query.cursor ? 6 : 0, complete: Boolean(query.cursor), continuation: query.cursor ? null : 'log-next' } };
      }
      const query = ForgeCiActionInputSchemasV1.listAnnotations.parse(input);
      calls.push({ operation: action.localId, ...(query.cursor ? { cursor: query.cursor } : {}) });
      return { kind: 'value', value: { rows: [{ id: query.cursor ? 'annotation-2' : 'annotation-1', job: job.ref, checkRunId: job.checkRunId, level: 'error', message: 'failure' }], omittedRowCount: 0, projectionTruncated: false, continuation: query.cursor ? null : 'annotations-next', incomplete: null } };
    } });
    const reads = createForgeCiReadsV1({ adapter, scopeKey: 'evidence-account' });
    let queries: { log: unknown; annotations: unknown } | null = null;
    try {
      const fixture = await mount(() => <ForgeCiJobView reads={reads} job={job.ref} admittedJob={job} logExpanded annotationsExpanded>{model => {
        queries = { log: model.logQuery, annotations: model.annotationsQuery };
        return <Text value={`${model.annotations?.rows.length ?? 0}:${model.logIndex?.plainText ?? 'loading'}`} />;
      }}</ForgeCiJobView>);
      await fixture.getByText('1:first');
      expect(calls).toHaveLength(2);
      expect(queries?.log).toHaveProperty('loadMore', expect.any(Function));
      expect(queries?.annotations).toHaveProperty('loadMore', expect.any(Function));
      const paging = queries as unknown as { log: { loadMore(): Promise<void> }; annotations: { loadMore(): Promise<void> } };
      await act(async () => { await paging.log.loadMore(); await paging.annotations.loadMore(); });
      await fixture.getByText('2:first last');
      expect(calls).toEqual([
        { operation: 'readJobLog' }, { operation: 'listAnnotations' },
        { operation: 'readJobLog', cursor: 'log-next' }, { operation: 'listAnnotations', cursor: 'annotations-next' },
      ]);
    } finally { await act(async () => { reads.retire(); }); }
  });

  it('honors a retired host scope with zero provider reads and no local fallback', async () => {
    const { adapter, calls, reads } = boundary();
    let acquisitions = 0;
    try {
      const fixture = await mount(() => {
        const held = useForgeCiReadsV1({ adapter, scopeKey: 'retired-account' });
        return <Text value={held === null ? 'unavailable' : 'incorrect fallback'} />;
      }, { ephemeralSharedScope: { acquire() { acquisitions++; return null; }, acquireExecutionBound() { acquisitions++; return null; } } });
      await fixture.getByText('unavailable');
      expect(acquisitions).toBeGreaterThan(0);
      expect(calls).toHaveLength(0);
    } finally { await act(async () => { reads.retire(); }); }
  });

  it('keeps job/header/log on the run jobs projection and admits no closed annotation or workflow-file reads', async () => {
    const { vectors, calls, reads } = boundary();
    try {
      const fixture = await mount(() => <ForgeCiRunDetail reads={reads} selection={vectors.job.ref.selection}>{model =>
        model.jobs?.rows[0] ? <ForgeCiJobView reads={reads} job={vectors.job.ref} admittedJob={model.jobs.rows[0]}>{job =>
          <Text value={`${job.job?.name}:${job.annotationsCount === null ? 'unknown' : job.annotationsCount}`} />
        }</ForgeCiJobView> : <Text value="loading" />
      }</ForgeCiRunDetail>);
      await fixture.getByText(`${vectors.job.name}:unknown`);
      expect(calls.filter(value => value === 'readJob')).toHaveLength(0);
      expect(calls.filter(value => value === 'listAnnotations')).toHaveLength(0);
      expect(calls.filter(value => value === 'readJobLog')).toHaveLength(0);
      expect(calls.filter(value => value === 'readTrigger' || value === 'readWorkflow')).toHaveLength(0);
      expect(calls.sort()).toEqual(['listJobs', 'readRun']);
    } finally { await act(async () => { reads.retire(); }); }
  });

  it('keeps explicit timestamps across phone resize for one mount and refuses commands after disposal', async () => {
    const renderer = new AbortController();
    let view: ReturnType<typeof useForgeCiMountedViewV1> = null;
    let setPhone: React.Dispatch<React.SetStateAction<boolean>> = () => {};
    const fixture = await mount(() => {
      const [phone, changePhone] = React.useState(false);
      setPhone = changePhone;
      view = useForgeCiMountedViewV1({ mountId: 'mounted-ci', phone, signal: renderer.signal });
      const state = useForgeCiMountedViewStateV1(view);
      return <Text value={String(state?.timestampsVisible)} />;
    });
    const held = view;
    if (!held) throw new Error('CI mount did not commit');
    await act(async () => { await held.invoke({ mountId: 'mounted-ci', operation: { kind: 'setTimestampsVisible', visible: false } }); });
    await act(async () => { setPhone(true); });
    expect(view).toBe(held);
    expect(held.getSnapshot()?.timestampsVisible).toBe(false);
    await act(async () => { renderer.abort(); });
    expect(held.getSnapshot()).toBeNull();
    expect(await held.invoke({ mountId: 'mounted-ci', operation: { kind: 'setTimestampsVisible', visible: true } })).toEqual({ status: 'unavailable' });
    await act(async () => { await fixture.dispose(); });
    mounted.splice(mounted.indexOf(fixture), 1);
    expect(await held.invoke({ mountId: 'mounted-ci', operation: { kind: 'setTimestampsVisible', visible: true } })).toEqual({ status: 'unavailable' });
  });

  it('borrows the retained immutable index and body when the same job moves between mounts', async () => {
    let replacement = false;
    let finishTail: (() => void) | undefined;
    const logSelections: ForgeCiActionInputByOperationV1['readJobLog']['selection'][] = [];
    const { vectors, calls, reads } = boundary((query, log) => {
      logSelections.push(query.selection);
      if (!replacement) return { kind: 'value', value: log };
      if (query.selection.kind === 'tail') return new Promise(resolve => {
        finishTail = () => resolve({ kind: 'value', value: { ...log, text: 'new context', startLine: 2, startByte: 8, complete: false } });
      });
      return { kind: 'value', value: { ...log, text: 'failure\n', complete: false, continuation: 'changed-source-next' } };
    });
    const observed: ForgeCiLogIndexV1[] = [];
    const view = createForgeCiMountedViewV1({ mountId: 'log-continuity', phone: false });
    await view.invoke({ mountId: view.mountId, operation: { kind: 'selectAttempt', selection: vectors.job.ref.selection } });
    await view.invoke({ mountId: view.mountId, operation: { kind: 'selectJob', job: vectors.job.ref } });
    let viewer: ReturnType<typeof useForgeCiLogViewerV1> | null = null;
    let refreshTail: (() => Promise<void>) | undefined;
    function Viewer({ index }: Readonly<{ index: ForgeCiLogIndexV1 }>) {
      viewer = useForgeCiLogViewerV1({ index, view, surfaceId: 'retained-log', containsFocus: () => true, isInputFocused: () => false });
      return <Text value={viewer.lines.map(line => line.plainText).join('\n')} />;
    }
    function currentViewer() {
      if (!viewer) throw new Error('Log viewer did not commit');
      return viewer;
    }
    const Body = () => {
      const state = useForgeCiMountedViewStateV1(view);
      return <ForgeCiJobView reads={reads} job={vectors.job.ref} admittedJob={vectors.job} logExpanded
        logSelection={state?.tailLines == null ? { kind: 'all' } : { kind: 'tail', lines: state.tailLines }}>{model => {
        refreshTail = model.logQuery?.refresh;
        if (model.logIndex) observed.push(model.logIndex);
        return model.logIndex ? <Viewer index={model.logIndex} /> : <Text value="loading" />;
      }}</ForgeCiJobView>;
    };
    try {
      const pane = await mount(Body);
      // The canonical RNW semantic adapter collapses rendered whitespace.
      await pane.getByText('failure context');
      const first = observed.at(-1)!;
      expect(first.plainText).toBe('failure\ncontext');
      await act(async () => { currentViewer().find.setQuery('failure'); });
      const heldFind = currentViewer().find;
      const heldMatches = currentViewer().findSnapshot.matches;
      await act(async () => { await view.invoke({ mountId: view.mountId, operation: { kind: 'setTailLines', lines: 1 } }); });
      await pane.getByText('context');
      expect(currentViewer().find).toBe(heldFind);
      expect(currentViewer().findSnapshot.matches).toBe(heldMatches);
      expect(observed.at(-1)).toBe(first);
      expect(calls.filter(value => value === 'readJobLog')).toHaveLength(1);
      await act(async () => { await pane.dispose(); });
      mounted.splice(mounted.indexOf(pane), 1);
      const page = await mount(Body);
      await page.getByText('context');
      expect(observed.at(-1)).toBe(first);
      expect(observed.at(-1)?.lines[0]?.tokens).toBe(first.lines[0]?.tokens);
      expect(calls.filter(value => value === 'readJobLog')).toHaveLength(1);
      expect(calls.filter(value => value === 'readJob' || value === 'listAnnotations')).toHaveLength(0);
      const source = reads.acquire('readJobLog', { repository: vectors.run.ref.repository, runId: vectors.run.ref.runId,
        jobId: vectors.job.ref.jobId, selection: { kind: 'all' },
        ...(vectors.job.ref.selection.kind === 'attempt' ? { attempt: vectors.job.ref.selection.attempt.attemptId } : {}) });
      const pageFind = currentViewer().find;
      await act(async () => { currentViewer().find.setQuery('context'); replacement = true; await source.refresh(); });
      await page.getByText('failure');
      expect(currentViewer().find).toBe(pageFind);
      expect(currentViewer().findSnapshot.query).toBe('context');
      expect(currentViewer().findSnapshot.index.complete).toBe(false);
      expect(currentViewer().findSnapshot.index.plainText).toBe('failure');
      expect(logSelections).toEqual([{ kind: 'all' }, { kind: 'all' }, { kind: 'tail', lines: 1 }]);
      const refresh = refreshTail;
      const finish = finishTail;
      if (!refresh || !finish) throw new Error('Pending native tail did not mount');
      await act(async () => { finish(); await refresh(); });
      await page.getByText('new context');
      expect(currentViewer().find).toBe(pageFind);
      expect(currentViewer().findSnapshot.query).toBe('context');
      source.release();
    } finally { await act(async () => { reads.retire(); }); }
  });
});
