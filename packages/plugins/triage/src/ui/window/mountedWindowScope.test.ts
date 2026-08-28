import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TriageListEntriesResultV1 } from '../../actions/listEntriesProtocol.js';
import { TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import {
  acquireTriageListWindow,
  loadMoreTriageListWindow,
  readTriageListWindowSnapshot,
  refreshTriageListWindow,
  setTriageListWindowLens,
  type TriageListWindowHostV1,
  type TriageListWindowLeaseV1,
} from './mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from './ephemeralSharedScope.test-support.js';

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
function createHostStub(sourceInstanceId: string, options: Readonly<{ paged?: boolean }> = {}) {
  const calls: string[] = [];
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  let rejectGate: ((error: Error) => void) | null = null;
  const result = (continued: boolean): TriageListEntriesResultV1 => ({
    v: 1,
    configuredSources: [{ sourceInstanceId, source: SOURCE, available: options.paged === true }],
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
        health: { kind: 'unavailable' },
        exhausted: options.paged === true && continued,
      }],
      coverage: 'partial',
      ...(options.paged === true && !continued
        ? { continuations: [{ sourceInstanceId, continuation: { v: 1, token: 'page-2' } }] }
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
      if (gate) await gate;
      const continued = typeof input === 'object'
        && input !== null
        && !Array.isArray(input)
        && Array.isArray((input as { resume?: unknown }).resume)
        && ((input as { resume: unknown[] }).resume.length > 0);
      return result(continued) as unknown as JsonValue;
    },
  });
  return {
    host,
    calls,
    /** Hold this stub's next passes open so a retirement can overtake them. */
    hold(): void {
      gate = new Promise<void>((resolve, reject) => {
        openGate = resolve;
        rejectGate = reject;
      });
    },
    release(): void {
      openGate?.();
      gate = null;
      openGate = null;
      rejectGate = null;
    },
    fail(): void {
      rejectGate?.(new Error('mounted client retired'));
      gate = null;
      openGate = null;
      rejectGate = null;
    },
  };
}

const createSharedScope = createTriageEphemeralSharedScopeFixture;

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

describe('the mounted PRs & Issues window is scoped by its host-owned lifetime', () => {
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

    pickerRealm.setTriageListWindowLens({
      ...TRIAGE_LIST_DEFAULT_LENS_V1,
      query: 'only-in-picker',
    }, pickerHost.host, scope);
    const afterLens = shellRealm.readTriageListWindowSnapshot(shellHost.host, scope);
    expect(afterLens).not.toBe(afterPaging);
    expect(afterLens).toBe(pickerRealm.readTriageListWindowSnapshot(pickerHost.host, scope));

    shellLease.release();
    expect(pickerRealm.readTriageListWindowSnapshot(pickerHost.host, scope)).toBe(afterLens);
    pickerLease.release();
    expect(pickerRealm.readTriageListWindowSnapshot(pickerHost.host, scope)).toMatchObject({
      freshness: 'unknown',
      configuredSources: [],
    });
  }, 60_000);

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
