import { CORPUS_SOURCE_INSTANCES_COLLECTION } from '../../corpus/collections/definitions.js';
import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginUiDataClient, PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TriageListEntriesInputV1Schema,
  TriageListEntriesResultV1Schema,
  type TriageListEntriesInputV1,
  type TriageListEntriesResultV1,
} from '../../actions/listEntriesProtocol.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../../corpus/testkit/observations.test-support.js';
import { TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { createTriageListWindowStore, type TriageListWindowStoreV1 } from '../../projection/listWindowStore.js';
import {
  acquireTriageListWindow,
  loadMoreTriageListWindow,
  readTriageListWindowSnapshot,
  readTriageMountedWindowReadState,
  setTriageListWindowReadiness,
  refreshTriageListWindow,
  setTriageListWindowLens,
  type TriageListWindowHostV1,
  type TriageListWindowLeaseV1,
} from './mountedWindow.js';
import {
  createTriageEphemeralSharedScopeFixture,
  createTriageEphemeralSharedScopeOriginFixture,
} from './ephemeralSharedScope.test-support.js';

/**
 * The scope of the mounted PRs & Issues window.
 *
 * The host-owned ephemeral scope, not a module realm or Host API identity,
 * names one Account + plugin + immutable generation. Separate artifacts share
 * the sole store through that scope. Distinct scopes remain isolated without
 * exposing Account identity to plugin code.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

/**
 * The Host API is a genuine system boundary — a JSON transport into the host's
 * Action dispatcher — so it is the one thing replaced here. Each stub carries a
 * distinct configured source instance, which is what makes "whose rows are
 * these?" observable in the published snapshot.
 */
function createHostStub(
  sourceInstanceId: string,
  options: Readonly<{ paged?: boolean; configuredPaged?: boolean }> = {},
) {
  const calls: string[] = [];
  const inputs: TriageListEntriesInputV1[] = [];
  let gate: Promise<void> | null = null;
  let gateKind: 'all' | 'providerContinuation' | 'configuredContinuation' = 'all';
  let openGate: (() => void) | null = null;
  let rejectGate: ((error: Error) => void) | null = null;
  const result = (continued: boolean): TriageListEntriesResultV1 => ({
    v: 1,
    configuredSources: [{ sourceInstanceId, configurationRowId: sourceInstanceId, source: SOURCE, available: options.paged === true }],
    configuredSourcesStatus: 'complete',
    window: {
      v: 1,
      rows: [],
      // The configured source has no admitted contribution, so its lane is
      // named and unfinished rather than missing: coverage counts what the
      // window set out to ask.
      lanes: [{
        sourceInstanceId,
        source: SOURCE,
        health: options.paged === true
          ? continued
            ? { kind: 'walkFinished' }
            : { kind: 'partial', reason: 'test-page' }
          : { kind: 'unavailable' },
        exhausted: options.paged === true && continued,
      }],
      coverage: 'partial',
      ...(options.paged === true && !continued
        ? { continuations: [{ sourceInstanceId, pageLimit: 56, continuation: { v: 1, token: 'page-2' } }] }
        : {}),
      assembledAtMs: 1,
    },
  });
  const host: TriageListWindowHostV1 = Object.freeze({
    async executeAction(
      action: string,
      input: JsonValue,
      _options?: PluginCancellationOptions,
    ): Promise<unknown> {
      calls.push(action);
      const parsedInput = TriageListEntriesInputV1Schema.parse(input);
      inputs.push(parsedInput);
      const continued = (parsedInput.resume?.length ?? 0) > 0;
      const configuredContinuation = parsedInput.sources.kind === 'allConfigured'
        && parsedInput.sources.cursor !== undefined;
      if (gate && (
        gateKind === 'all'
        || (gateKind === 'providerContinuation' && continued)
        || (gateKind === 'configuredContinuation' && configuredContinuation)
      )) await gate;
      const response = result(continued);
      return (
        options.configuredPaged === true
        && parsedInput.sources.kind === 'allConfigured'
        && parsedInput.sources.cursor === undefined
          ? {
              ...response,
              configuredSourcesStatus: 'truncated',
              configuredSourcesNextCursor: 'configured-page-2',
            }
          : response
      ) as unknown as JsonValue;
    },
  });
  return {
    host,
    calls,
    inputs,
    /** Hold this stub's next passes open so a retirement can overtake them. */
    hold(): void {
      gateKind = 'all';
      gate = new Promise<void>((resolve, reject) => {
        openGate = resolve;
        rejectGate = reject;
      });
    },
    /** Hold only the next continuation-bearing provider read, not enumeration. */
    holdContinuation(): void {
      gateKind = 'providerContinuation';
      gate = new Promise<void>((resolve, reject) => {
        openGate = resolve;
        rejectGate = reject;
      });
    },
    /** Hold only a continued configured-source enumeration page. */
    holdConfiguredContinuation(): void {
      gateKind = 'configuredContinuation';
      gate = new Promise<void>((resolve, reject) => {
        openGate = resolve;
        rejectGate = reject;
      });
    },
    release(): void {
      openGate?.();
      gate = null;
      gateKind = 'all';
      openGate = null;
      rejectGate = null;
    },
    fail(): void {
      rejectGate?.(new Error('mounted client retired'));
      gate = null;
      gateKind = 'all';
      openGate = null;
      rejectGate = null;
    },
  };
}

const createSharedScope = createTriageEphemeralSharedScopeFixture;

it('binds the initial Tasks lens without producing work before the page view demands its one pass', async () => {
  const scope = createSharedScope();
  const h = createHostStub(INSTANCE_A, { paged: true });
  const lease = acquireTriageListWindow(h.host, scope);
  try {
    setTriageListWindowLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1,
      filters: { ...TRIAGE_LIST_DEFAULT_LENS_V1.filters, tasks: 'mine' },
      tasks: { completedSinceMs: 100 },
    }, h.host, scope);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.inputs).toHaveLength(0);
    await refreshTriageListWindow('view', h.host, scope);
    expect(h.inputs.filter(input => input.limit > 0)).toHaveLength(1);
    expect(h.inputs).toHaveLength(2);
    expect(h.inputs.every(input => input.tasks?.completedSinceMs === 100)).toBe(true);
  } finally { lease.release(); }
});

/**
 * A surface that joined another scope's window also inherits that scope's
 * single-flight pass, so its own refresh never settles while the other is held
 * open. Bound the wait so that shows up as a statement about scope rather than
 * as a suite timeout.
 */
async function settles(work: Promise<void>, budgetMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('The refresh never settled; it is waiting on another scope pass.')),
      budgetMs,
    );
  });
  try {
    await Promise.race([work, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function configuredInstanceIds(
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope,
): readonly string[] {
  return readTriageListWindowSnapshot(host, scope).configuredSources.map(
    (summary) => summary.sourceInstanceId,
  );
}

const leases: TriageListWindowLeaseV1[] = [];

function acquire(
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope,
): TriageListWindowLeaseV1 {
  const lease = acquireTriageListWindow(host, scope);
  leases.push(lease);
  return lease;
}

afterEach(() => {
  while (leases.length > 0) leases.pop()?.release();
});

it('uses the same mounted owner for a task completion window and restarts paging when its boundary changes', async () => {
  const scope = createSharedScope();
  const h = createHostStub(INSTANCE_A, { paged: true });
  acquire(h.host, scope);
  const lens = { ...TRIAGE_LIST_DEFAULT_LENS_V1, tasks: { completedSinceMs: 100 } };
  setTriageListWindowLens(lens, h.host, scope);
  await refreshTriageListWindow('manual', h.host, scope);
  expect(h.calls).toContain('tasks/list-v1');
  expect(h.inputs.filter(input => input.limit > 0).at(-1)).toMatchObject({ tasks: { completedSinceMs: 100 } });
  await loadMoreTriageListWindow(h.host, scope);
  expect(h.inputs.filter(input => input.limit > 0).at(-1)).toMatchObject({ tasks: { completedSinceMs: 100 }, resume: expect.any(Array) });
  setTriageListWindowLens({ ...lens, tasks: { completedSinceMs: 200 } }, h.host, scope);
  await refreshTriageListWindow('manual', h.host, scope);
  const restarted = h.inputs.filter(input => input.limit > 0).at(-1);
  expect(restarted).toMatchObject({ tasks: { completedSinceMs: 200 } });
  expect(restarted).not.toHaveProperty('resume');
  setTriageListWindowLens(TRIAGE_LIST_DEFAULT_LENS_V1, h.host, scope);
  await refreshTriageListWindow('manual', h.host, scope);
  expect(h.calls.at(-1)).toBe('entries/list-v1');
  expect(h.inputs.at(-1)).not.toHaveProperty('tasks');
});

describe('the mounted PRs & Issues window is scoped by its host-owned lifetime', () => {
  it('reads and subscribes to a window produced by an artifact with the original v1 shared shape', async () => {
    const lifetime = createTriageEphemeralSharedScopeOriginFixture();
    const scope = lifetime.forExecutionOrigin('mixed-artifacts');
    const first = createHostStub(INSTANCE_A, { paged: true });
    const second = createHostStub(INSTANCE_B);
    // Primary basis: 5953e70e60cb31d3f7ca40c57b078df58f2007ce
    // (aa8da0daee^), mountedWindow.ts:66. Its v1 value exposed only
    // store/registerClient; readiness was never shared by that producer.
    const clients = new Map<TriageListWindowHostV1, number>();
    const store = createTriageListWindowStore({
      readEntries: async (input, options) => {
        const client = clients.keys().next().value;
        if (!client) throw new Error('No live legacy client');
        return TriageListEntriesResultV1Schema.parse(await client.executeAction('entries/list-v1', input, options));
      },
      nowMs: () => Date.now(),
    });
    const original = scope.acquire('triage.list-window.v1', () => ({
      value: { store, registerClient(client: TriageListWindowHostV1) {
        clients.set(client, (clients.get(client) ?? 0) + 1);
        let registered = true;
        return () => {
          if (!registered) return;
          registered = false;
          const remaining = (clients.get(client) ?? 1) - 1;
          if (remaining > 0) clients.set(client, remaining);
          else clients.delete(client);
        };
      } },
      retainWhenIdle: true,
      dispose: () => { clients.clear(); store.dispose(); },
    }));
    if (!original) throw new Error('Expected the original shared producer');
    const unregisterFirst = original.value.registerClient(first.host);
    vi.resetModules();
    const reader = await import('./mountedWindow.js');
    const lease = reader.acquireTriageListWindow(second.host, scope, { pending: true, revision: 0 });
    const notified = vi.fn();
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = reader.subscribeToTriageListWindow(second.host, notified, scope);
      reader.setTriageListWindowReadiness(second.host, scope, { pending: false, ready: true, revision: 1 });
      const before = reader.readTriageMountedWindowReadState(second.host, scope);
      expect(before.readiness).toBeNull();
      expect(reader.readTriageMountedWindowReadState(second.host, scope)).toBe(before);
      await Promise.all([store.refresh('view'), reader.refreshTriageListWindow('view', second.host, scope)]);
      expect(first.inputs.filter(input => input.limit > 0)).toHaveLength(1);
      expect(second.calls).toHaveLength(0);
      expect(notified).toHaveBeenCalled();
      const after = reader.readTriageMountedWindowReadState(second.host, scope);
      expect(after.snapshot).toBe(store.getSnapshot());
      expect(after.snapshot.configuredSources.map(source => source.sourceInstanceId)).toEqual([INSTANCE_A]);
      expect(after).not.toBe(before);
      expect(reader.readTriageMountedWindowReadState(second.host, scope)).toBe(after);
      lease.release();
      expect(store.getSnapshot()).toBe(after.snapshot);
    } finally {
      unsubscribe?.(); lease.release(); unregisterFirst(); original.release(); lifetime.retire();
    }
  }, 60_000);

  it('keeps the original reader contract when a newer artifact produced the shared window', async () => {
    const lifetime = createTriageEphemeralSharedScopeOriginFixture();
    const scope = lifetime.forExecutionOrigin('mixed-artifacts');
    const first = createHostStub(INSTANCE_A);
    const originalReader = createHostStub(INSTANCE_B, { paged: true });
    const firstLease = acquireTriageListWindow(first.host, scope, { pending: true, revision: 0 });
    const original = scope.acquire<Readonly<{
      store: TriageListWindowStoreV1;
      registerClient(host: TriageListWindowHostV1): () => void;
    }>>('triage.list-window.v1', () => { throw new Error('The newer producer owns this slot'); });
    if (!original) throw new Error('Expected the shared window');
    const unregister = original.value.registerClient(originalReader.host);
    const notified = vi.fn();
    const unsubscribe = original.value.store.subscribe(notified);
    let readerLease: TriageListWindowLeaseV1 | undefined;
    try {
      firstLease.release();
      readerLease = acquireTriageListWindow(first.host, scope, { pending: false, ready: true, revision: 1 });
      expect(readTriageMountedWindowReadState(first.host, scope).readiness).toBeNull();
      await Promise.all([original.value.store.refresh('view'), refreshTriageListWindow('view', first.host, scope)]);
      expect(originalReader.inputs.filter(input => input.limit > 0)).toHaveLength(1);
      expect(first.calls).toHaveLength(0);
      expect(notified).toHaveBeenCalled();
      expect(readTriageListWindowSnapshot(first.host, scope)).toBe(original.value.store.getSnapshot());
    } finally {
      unsubscribe(); readerLease?.release(); firstLease.release(); unregister(); original.release(); lifetime.retire();
    }
  });

  it('forwards readiness from the actual read client and ignores another artifact without acquiring data', () => {
    const first = createHostStub(INSTANCE_A);
    const second = createHostStub(INSTANCE_B);
    const scope = createSharedScope();
    const pending = Object.freeze({ pending: true, revision: 0 });
    const ready = Object.freeze({ pending: false, revision: 1 });
    const firstLease = acquireTriageListWindow(first.host, scope, pending);
    leases.push(firstLease, acquireTriageListWindow(second.host, scope, ready));
    expect(readTriageMountedWindowReadState(second.host, scope).readiness).toBe(pending);
    setTriageListWindowReadiness(second.host, scope, Object.freeze({ pending: false, revision: 2 }));
    expect(readTriageMountedWindowReadState(second.host, scope).readiness).toBe(pending);
    setTriageListWindowReadiness(first.host, scope, ready);
    expect(readTriageMountedWindowReadState(second.host, scope).readiness).toBe(ready);
    firstLease.release();
    expect(readTriageMountedWindowReadState(second.host, scope).readiness).toEqual({ pending: false, revision: 2 });
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
  });

  it('retains the last observation when the final client retires instead of manufacturing re-admission', () => {
    const first = createHostStub(INSTANCE_A);
    const scope = createSharedScope();
    const pending = Object.freeze({ pending: true, revision: 0 });
    const lease = acquireTriageListWindow(first.host, scope, pending);
    const observer = scope.acquire<Readonly<{ readState(): Readonly<{ readiness: typeof pending }> }>>('triage.list-window.v1', () => {
      throw new Error('The mounted window already owns the slot');
    });
    if (!observer) throw new Error('Expected the current shared slot');
    try {
      lease.release();
      expect(observer.value.readState().readiness).toBe(pending);
      expect(first.calls).toHaveLength(0);
    } finally { observer.release(); }
  });


  it('does not let a second Account join the first Account window', async () => {
    const accountA = createHostStub(INSTANCE_A);
    const accountB = createHostStub(INSTANCE_B);
    const scopeA = createSharedScope();
    const scopeB = createSharedScope();

    acquire(accountA.host, scopeA);
    await refreshTriageListWindow('view', accountA.host, scopeA);
    expect(configuredInstanceIds(accountA.host, scopeA)).toEqual([INSTANCE_A]);

    acquire(accountB.host, scopeB);
    await refreshTriageListWindow('view', accountB.host, scopeB);

    // The second surface reached its own host, not the first acquisition's.
    expect(accountB.calls.length).toBeGreaterThan(0);
    expect(configuredInstanceIds(accountB.host, scopeB)).toEqual([INSTANCE_B]);
    // ...and neither window observed the other's configured sources.
    expect(configuredInstanceIds(accountA.host, scopeA)).toEqual([INSTANCE_A]);
  });

  it('keeps a retired Account scope late pass out of another Account scope', async () => {
    const accountA = createHostStub(INSTANCE_A);
    const accountB = createHostStub(INSTANCE_B);
    const scopeA = createSharedScope();
    const scopeB = createSharedScope();

    accountA.hold();
    const retiring = acquire(accountA.host, scopeA);
    const latePass = refreshTriageListWindow('view', accountA.host, scopeA);

    acquire(accountB.host, scopeB);
    retiring.release();

    await settles(refreshTriageListWindow('view', accountB.host, scopeB));
    expect(configuredInstanceIds(accountB.host, scopeB)).toEqual([INSTANCE_B]);

    accountA.release();
    await latePass;
    await Promise.resolve();

    expect(configuredInstanceIds(accountB.host, scopeB)).toEqual([INSTANCE_B]);
    // The retired Account scope is gone rather than left readable.
    expect(readTriageListWindowSnapshot(accountA.host, scopeA).configuredSources).toEqual([]);
  });

  it('shares the exact store across shell and picker artifact realms', async () => {
    // This file's static import is already one loaded artifact realm. Resetting
    // once and importing again creates the independent picker realm the
    // contract needs to prove; resetting and importing twice paid for two full
    // graph resolutions without making the realms any more independent.
    const shellRealm = {
      acquireTriageListWindow,
      loadMoreTriageListWindow,
      readTriageListWindowSnapshot,
      refreshTriageListWindow,
      setTriageListWindowLens,
    };
    vi.resetModules();
    const pickerRealm = await import('./mountedWindow.js');
    expect(shellRealm.acquireTriageListWindow).not.toBe(pickerRealm.acquireTriageListWindow);

    const scope = createSharedScope();
    const shellHost = createHostStub(INSTANCE_A, { paged: true });
    const pickerHost = createHostStub(INSTANCE_A);
    const shellLease = shellRealm.acquireTriageListWindow(shellHost.host, scope);
    const pickerLease = pickerRealm.acquireTriageListWindow(pickerHost.host, scope);
    await shellRealm.refreshTriageListWindow('view', shellHost.host, scope);

    const shellSnapshot = shellRealm.readTriageListWindowSnapshot(shellHost.host, scope);
    expect(shellSnapshot.configuredSources).toHaveLength(1);
    expect(shellSnapshot.loadMore).toEqual({ kind: 'available' });
    expect(pickerRealm.readTriageListWindowSnapshot(pickerHost.host, scope)).toBe(shellSnapshot);
    expect(shellHost.calls.length).toBeGreaterThan(0);
    expect(pickerHost.calls).toEqual([]);

    await pickerRealm.loadMoreTriageListWindow(pickerHost.host, scope);
    const afterPaging = shellRealm.readTriageListWindowSnapshot(shellHost.host, scope);
    expect(afterPaging).toBe(pickerRealm.readTriageListWindowSnapshot(pickerHost.host, scope));
    expect(afterPaging.loadMore).toEqual({ kind: 'exhausted' });

    const readsBeforeLens = shellHost.calls.length;
    pickerRealm.setTriageListWindowLens({
      ...TRIAGE_LIST_DEFAULT_LENS_V1,
      query: 'only-in-picker',
    }, pickerHost.host, scope);
    const afterLens = shellRealm.readTriageListWindowSnapshot(shellHost.host, scope);
    // This empty retained window has the same local result under the new
    // text; changing it neither invalidates coverage nor starts acquisition.
    expect(afterLens).toBe(afterPaging);
    expect(afterLens.loadMore).toEqual({ kind: 'exhausted' });
    expect(shellHost.calls).toHaveLength(readsBeforeLens);
    expect(afterLens).toBe(pickerRealm.readTriageListWindowSnapshot(pickerHost.host, scope));

    shellLease.release();
    expect(pickerRealm.readTriageListWindowSnapshot(pickerHost.host, scope)).toBe(afterLens);
    pickerLease.release();
    expect(pickerRealm.readTriageListWindowSnapshot(pickerHost.host, scope)).toMatchObject({
      freshness: 'unknown',
      configuredSources: [],
    });
  }, 60_000);

  it('shares one window across execution origins and restarts paging after its active origin retires', async () => {
    const shellRealm = {
      acquireTriageListWindow,
      loadMoreTriageListWindow,
      readTriageListWindowSnapshot,
      refreshTriageListWindow,
    };
    vi.resetModules();
    const pickerRealm = await import('./mountedWindow.js');
    const originScopes = createTriageEphemeralSharedScopeOriginFixture();
    const shellScope = originScopes.forExecutionOrigin('daemon-a');
    const pickerScope = originScopes.forExecutionOrigin('daemon-b');
    const shell = createHostStub(INSTANCE_A, { paged: true });
    const picker = createHostStub(INSTANCE_A, { paged: true });
    const shellLease = shellRealm.acquireTriageListWindow(shell.host, shellScope);
    const pickerLease = pickerRealm.acquireTriageListWindow(picker.host, pickerScope);

    await shellRealm.refreshTriageListWindow('view', shell.host, shellScope);

    const sharedSnapshot = shellRealm.readTriageListWindowSnapshot(shell.host, shellScope);
    expect(sharedSnapshot.loadMore).toEqual({ kind: 'available' });
    expect(pickerRealm.readTriageListWindowSnapshot(picker.host, pickerScope)).toBe(sharedSnapshot);
    expect(picker.inputs).toEqual([]);

    shell.holdContinuation();
    const interruptedAppend = shellRealm.loadMoreTriageListWindow(shell.host, shellScope);
    await vi.waitFor(() => {
      expect(shell.inputs.some((input) => (input.resume?.length ?? 0) > 0)).toBe(true);
    }, { timeout: 5_000, interval: 10 });
    shellLease.release();
    shell.fail();
    await settles(interruptedAppend);

    const replacementScans = picker.inputs.filter((input) => input.limit > 0);
    expect(replacementScans.length).toBeGreaterThan(0);
    expect(replacementScans.every((input) => input.resume === undefined)).toBe(true);
    expect(pickerRealm.readTriageListWindowSnapshot(picker.host, pickerScope).loadMore).toEqual({
      kind: 'available',
    });

    await pickerRealm.loadMoreTriageListWindow(picker.host, pickerScope);
    const resumed = picker.inputs.filter((input) => input.limit > 0).at(-1);
    expect(resumed?.resume).toHaveLength(1);
    pickerLease.release();
  }, 60_000);

  it('does not send a configured-source cursor through a replacement execution origin', async () => {
    const originScopes = createTriageEphemeralSharedScopeOriginFixture();
    const originAScope = originScopes.forExecutionOrigin('daemon-a');
    const originBScope = originScopes.forExecutionOrigin('daemon-b');
    const originA = createHostStub(INSTANCE_A, { configuredPaged: true });
    const originB = createHostStub(INSTANCE_A);
    originA.holdConfiguredContinuation();
    const originALease = acquire(originA.host, originAScope);
    acquire(originB.host, originBScope);

    const interruptedEnumeration = refreshTriageListWindow('view', originA.host, originAScope);
    await vi.waitFor(() => {
      expect(originA.inputs.some((input) => (
        input.sources.kind === 'allConfigured' && input.sources.cursor !== undefined
      ))).toBe(true);
    }, { timeout: 5_000, interval: 10 });
    originALease.release();
    originA.fail();
    await settles(interruptedEnumeration);

    const replacementEnumeration = originB.inputs.filter(
      (input) => input.sources.kind === 'allConfigured',
    );
    expect(replacementEnumeration.length).toBeGreaterThan(0);
    expect(replacementEnumeration.every((input) => (
      input.sources.kind === 'allConfigured' && input.sources.cursor === undefined
    ))).toBe(true);
  });

  it('does not manufacture an artifact-local store when the renderer lacks the host scope', async () => {
    const host = createHostStub(INSTANCE_A);
    const lease = acquireTriageListWindow(host.host, null);
    await refreshTriageListWindow('view', host.host, null);

    expect(host.calls).toEqual([]);
    expect(readTriageListWindowSnapshot(host.host, null)).toMatchObject({
      freshness: 'unknown',
      configuredSources: [],
    });
    lease.release();
  });

  it('does not read the old scope while the same host object joins a replacement scope', async () => {
    const host = createHostStub(INSTANCE_A);
    const scopeA = createSharedScope();
    const scopeB = createSharedScope();
    const leaseA = acquireTriageListWindow(host.host, scopeA);
    await refreshTriageListWindow('view', host.host, scopeA);
    expect(readTriageListWindowSnapshot(host.host, scopeA).configuredSources).toHaveLength(1);

    const leaseB = acquireTriageListWindow(host.host, scopeB);
    expect(readTriageListWindowSnapshot(host.host, scopeB)).toMatchObject({
      freshness: 'unknown',
      configuredSources: [],
    });
    leaseA.release();
    leaseB.release();
  });

  it('finishes a safe shared read through a live artifact when its first client retires', async () => {
    const scope = createSharedScope();
    const shell = createHostStub(INSTANCE_A);
    const picker = createHostStub(INSTANCE_A);
    shell.hold();
    const shellLease = acquireTriageListWindow(shell.host, scope);
    const pickerLease = acquireTriageListWindow(picker.host, scope);

    const pass = refreshTriageListWindow('view', shell.host, scope);
    shellLease.release();
    shell.fail();
    await settles(pass);

    expect(picker.calls.length).toBeGreaterThan(0);
    expect(configuredInstanceIds(picker.host, scope)).toEqual([INSTANCE_A]);
    pickerLease.release();
  });
});


it('pushes one external Task transition into both mounted projections with one read', async () => {
  const scope = createTriageEphemeralSharedScopeFixture();
  let state: 'started' | 'canceled' = 'started';
  let reads = 0;
  let listener: (() => void) | undefined;
  const watchAccountData: PluginUiDataClient['watchAccountData'] = async (selection, next) => {
    if (selection.kind !== 'internalTasks') return { dispose() {} };
    listener = next;
    return { dispose() { listener = undefined; } };
  };
  const data = { watchAccountData };
  const host: TriageListWindowHostV1 = { async executeAction() {
    reads++;
    return TriageListEntriesResultV1Schema.parse({ v: 1,
      configuredSources: [{ sourceInstanceId: INSTANCE_A, configurationRowId: INSTANCE_A, source: INTERNAL_TASK_SOURCE_V1, available: true }],
      configuredSourcesStatus: 'complete', window: { v: 1, coverage: 'complete', assembledAtMs: reads,
        rows: [{ entryRef: { source: INTERNAL_TASK_SOURCE_V1, kindId: 'task', collisionScope: 'personal', entryId: 'task-a' },
          lane: '1-open', sortAtMs: 1, presence: { kind: 'present', observedAtMs: reads },
          selected: { kind: 'selected', sourceInstanceId: INSTANCE_A, reason: 'onlyPresent' },
          observation: { sourceInstanceId: INSTANCE_A, observedAtMs: reads, outcome: { kind: 'present',
            locator: testkitLocator(), snapshot: testkitSnapshot({ title: 'Externally changed task',
              state: state === 'started' ? { presentation: 'active', stage: 'started', nativeLabel: 'In progress' }
                : { presentation: 'closed', completionReason: 'canceled', nativeLabel: 'Canceled' } }), viewer: testkitViewer() } },
          otherObservations: [], observedByCount: 1 }],
        lanes: [{ sourceInstanceId: INSTANCE_A, source: INTERNAL_TASK_SOURCE_V1, health: { kind: 'walkFinished' }, exhausted: true }],
      } });
  } };
  const otherHost: TriageListWindowHostV1 = { executeAction: host.executeAction };
  const first = acquireTriageListWindow(host, scope, undefined, data);
  const second = acquireTriageListWindow(otherHost, scope, undefined, data);
  try {
    await refreshTriageListWindow('view', host, scope);
    expect(readTriageListWindowSnapshot(host, scope).window?.rows[0]?.observations[0]?.outcome).toMatchObject({ snapshot: { state: { stage: 'started' } } });
    const before = reads;
    state = 'canceled'; // another writer changed the genuine Action boundary's next answer
    listener?.();
    await vi.waitFor(() => expect(readTriageListWindowSnapshot(host, scope).window?.rows[0]?.observations[0]?.outcome)
      .toMatchObject({ snapshot: { state: { completionReason: 'canceled' } } }));
    expect(readTriageListWindowSnapshot(otherHost, scope)).toBe(readTriageListWindowSnapshot(host, scope));
    expect(reads - before).toBe(1);
  } finally { first.release(); second.release(); }
  expect(listener).toBeUndefined();
});


it.each(['viewer', 'owner'])('reconciles qualified %s Task pushes beyond page one, new matches and absence without list-page reads', async ownerAccountId => {
  const scope = createTriageEphemeralSharedScopeFixture();
  let listener: ((change?: { kind: 'internalTasks'; accountId: string; tasks: { ownerAccountId: string; taskId: string }[] }) => void) | undefined;
  let pageReads = 0;
  const exactReads: string[] = [];
  let absent = false;
  let changed = false;
  const ref = (id: string) => ({ source: INTERNAL_TASK_SOURCE_V1, kindId: 'task', collisionScope: ownerAccountId === 'viewer' ? 'personal' : `account:${ownerAccountId}`, entryId: id });
  const outcome = (completed: boolean) => ({ kind: 'present' as const, locator: testkitLocator(),
    snapshot: testkitSnapshot({ title: 'Matching task', state: completed
      ? { presentation: 'resolved', completionReason: 'completed', nativeLabel: 'Done' }
      : { presentation: 'active', stage: 'unstarted', nativeLabel: 'To do' } }), viewer: testkitViewer() });
  const host: TriageListWindowHostV1 = { async executeAction(action, input) {
    if (action === 'entries/reobserve-v1') {
      const id = (input as { entryRef: { entryId: string } }).entryRef.entryId;
      exactReads.push(id);
      return { kind: 'observed', entryRef: ref(id), observation: { sourceInstanceId: INSTANCE_A,
        observedAtMs: 2, outcome: absent ? { kind: 'absent' } : outcome(true) } };
    }
    pageReads++;
    return TriageListEntriesResultV1Schema.parse({ v: 1,
      configuredSources: [{ sourceInstanceId: INSTANCE_A, configurationRowId: INSTANCE_A, source: INTERNAL_TASK_SOURCE_V1, available: true }],
      configuredSourcesStatus: 'complete', window: { v: 1, coverage: 'partial', assembledAtMs: 1,
        rows: !changed ? [{ entryRef: ref('task-a'), lane: '1-open', sortAtMs: 1,
          presence: { kind: 'present', observedAtMs: 1 }, selected: { kind: 'selected', sourceInstanceId: INSTANCE_A, reason: 'onlyPresent' },
          observation: { sourceInstanceId: INSTANCE_A, observedAtMs: 1, outcome: outcome(false) }, otherObservations: [], observedByCount: 1 }] : [],
        lanes: [{ sourceInstanceId: INSTANCE_A, source: INTERNAL_TASK_SOURCE_V1, health: { kind: 'partial', reason: 'pageLimit' }, exhausted: false }],
      } });
  } };
  const otherHost = { executeAction: host.executeAction };
  const data: Pick<PluginUiDataClient, 'watchAccountData'> = { async watchAccountData(selection, next) {
    if (selection.kind === 'internalTasks') listener = next;
    return { dispose() { if (selection.kind === 'internalTasks') listener = undefined; } };
  } };
  const first = acquireTriageListWindow(host, scope, undefined, data);
  const second = acquireTriageListWindow(otherHost, scope, undefined, data);
  const rows = () => readTriageListWindowSnapshot(host, scope).window?.rows ?? [];
  const push = (taskId: string) => { changed = true; listener?.({ kind: 'internalTasks', accountId: 'viewer', tasks: [{ ownerAccountId, taskId }] }); };
  try {
    await refreshTriageListWindow('view', host, scope);
    setTriageListWindowLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'Matching task' }, host, scope);
    expect(rows()[0]?.content?.outcome.snapshot.state).toMatchObject({ stage: 'unstarted' });
    const before = pageReads;
    push('task-a');
    await vi.waitFor(() => expect(rows()[0]?.content?.outcome.snapshot.state).toMatchObject({ completionReason: 'completed' }));
    expect(exactReads).toEqual(['task-a']);
    expect(pageReads).toBe(before);
    expect(readTriageListWindowSnapshot(otherHost, scope)).toBe(readTriageListWindowSnapshot(host, scope));
    push('task-b'); // not in the retained page; exact admission discovers a new matching row
    await vi.waitFor(() => expect(rows().map(row => row.entryRef.entryId).sort()).toEqual(['task-a', 'task-b']));
    expect(exactReads).toEqual(['task-a', 'task-b']);
    absent = true;
    push('task-a');
    await vi.waitFor(() => expect(rows().map(row => row.entryRef.entryId)).toEqual(['task-b']));
    expect(exactReads).toEqual(['task-a', 'task-b', 'task-a']);
    expect(pageReads).toBe(before);
  } finally { first.release(); second.release(); }
});


it('removes a deleted source from both mounted windows on the existing collection change', async () => {
  const scope = createTriageEphemeralSharedScopeFixture();
  let deleted = false;
  let reads = 0;
  let listener: (() => void) | undefined;
  const data: Pick<PluginUiDataClient, 'watchAccountData'> = { async watchAccountData(selection, next) {
    if (selection.kind !== 'collection' || selection.collectionId !== CORPUS_SOURCE_INSTANCES_COLLECTION.id) return { dispose() {} };
    listener = next;
    return { dispose() { listener = undefined; } };
  } };
  const host: TriageListWindowHostV1 = { async executeAction() {
    reads++;
    return TriageListEntriesResultV1Schema.parse({ v: 1, configuredSources: deleted ? [] : [
      { sourceInstanceId: INSTANCE_A, configurationRowId: INSTANCE_A, source: INTERNAL_TASK_SOURCE_V1, available: true }],
      configuredSourcesStatus: 'complete', window: { v: 1, coverage: 'complete', assembledAtMs: reads, rows: [], lanes: [] } });
  } };
  const secondHost = { executeAction: host.executeAction };
  const first = acquireTriageListWindow(host, scope, undefined, data);
  const second = acquireTriageListWindow(secondHost, scope, undefined, data);
  try {
    await refreshTriageListWindow('view', host, scope);
    expect(readTriageListWindowSnapshot(host, scope).configuredSources).toHaveLength(1);
    const before = reads;
    deleted = true;
    listener?.();
    await vi.waitFor(() => expect(readTriageListWindowSnapshot(host, scope).configuredSources).toHaveLength(0));
    expect(readTriageListWindowSnapshot(secondHost, scope)).toBe(readTriageListWindowSnapshot(host, scope));
    expect(reads - before).toBe(1);
  } finally { first.release(); second.release(); }
  expect(listener).toBeUndefined();
});
