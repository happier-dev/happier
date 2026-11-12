// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TriagePullRequestOperationsV1Schema, TriageSourceOperationOutcomeV1Schema } from '@happier-dev/triage-protocol/v1';
import { Action, defineUiSurface } from '@happier-dev/plugin-ui';
import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiActionControlTestHost, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';

import { useTriagePullRequestPrimaryWriteV1 } from './pullRequestPrimaryWrite.js';
import type { TriageDetailPrimaryWriteV1 } from './evidenceDisclosure.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let mounted: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

const operations = TriagePullRequestOperationsV1Schema.parse({ readiness: 'blocked', unmetRequirements: [],
  primary: { id: 'merge', title: 'Merge', disabledReason: null,
    actionRef: { pluginId: 'example.source', localId: 'merge' }, variants: [
      { id: 'preserve', method: { title: 'Preserve commits' }, input: { revision: 'reviewed-head', method: 'merge' } },
      { id: 'combine', method: { title: 'Combine commits' }, input: { revision: 'reviewed-head', method: 'squash' } },
    ] }, alternatives: [{ id: 'dequeue', title: 'Leave queue', disabledReason: null,
      actionRef: { pluginId: 'example.source', localId: 'dequeue' }, variants: [{ id: 'only', input: { queueId: 'q-7' } }] }],
});

async function mount(input: Parameters<typeof useTriagePullRequestPrimaryWriteV1>[0], actionHost?: ReturnType<typeof createPluginUiActionControlTestHost>) {
  let write: TriageDetailPrimaryWriteV1 | null = null;
  let controller!: ReturnType<typeof useTriagePullRequestPrimaryWriteV1>;
  let rerender!: () => void;
  let publications = 0;
  function Probe() {
    const [, update] = React.useReducer(value => value + 1, 0);
    rerender = update;
    controller = useTriagePullRequestPrimaryWriteV1(input);
    write = controller.primaryWrite;
    React.useEffect(() => { publications += 1; }, [write]);
    return <>{write?.actionRef && write.controllerFor ? <Action.Control action={write.actionRef} title="Host merge"
      controller={write.controllerFor('combine')} signal={write.signal} /> : null}{write?.feedback}</>;
  }
  await act(async () => { mounted = await createPluginUiTestkit({
    identity: { instanceId: 'portable-primary-write', mountNonce: 'portable-primary-write-mount' },
    authorPlugin: { id: 'example.source', version: '0.0.0' },
    surface: defineUiSurface(() => <Probe />),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    ...(actionHost ? { handlers: { actionControl: actionHost.handler } } : {}),
  }); });
  return { read: () => { if (!write) throw new Error('Expected source write'); return write; },
    rerender: (next?: Parameters<typeof useTriagePullRequestPrimaryWriteV1>[0]) => act(async () => {
      if (next) input = next;
      rerender();
    }), publications: () => publications, controller: () => controller };
}

describe('portable source primary write', () => {
  it('prepares the reviewed PR choice for one host press and keeps the original settlement', async () => {
    const calls: unknown[] = [];
    const outcome = TriageSourceOperationOutcomeV1Schema.parse({ kind: 'applied', effect: 'changed',
      confirmedState: null, confirmedEntryRef: null,
      presentation: { title: 'Host merge confirmed', description: 'The source confirmed the change.', tone: 'secondary' } });
    const host = createPluginUiActionControlTestHost(async request => { calls.push(request); return { ok: true, result: { outcome } }; });
    const observed: unknown[] = [];
    await mount({ operations, signal: new AbortController().signal,
      execute: async () => { throw new Error('Raw plugin execution must not run for a press'); },
      onSettled: (execution, admitted) => { observed.push({ execution, admitted }); } }, host);
    await act(async () => { await host.press('Host merge'); });
    expect(calls).toEqual([{ action: operations.primary.actionRef, input: operations.primary.variants[1]?.input }]);
    expect(observed).toEqual([{ execution: { status: 'success', result: { outcome } }, admitted: outcome }]);
    expect(await mounted?.getByText('Host merge confirmed')).toBeDefined();
  });

  it('does not republish an unchanged mounted controller into its source header', async () => {
    const observations: string[] = [];
    const input = { operations, signal: new AbortController().signal,
      execute: async () => null, refresh: async () => true,
      onSettled: () => { observations.push('old'); } };
    const fixture = await mount(input);
    const initial = fixture.read();
    const before = fixture.publications();
    await fixture.rerender();
    await fixture.rerender({ ...input, onSettled: () => { observations.push('current'); } });
    await fixture.rerender();
    await act(async () => { await fixture.controller().refresh(); });
    expect(fixture.read()).toBe(initial);
    expect(fixture.publications()).toBe(before);
    await act(async () => { await fixture.read().execute('combine'); });
    expect(observations).toEqual(['current']);
  });

  it('reports the original host settlement and admitted source answer once without reclassifying observer errors', async () => {
    const outcome = TriageSourceOperationOutcomeV1Schema.parse({ kind: 'applied', effect: 'changed',
      confirmedState: null, confirmedEntryRef: null,
      presentation: { title: 'Source confirmed', description: 'The original change completed.', tone: 'secondary' } });
    const result = { outcome };
    const observed: unknown[] = [];
    let dispatches = 0;
    let held = false; let release!: (result: unknown) => void;
    const lifetime = new AbortController();
    const observerError = new Error('source observer failed after settlement');
    const fixture = await mount({ operations, signal: lifetime.signal,
      execute: async () => { dispatches += 1; return held ? new Promise(resolve => { release = resolve; }) : result; },
      onSettled: (execution: PluginActionExecution<unknown>, admitted: unknown, offer: unknown) => {
        observed.push({ execution, admitted, offer }); throw observerError;
      } });
    await act(async () => { await expect(fixture.read().execute('combine')).rejects.toBe(observerError); });
    expect(observed).toEqual([{ execution: { status: 'success', result }, admitted: outcome, offer: operations.primary }]);
    expect(dispatches).toBe(1);
    expect(fixture.read().disabledReason).toBeNull();
    expect(await mounted?.getByText(outcome.presentation.title)).toBeDefined();
    held = true;
    let pending!: Promise<void>;
    await act(async () => { pending = fixture.read().execute('combine'); });
    lifetime.abort();
    await act(async () => { release(result); await pending; });
    expect(observed).toHaveLength(1);
    expect(dispatches).toBe(2);
  });

  it('retires old choices without retiring feedback when the current offered choice changes', async () => {
    let dispatches = 0;
    const input = { operations, signal: new AbortController().signal,
      execute: async () => { dispatches += 1; return { outcome: TriageSourceOperationOutcomeV1Schema.parse({
        kind: 'applied', effect: 'changed', confirmedState: null, confirmedEntryRef: null,
        presentation: { title: 'Original change confirmed', description: 'Keep the observed outcome.', tone: 'secondary' },
      }) }; } };
    const fixture = await mount(input);
    const original = fixture.read();
    await act(async () => { await original.execute('combine'); });
    await fixture.rerender({ ...input, operations: TriagePullRequestOperationsV1Schema.parse(operations) });
    expect(await mounted?.getByText('Original change confirmed')).toBeDefined();
    expect(original.inputFor?.('combine')).toBeNull();
    await act(async () => { await original.execute('combine'); });
    expect(dispatches).toBe(1);
    await act(async () => { await fixture.read().execute('combine'); });
    expect(dispatches).toBe(2);
  });

  it('retains explicit original methods and pending state without promoting aggregate readiness to a gate', async () => {
    const calls: unknown[] = [];
    let release!: (result: unknown) => void;
    const held = new Promise(resolve => { release = resolve; });
    const fixture = await mount({ operations, signal: new AbortController().signal, execute: async (id, method) => {
      calls.push({ id, method }); return held;
    } });
    const write = fixture.read();
    expect(write.methods).toEqual([{ id: 'preserve', title: 'Preserve commits' }, { id: 'combine', title: 'Combine commits' }]);
    expect(write.actionRef).toBe(operations.primary.actionRef);
    expect(write.inputFor?.()).toBeNull();
    expect(write.inputFor?.('combine')).toBe(operations.primary.variants[1]?.input);
    expect(write.disabledReason).toBeNull();
    await act(async () => { await write.execute(); });
    expect(calls).toEqual([]);
    let pending!: Promise<void>;
    await act(async () => { pending = fixture.read().execute('combine'); });
    expect(fixture.read().pending).toBe(true);
    try {
      await act(async () => { void write.execute('combine'); });
      expect(calls).toEqual([{ id: 'merge', method: 'combine' }]);
    } finally { await act(async () => { release({ kind: 'refused' }); await pending; }); }
    expect(fixture.read().pending).toBe(false);
    expect(await mounted?.queryByText('Done')).toBeUndefined();
  });

  it('forwards a direct queue choice once and retires captured callbacks on cancellation', async () => {
    const signal = new AbortController(); const calls: unknown[] = [];
    const fixture = await mount({ operations, signal: signal.signal, execute: async (id, method) => {
      calls.push({ id, method }); return { kind: 'uncertain' };
    } });
    const queue = fixture.read().alternatives?.[0];
    expect(queue?.inputFor?.()).toBe(operations.alternatives[0]?.variants[0]?.input);
    await act(async () => { await queue?.execute(); });
    expect(calls).toEqual([{ id: 'dequeue', method: undefined }]);
    signal.abort();
    await act(async () => { await queue?.execute(); await fixture.read().execute('combine'); });
    expect(calls).toHaveLength(1);
  });

  it('presents the source answer rather than inferring success or parsing a native refusal code', async () => {
    const outcome = TriageSourceOperationOutcomeV1Schema.parse({ kind: 'refused', reason: 'source_specific_policy',
      unmetRequirements: [{ kind: 'check', id: 'native-build', label: 'Native build must pass' }],
      presentation: { title: 'Source declined this change', description: 'The source requires a renewed review.', tone: 'warning' } });
    const fixture = await mount({ operations, signal: new AbortController().signal,
      execute: async () => ({ kind: 'native-provider-refusal', outcome }) });
    await act(async () => { await fixture.read().execute('combine'); });
    expect(await mounted?.getByText(outcome.presentation.title)).toBeDefined();
    expect(await mounted?.getByText(outcome.presentation.description)).toBeDefined();
    expect(await mounted?.getByText('Native build must pass')).toBeDefined();
    expect(fixture.read().disabledReason).toBeNull();
  });

  it('does not replay an uncertain alternative and clears it only after an explicit successful re-read', async () => {
    let reads = 0; let dispatches = 0; let refreshed = false;
    const outcome = TriageSourceOperationOutcomeV1Schema.parse({ kind: 'uncertain', failure: null,
      presentation: { title: 'Queue change unconfirmed', description: 'The source could not confirm queue membership.', tone: 'warning' } });
    const fixture = await mount({ operations, signal: new AbortController().signal,
      execute: async () => { dispatches += 1; return { kind: 'uncertain', outcome }; },
      refresh: async () => { reads += 1; return refreshed; } });
    const oldChoice = fixture.read().alternatives?.[0];
    await act(async () => { await oldChoice?.execute(); });
    expect(await mounted?.getByText(outcome.presentation.title)).toBeDefined();
    expect(fixture.read().alternatives?.[0]?.disabledReason).not.toBeNull();
    expect(oldChoice?.inputFor?.()).toBeNull();
    await act(async () => { await oldChoice?.execute(); });
    expect(dispatches).toBe(1); expect(reads).toBe(0);
    await act(async () => { await mounted?.press(await mounted.getByRole('button', { name: 'Re-read' })); });
    expect(reads).toBe(1); expect(fixture.read().alternatives?.[0]?.disabledReason).not.toBeNull();
    refreshed = true;
    await act(async () => { await mounted?.press(await mounted.getByRole('button', { name: 'Re-read' })); });
    expect(reads).toBe(2); expect(dispatches).toBe(1);
    expect(fixture.read().alternatives?.[0]?.disabledReason).toBeNull();
    expect(oldChoice?.inputFor?.()).toBeNull();
    await act(async () => { await oldChoice?.execute(); });
    expect(dispatches).toBe(1);
  });

  it('reuses host transport settlement without turning declined confirmation into an unknown native write', async () => {
    let declined = true;
    const fixture = await mount({ operations, signal: new AbortController().signal, execute: async () => {
      if (declined) throw { code: 'denied', diagnostics: ['plugin_action_current_intent_rejected'] };
      throw { code: 'timeout' };
    } });
    await act(async () => { await fixture.read().execute('combine'); });
    expect(fixture.read().feedback).toBeUndefined();
    expect(fixture.read().disabledReason).toBeNull();
    declined = false;
    await act(async () => { await fixture.read().execute('combine'); });
    expect(await mounted?.getByText('Outcome unknown')).toBeDefined();
    expect(fixture.read().disabledReason).not.toBeNull();
  });

  it('uses separate explicit read costs, including absent offers, without clearing a later uncertain write', async () => {
    let release!: (current: boolean) => void;
    let ordinaryReads = 0; let requirementsReads = 0; let dispatches = 0;
    const outcome = TriageSourceOperationOutcomeV1Schema.parse({ kind: 'uncertain', failure: null,
      presentation: { title: 'Source could not confirm', description: 'Re-read the current state.', tone: 'warning' } });
    const input = { signal: new AbortController().signal,
      execute: async () => { dispatches += 1; return { kind: 'uncertain', outcome }; },
      refresh: async () => { ordinaryReads += 1; return true; },
      readRequirements: async () => { requirementsReads += 1; return new Promise<boolean>(resolve => { release = resolve; }); } };
    const fixture = await mount({ ...input, operations: undefined });
    await act(async () => { await fixture.controller().refresh(); });
    expect(ordinaryReads).toBe(1); expect(requirementsReads).toBe(0);
    await fixture.rerender({ ...input, operations });
    await act(async () => { await fixture.read().execute('combine'); });
    let refreshing!: Promise<void>;
    await act(async () => { refreshing = fixture.read().readRequirements!(); });
    await act(async () => { await fixture.read().alternatives?.[0]?.execute(); });
    await act(async () => { release(true); await refreshing; });
    expect(fixture.read().disabledReason).toBeNull();
    expect(fixture.read().alternatives?.[0]?.disabledReason).not.toBeNull();
    expect(await mounted?.getByText(outcome.presentation.title)).toBeDefined();
    expect(ordinaryReads).toBe(1); expect(requirementsReads).toBe(1); expect(dispatches).toBe(2);
    await act(async () => { await fixture.controller().refresh(); });
    expect(ordinaryReads).toBe(2); expect(requirementsReads).toBe(1); expect(dispatches).toBe(2);
    expect(fixture.read().alternatives?.[0]?.disabledReason).toBeNull();
  });

  it('keeps explicit recovery reachable when another original Action settles afterwards', async () => {
    let reads = 0;
    const fixture = await mount({ operations, signal: new AbortController().signal,
      execute: async id => ({ outcome: TriageSourceOperationOutcomeV1Schema.parse(id === 'merge'
        ? { kind: 'uncertain', failure: null, presentation: { title: 'Merge unconfirmed',
          description: 'Re-read before trying again.', tone: 'warning' } }
        : { kind: 'applied', effect: 'changed', confirmedState: null, confirmedEntryRef: null,
          presentation: { title: 'Queue left', description: 'The source confirmed the queue change.', tone: 'secondary' } }) }),
      refresh: async () => { reads += 1; return true; } });
    await act(async () => { await fixture.read().execute('combine'); });
    await act(async () => { await fixture.read().alternatives?.[0]?.execute(); });
    expect(await mounted?.getByText('Queue left')).toBeDefined();
    expect(fixture.read().disabledReason).not.toBeNull();
    await act(async () => { await mounted?.press(await mounted.getByRole('button', { name: 'Re-read' })); });
    expect(reads).toBe(1);
    expect(fixture.read().disabledReason).toBeNull();
  });
});
