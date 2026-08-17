import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TriageListEntriesResultV1 } from '../../actions/listEntriesProtocol.js';
import {
  acquireTriageListWindow,
  readTriageListWindowSnapshot,
  refreshTriageListWindow,
  type TriageListWindowHostV1,
  type TriageListWindowLeaseV1,
} from './mountedWindow.js';

/**
 * The scope of the mounted PRs & Issues window.
 *
 * The window is assembled by invoking this plugin's own list Action through a
 * mounted surface's Host API object. That object is not an anonymous transport:
 * the host builds exactly one per mount and rebuilds it when the mount's
 * Account lifetime changes, so its identity is the host's own opaque
 * mount-and-Account scope stamp. Nothing here needs — or is given — an Account
 * id to tell two scopes apart.
 *
 * Two surfaces therefore share a window only when they were handed the same
 * Host API object. The tests below hold the two directions of that rule: the
 * one that would leak an Account's rows into another Account's surface, and the
 * one that would let a retired surface's in-flight pass publish into the window
 * a live surface is reading.
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
function createHostStub(sourceInstanceId: string) {
  const calls: string[] = [];
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  const result: TriageListEntriesResultV1 = {
    v: 1,
    configuredSources: [{ sourceInstanceId, source: SOURCE, available: false }],
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
        exhausted: false,
      }],
      coverage: 'partial',
      assembledAtMs: 1,
    },
  };
  const host: TriageListWindowHostV1 = Object.freeze({
    async executeAction(
      action: string,
      _input: JsonValue,
      _options?: PluginCancellationOptions,
    ): Promise<unknown> {
      calls.push(action);
      if (gate) await gate;
      return result as unknown as JsonValue;
    },
  });
  return {
    host,
    calls,
    /** Hold this stub's next passes open so a retirement can overtake them. */
    hold(): void {
      gate = new Promise<void>((resolve) => { openGate = resolve; });
    },
    release(): void {
      openGate?.();
      gate = null;
      openGate = null;
    },
  };
}

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

function configuredInstanceIds(host: TriageListWindowHostV1): readonly string[] {
  return readTriageListWindowSnapshot(host).configuredSources.map(
    (summary) => summary.sourceInstanceId,
  );
}

const leases: TriageListWindowLeaseV1[] = [];

function acquire(host: TriageListWindowHostV1): TriageListWindowLeaseV1 {
  const lease = acquireTriageListWindow(host);
  leases.push(lease);
  return lease;
}

afterEach(() => {
  while (leases.length > 0) leases.pop()?.release();
});

describe('the mounted PRs & Issues window is scoped to its host', () => {
  it('does not let a second Account join the first Account window', async () => {
    const accountA = createHostStub(INSTANCE_A);
    const accountB = createHostStub(INSTANCE_B);

    acquire(accountA.host);
    await refreshTriageListWindow('view', accountA.host);
    expect(configuredInstanceIds(accountA.host)).toEqual([INSTANCE_A]);

    acquire(accountB.host);
    await refreshTriageListWindow('view', accountB.host);

    // The second surface reached its own host, not the first acquisition's.
    expect(accountB.calls.length).toBeGreaterThan(0);
    expect(configuredInstanceIds(accountB.host)).toEqual([INSTANCE_B]);
    // ...and neither window observed the other's configured sources.
    expect(configuredInstanceIds(accountA.host)).toEqual([INSTANCE_A]);
  });

  it('keeps a retired surface late pass out of the window a live surface reads', async () => {
    const accountA = createHostStub(INSTANCE_A);
    const accountB = createHostStub(INSTANCE_B);

    accountA.hold();
    const retiring = acquire(accountA.host);
    const latePass = refreshTriageListWindow('view', accountA.host);

    acquire(accountB.host);
    retiring.release();

    await settles(refreshTriageListWindow('view', accountB.host));
    expect(configuredInstanceIds(accountB.host)).toEqual([INSTANCE_B]);

    accountA.release();
    await latePass;
    await Promise.resolve();

    expect(configuredInstanceIds(accountB.host)).toEqual([INSTANCE_B]);
    // The retired surface's own window is gone rather than left readable.
    expect(readTriageListWindowSnapshot(accountA.host).configuredSources).toEqual([]);
  });

  it('is realm-local, so two artifact bundles cannot share one window', async () => {
    // The shell page and the Composer picker are separate UI artifacts, and the
    // host's module registry keys a loaded module by contribution — so each is
    // its own module realm with its own copy of this module. A window parked on
    // a cross-realm global would defeat the host-stamped scope above, because a
    // global outlives the Account lifetime the Host API object tracks.
    vi.resetModules();
    const shellRealm = await import('./mountedWindow.js');
    vi.resetModules();
    const pickerRealm = await import('./mountedWindow.js');
    expect(shellRealm.acquireTriageListWindow).not.toBe(pickerRealm.acquireTriageListWindow);

    const shellHost = createHostStub(INSTANCE_A);
    const lease = shellRealm.acquireTriageListWindow(shellHost.host);
    await shellRealm.refreshTriageListWindow('view', shellHost.host);
    expect(shellRealm.readTriageListWindowSnapshot(shellHost.host).freshness).toBe('fresh');

    expect(pickerRealm.readTriageListWindowSnapshot(shellHost.host)).toMatchObject({
      freshness: 'unknown',
      configuredSources: [],
    });
    lease.release();
  });
});
