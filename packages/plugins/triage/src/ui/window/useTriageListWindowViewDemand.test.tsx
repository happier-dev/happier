// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTriageListWindowViewDemand } from './useTriageListWindowViewDemand.js';
import type { PluginUiHostReadiness } from '@happier-dev/plugin-ui';
import type { TriageListEntriesResultV1 } from '../../actions/listEntriesProtocol.js';
import type { TriageRefreshTriggerV1 } from '../../refresh/refreshEligibility.js';
import { acquireTriageListWindow, readTriageListWindowReadOwner, refreshTriageListWindow,
  type TriageListWindowHostV1 } from './mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from './ephemeralSharedScope.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

type Props = Readonly<{
  active: boolean;
  demand: (trigger: TriageRefreshTriggerV1) => Promise<void>;
  readiness?: PluginUiHostReadiness;
  readOwner?: object | null;
}>;

function render(initial: Props): Readonly<{
  update(next: Props): Promise<void>;
}> {
  const initialOwner = {};
  function Probe(props: Props): null {
    useTriageListWindowViewDemand(props.active, props.demand, props.readiness,
      props.readOwner === undefined ? initialOwner : props.readOwner);
    return null;
  }

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => { root?.render(<Probe {...initial} />); });

  return Object.freeze({
    async update(next) {
      await act(async () => { root?.render(<Probe {...next} />); });
    },
  });
}

describe('the mounted Triage list view-demand producer', () => {

  it('defers demand while requester admission is false and reacquires once after admission', async () => {
    const demand = vi.fn(async () => {});
    const readiness = { pending: false, ready: false, revision: 0 };
    const harness = render({ active: true, demand, readiness });
    expect(demand).not.toHaveBeenCalled();
    await harness.update({ active: true, demand, readiness: { ...readiness, ready: true, revision: 1 } });
    expect(demand).toHaveBeenCalledTimes(1);
    await harness.update({ active: true, demand, readiness });
    expect(demand).toHaveBeenCalledTimes(1);
  });

  it('does not demand while first mounted or retained inactive, including callback replacement', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const harness = render({ active: false, demand: first });

    expect(first).not.toHaveBeenCalled();

    await harness.update({ active: false, demand: second });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    await harness.update({ active: true, demand: second });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('emits one mount demand plus each later host-active regain, leaving burst coalescing to the existing window owner', async () => {
    const demand = vi.fn(async () => {});
    const harness = render({ active: true, demand });

    expect(demand).toHaveBeenCalledTimes(1);

    // The host supplies this one public active fact. Each regain is a named
    // producer, but this adapter owns no timer, scheduler or provider call:
    // its three `view` demands are coalesced by the mounted window's existing
    // owner.
    await harness.update({ active: false, demand });
    await harness.update({ active: true, demand });
    await harness.update({ active: false, demand });
    await harness.update({ active: true, demand });

    expect(demand).toHaveBeenCalledTimes(3);
  });

  it('starts a fresh mounted window even when the host is already active', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const harness = render({ active: true, demand: first, readOwner: {} });

    await harness.update({ active: true, demand: second, readOwner: {} });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does not relist a shared window when only its host facade or equal readiness wrapper changes', async () => {
    const readOwner = {};
    const first = vi.fn(async () => {});
    const replacement = vi.fn(async () => {});
    const readiness = { pending: false, ready: true, revision: 0 };
    const harness = render({ active: true, demand: first, readOwner, readiness });
    for (let arrival = 0; arrival < 20; arrival++) {
      await harness.update({ active: true, demand: replacement, readOwner, readiness: { ...readiness } });
    }
    expect(first).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(0);
    await harness.update({ active: true, demand: replacement, readOwner,
      readiness: { ...readiness, revision: 1 } });
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('uses the acquired shared owner across an unacquired Host facade (same scope: %s)', async (sameScope) => {
    const firstScope = createTriageEphemeralSharedScopeFixture();
    const nextScope = sameScope ? firstScope : createTriageEphemeralSharedScopeFixture();
    const readiness = Object.freeze({ pending: false, ready: true, revision: 0 });
    const result: TriageListEntriesResultV1 = {
      v: 1, configuredSources: [], configuredSourcesStatus: 'complete',
      window: { v: 1, rows: [], lanes: [], coverage: 'complete', assembledAtMs: 1 },
    };
    // Host Action transport and time are the only replaced system boundaries.
    const firstRequests: string[] = [];
    const nextRequests: string[] = [];
    const firstHost: TriageListWindowHostV1 = {
      async executeAction(action) { firstRequests.push(action); return result; },
    };
    const nextHost: TriageListWindowHostV1 = {
      async executeAction(action) { nextRequests.push(action); return result; },
    };
    let nowMs = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const firstLease = acquireTriageListWindow(firstHost, firstScope, readiness);
    let nextLease: ReturnType<typeof acquireTriageListWindow> | undefined;
    let firstRead = Promise.resolve();
    let nextRead = Promise.resolve();
    const firstDemand = (trigger: TriageRefreshTriggerV1) => firstRead = refreshTriageListWindow(trigger, firstHost, firstScope);
    const nextDemand = (trigger: TriageRefreshTriggerV1) => nextRead = refreshTriageListWindow(trigger, nextHost, nextScope);
    try {
      const firstOwner = readTriageListWindowReadOwner(firstHost, firstScope);
      const harness = render({ active: true, demand: firstDemand, readiness, readOwner: firstOwner });
      await firstRead;
      expect(firstRequests).toHaveLength(1);
      firstLease.release();
      // The new facade has no subscription yet, as during a real Host API
      // replacement. Absence is not a new shared-window authority.
      const unacquired = readTriageListWindowReadOwner(nextHost, nextScope);
      expect(unacquired).toBeNull();
      await harness.update({ active: true, demand: nextDemand, readiness, readOwner: unacquired });
      expect(nextRequests).toHaveLength(0);
      nextLease = acquireTriageListWindow(nextHost, nextScope, readiness);
      const acquired = readTriageListWindowReadOwner(nextHost, nextScope);
      expect(acquired === firstOwner).toBe(sameScope);
      // Passing time alone is not a named materialization producer.
      nowMs += 1;
      await harness.update({ active: true, demand: nextDemand, readiness, readOwner: acquired });
      await nextRead;
      expect(nextRequests).toHaveLength(sameScope ? 0 : 1);
    } finally {
      nextLease?.release();
      firstLease.release();
      clock.mockRestore();
    }
  });
});
