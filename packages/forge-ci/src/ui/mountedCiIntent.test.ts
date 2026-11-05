import { describe, expect, it } from 'vitest';
import { adaptForgeCiLogViewV1, createForgeCiMountedViewV1 } from './mountedCiIntent.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' } as const;
const run = { v: 1, repository, runId: '100' } as const;
const selection = { kind: 'attempt', attempt: { run, attemptId: '1', number: 1 } } as const;

describe('mounted CI operands', () => {
  it('applies Tail to All through the real log-view adapter, publishes once and still rejects zero lines', async () => {
    const job = { selection, jobId: 'job-1' };
    const view = createForgeCiMountedViewV1({ mountId: 'log-selection', phone: false,
      initialState: { selection, job, tailLines: 50 } });
    const logView = adaptForgeCiLogViewV1(view, () => job);
    let publications = 0;
    view.subscribe(() => { publications++; });
    try {
      expect(logView.getSnapshot()?.selection).toEqual({ kind: 'tail', lines: 50 });
      logView.invoke({ kind: 'setSelection', selection: { kind: 'all' } });
      expect(view.getSnapshot()?.tailLines).toBeNull();
      expect(logView.getSnapshot()?.selection).toEqual({ kind: 'all' });
      expect(publications).toBe(1);
      const settled = view.getSnapshot();
      logView.invoke({ kind: 'setSelection', selection: { kind: 'all' } });
      expect(view.getSnapshot()).toBe(settled);
      expect(publications).toBe(1);
      expect(await view.invoke({ mountId: view.mountId, operation: { kind: 'setTailLines', lines: 0 } })).toEqual({ status: 'rejected' });
      expect(view.getSnapshot()).toBe(settled);
      logView.invoke({ kind: 'setSelection', selection: { kind: 'tail', lines: 1 } });
      expect(logView.getSnapshot()?.selection).toEqual({ kind: 'tail', lines: 1 });
      expect(publications).toBe(2);
    } finally { view.dispose(); }
  });

  it('owns the loaded-row lens separately from provider filters and emits only actual lens changes', async () => {
    const view = createForgeCiMountedViewV1({ mountId: 'lens', phone: false });
    await view.invoke({ mountId: 'lens', operation: { kind: 'setFilters', filters: { branch: 'main' } } });
    let publications = 0;
    view.subscribe(() => { publications++; });
    for (let n = 0; n < 100; n++) {
      expect(await view.invoke({ mountId: 'lens', operation: { kind: 'setRunScope', scope: 'failed' } })).toEqual({ status: 'applied' });
      expect(await view.invoke({ mountId: 'lens', operation: { kind: 'setQuery', query: 'compile' } })).toEqual({ status: 'applied' });
    }
    expect(view.getSnapshot()).toMatchObject({ runScope: 'failed', query: 'compile', filters: { branch: 'main' } });
    expect(publications).toBe(2);
    await view.invoke({ mountId: 'lens', operation: { kind: 'setQuery', query: '' } });
    await view.invoke({ mountId: 'lens', operation: { kind: 'setRunScope', scope: 'all' } });
    expect(view.getSnapshot()).toMatchObject({ runScope: 'all', query: '', filters: { branch: 'main' } });
    expect(publications).toBe(4);
    view.dispose();
  });

  it('keeps an already selected job mounted when its attempt and job are synchronized again', async () => {
    const job = { selection, jobId: 'job-1' };
    const navigations: string[] = [];
    // applyOperation is the physical host navigation boundary. Replaying the
    // unchanged attempt there would navigate from the job back to its summary.
    const view = createForgeCiMountedViewV1({
      mountId: 'selected-job', phone: false, initialState: { selection, job },
      applyOperation: operation => { navigations.push(operation.kind); return true; },
    });
    const selected = view.getSnapshot();
    let publications = 0;
    view.subscribe(() => { publications++; });
    for (let n = 0; n < 100; n++) {
      expect(await view.invoke({ mountId: view.mountId, operation: { kind: 'selectAttempt', selection } })).toEqual({ status: 'applied' });
      expect(await view.invoke({ mountId: view.mountId, operation: { kind: 'selectJob', job } })).toEqual({ status: 'applied' });
    }
    expect(navigations).toEqual([]);
    expect(publications).toBe(0);
    expect(view.getSnapshot()).toBe(selected);
    const nextJob = { selection, jobId: 'job-2' };
    expect(await view.invoke({ mountId: view.mountId, operation: { kind: 'selectJob', job: nextJob } })).toEqual({ status: 'applied' });
    expect(navigations).toEqual(['selectJob']);
    expect(view.getSnapshot()?.job).toEqual(nextJob);
    view.dispose();
  });

  it('addresses exactly one live mount, rejects malformed operations, and retracts on disposal', async () => {
    const view = createForgeCiMountedViewV1({ mountId: 'ci-1', phone: false });
    expect(await view.invoke({ mountId: 'other', operation: { kind: 'setTimestampsVisible', visible: false } })).toEqual({ status: 'unavailable' });
    expect(await view.invoke({ mountId: 'ci-1', operation: { kind: 'setTimestampsVisible', visible: false, extra: true } })).toEqual({ status: 'rejected' });
    expect(await view.invoke({ mountId: 'ci-1', operation: { kind: 'selectAttempt', selection } })).toEqual({ status: 'applied' });
    expect(view.getSnapshot()?.selection).toEqual(selection);
    view.dispose();
    expect(view.getSnapshot()).toBeNull();
    expect(await view.invoke({ mountId: 'ci-1', operation: { kind: 'selectRun', run } })).toEqual({ status: 'unavailable' });
  });

  it('keeps pinned attempts and refuses associating another run job or step', async () => {
    const view = createForgeCiMountedViewV1({ mountId: 'ci', phone: false });
    await view.invoke({ mountId: 'ci', operation: { kind: 'selectAttempt', selection } });
    const job = { selection, jobId: 'job-1' };
    await view.invoke({ mountId: 'ci', operation: { kind: 'selectJob', job } });
    expect(view.getSnapshot()?.selection).toEqual(selection);
    expect(await view.invoke({ mountId: 'ci', operation: { kind: 'selectStep', step: { job: { ...job, jobId: 'other' }, stepId: '9' } } })).toEqual({ status: 'rejected' });
    const wrongJob = { selection: { kind: 'run', run: { ...run, runId: '200' } }, jobId: 'job-1' };
    expect(await view.invoke({ mountId: 'ci', operation: { kind: 'selectJob', job: wrongJob } })).toEqual({ status: 'rejected' });
    expect(view.getSnapshot()?.job).toEqual(job);
  });

  it('refuses hidden mounts and unavailable graph presentation without invoking reads', async () => {
    let visible = true;
    const view = createForgeCiMountedViewV1({ mountId: 'ci', phone: false, isAvailable: () => visible });
    expect(await view.invoke({ mountId: 'ci', operation: { kind: 'setJobsView', view: 'graph' } })).toEqual({ status: 'unavailable' });
    visible = false;
    expect(await view.invoke({ mountId: 'ci', operation: { kind: 'setFilters', filters: { branch: 'main' } } })).toEqual({ status: 'unavailable' });
    expect(view.getSnapshot()?.filters).toEqual({});
  });

  it('retains explicit timestamps in the same viewer, defaults only at new mount, and publishes only changed operands', async () => {
    const desktop = createForgeCiMountedViewV1({ mountId: 'desktop', phone: false });
    const phone = createForgeCiMountedViewV1({ mountId: 'phone', phone: true });
    expect(desktop.getSnapshot()?.timestampsVisible).toBe(true);
    expect(phone.getSnapshot()?.timestampsVisible).toBe(false);
    let publications = 0;
    desktop.subscribe(() => { publications++; });
    const input = { mountId: 'desktop', operation: { kind: 'setTimestampsVisible', visible: false } };
    await desktop.invoke(input);
    const changed = desktop.getSnapshot();
    await desktop.invoke(input);
    expect(desktop.getSnapshot()).toBe(changed);
    expect(publications).toBe(1);
    await desktop.invoke({ mountId: 'desktop', operation: { kind: 'selectRun', run } });
    expect(desktop.getSnapshot()?.timestampsVisible).toBe(false);
    expect(createForgeCiMountedViewV1({ mountId: 'new', phone: false }).getSnapshot()?.timestampsVisible).toBe(true);
  });
});
