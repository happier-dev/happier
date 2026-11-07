// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue, PluginClientApi, PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiContextEnrichmentV1 } from '@happier-dev/plugin-sdk/ui';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { GITHUB_PLUGIN_ID } from '../../../observations/githubProviderContracts.js';
import { activate, GITHUB_CI_MOUNTED_ACTION_ID_V1 } from '../../../actions/mounted.js';
import { GITHUB_CI_ACTION_IDS_V1 } from '../../../actions/actionIds.js';
import { GithubActionsPage } from './ActionsPage.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const native = createForgeCiConformanceVectorsV1().github;
const repository = native.run.ref.repository;
const page = { rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null };
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { await act(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); }); });

/** Host scope and Action transport only; activation, mounted parser, reads, page and Form are real. */
async function mount(subPath: string, trigger: 'manual' | 'events' | 'unavailable' = 'manual', branch: string | null = 'main', selectedListed = true) {
  const entries = new Map<string, { value: unknown; dispose(): void }>();
  function acquire<T>(key: string, create: () => { value: T; dispose(): void }) {
    if (!entries.has(key)) entries.set(key, create());
    const entry = entries.get(key)!;
    return { value: entry.value as T, release() {}, retire() { if (entries.get(key) === entry) { entries.delete(key); entry.dispose(); } } };
  }
  const shared: PluginEphemeralSharedScope = { acquire, acquireExecutionBound: acquire };
  let handler: PluginClientActionHandler | undefined;
  const unused = () => { throw new Error('Unexpected registration'); };
  activate({ actions: { register: (_id, fn) => { handler = fn as unknown as PluginClientActionHandler; } },
    workItems: { register: unused }, dragSources: { register: unused }, dropTargets: { register: unused }, voiceProviders: { register: unused },
  } satisfies PluginClientApi);
  const calls: Array<{ id: string; input: JsonValue }> = [];
  let dispatched = false;
  let published: PluginUiContextEnrichmentV1 | null = null;
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'ci-form', mountNonce: 'ci-form' }, authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: defineUiSurface(context => <GithubActionsPage context={context} />), subPath,
      surfaceContext: createSurfaceContextFixture({ mountId: 'ci-form', target: { kind: 'project', projectKey: 'project', repository, ...(branch === null ? {} : { branch }) } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: shared, overlays: true }),
      handlers: { watchResource: async () => ({}), replacePageLocation: async ({ subPath: next }) => next,
        publishCurrentUiContext: async ({ enrichment }) => { published = enrichment; },
        executeAction: async ({ action, input, signal }): Promise<JsonValue> => {
          const id = typeof action === 'string' ? action : action.localId;
          if (id === GITHUB_CI_MOUNTED_ACTION_ID_V1) {
            const result = await handler!(input ?? null, { plugin: fixture.context.plugin,
              contribution: { id, qualifiedId: `${GITHUB_PLUGIN_ID}/${id}` }, invocationSurface: 'agent', signal,
              ui: { ...fixture.context.hostApi, context: async options => ({ targetedContributions: (await fixture.context.hostApi.context(options)).targetedContributions ?? null }) }, ephemeralSharedScope: shared });
            if (result === undefined) throw new Error('Missing mounted result');
            return result;
          }
          calls.push({ id, input: input ?? null });
          if (id === GITHUB_CI_ACTION_IDS_V1.readWorkflow) return { kind: 'value', value: { id: '42', name: 'CI', nativeState: 'active' } };
          if (id === GITHUB_CI_ACTION_IDS_V1.readTrigger) {
            if (trigger === 'unavailable') return { kind: 'unavailable', failure: { class: 'permission', code: 'definition_denied' } };
            const ref = typeof input === 'object' && input !== null && 'ref' in input ? String(input.ref) : '';
            const manual = ref !== 'events-only' && (trigger === 'manual' || ref === 'release/current');
            return { kind: 'value', value: { workflowId: '42', ref, revision: (ref === 'main' ? 'a' : 'b').repeat(40),
              dispatchable: manual, triggers: manual ? ['push', 'workflow_dispatch'] : ['push', 'pull_request'],
              inputs: manual ? [{ name: 'flag', type: 'boolean' }, { name: 'count', type: 'number' }, { name: 'target', type: 'environment', required: true }] : [] } };
          }
          if (id === GITHUB_CI_ACTION_IDS_V1.listEnvironments) {
            const next = typeof input === 'object' && input !== null && 'cursor' in input;
            return { kind: 'value', value: { ...page, rows: [{ id: next ? '2' : '1', name: next ? 'staging' : 'production' }], continuation: next ? null : 'next-env' } };
          }
          if (id === GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow) {
            dispatched = true;
            return { kind: 'confirmed', affected: { repository, workflowId: '42', ref: 'release/current', run: { ...native.run.ref, runId: '999' } }, receipt: { id: '999' } };
          }
          const rows = id === GITHUB_CI_ACTION_IDS_V1.listWorkflows
            ? [...(selectedListed ? [{ id: '42', name: 'CI', nativeState: 'active' }] : []), { id: '43', name: 'Nightly', nativeState: 'active' }]
            : id === GITHUB_CI_ACTION_IDS_V1.listRuns ? [
              ...(dispatched ? [{ ref: { ...native.run.ref, runId: '999' }, workflow: { id: '42' }, title: 'Manual dispatch', state: { phase: 'completed', outcome: 'success', outcomeBucket: 'passed', nativeLabel: 'success' } }] : []),
              { ...native.run, title: 'Broken build', state: { phase: 'completed', outcome: 'failure', outcomeBucket: 'failed', nativeLabel: 'failure' } },
              { ...native.run, ref: { ...native.run.ref, runId: '200' }, title: 'Good build', state: { phase: 'completed', outcome: 'success', outcomeBucket: 'passed', nativeLabel: 'success' } },
            ] : [];
          return { kind: 'value', value: { ...page, rows } };
        } },
    });
  });
  mounted.push(fixture);
  const control = (operation: unknown) => fixture.context.hostApi.executeAction(
    { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_CI_MOUNTED_ACTION_ID_V1 },
    // Unknown authored operands cross the actual host transport and the real registered schema.
    { mountId: 'ci-form', operation } as JsonValue);
  const command = async (title: string) => {
    const entry = published?.commands?.find(value => value.title === title);
    if (!entry || entry.command.kind !== 'executeAction') throw new Error(`Missing command: ${title}`);
    return fixture.context.hostApi.executeAction(entry.command.action, entry.command.input);
  };
  return { fixture, calls, control, command };
}

describe('Actions trigger and lens parity', () => {
  it('keeps an incomplete workflow editable and cancellable after its reads settle', async () => {
    const { fixture, calls } = await mount('workflows/42');
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Run workflow' })); });
    const count = await fixture.getByRole('textbox', { label: 'count' });
    expect(count.state?.disabled).not.toBe(true);
    expect((await fixture.getByRole('switch', { name: 'flag' })).state?.disabled).not.toBe(true);
    expect((await fixture.getByRole('button', { name: 'Run workflow' })).state?.disabled).toBe(true);
    expect((await fixture.getByRole('button', { name: 'Cancel' })).state?.disabled).not.toBe(true);
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Cancel' })); });
    expect(await fixture.queryByRole('textbox', { label: 'count' })).toBeUndefined();
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow)).toEqual([]);
  });

  it('loads a deep-linked workflow identity even when it is outside the loaded list window', async () => {
    const { fixture, calls } = await mount('workflows/42', 'manual', 'main', false);
    await fixture.getByRole('heading', { name: 'CI' });
    await fixture.getByRole('switch', { name: 'Status' });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.readWorkflow)).toHaveLength(1);
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.listWorkflows)).toHaveLength(1);
  });

  it.each(['events', 'unavailable'] as const)('never offers Run from active metadata when the selected definition is %s', async trigger => {
    const { fixture, calls } = await mount('workflows/42', trigger);
    await fixture.getByRole('switch', { name: 'Status' });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.readTrigger)).toHaveLength(1);
    expect(await fixture.queryByRole('button', { name: 'Run workflow' })).toBeUndefined();
    if (trigger === 'events') { await fixture.getByText('push, pull_request'); }
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.listEnvironments || call.id === GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow)).toEqual([]);
  });

  it('searches workflows through the same field as runs, so the toolbar keeps its shape across lenses', async () => {
    const { fixture, control } = await mount('workflows');
    await fixture.getByText('Nightly');
    await fixture.getByRole('textbox', { label: 'Filter workflows' });
    await fixture.getByText('CI');
    await act(async () => { await control({ kind: 'setQuery', query: 'night' }); });
    await fixture.getByText('Nightly');
    expect(await fixture.queryByText('CI')).toBeUndefined();
  });

  it.each(['runs', 'workflows'])('starts a run from the %s lens: Run workflow asks which workflow, then opens its real form', async lens => {
    const { fixture, calls } = await mount(lens);
    await fixture.getByText(lens === 'runs' ? 'Broken build' : 'Nightly');
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Run workflow' })); });
    // Asking which workflow reads no definition; only the chosen one does.
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.readTrigger)).toEqual([]);
    await act(async () => { await fixture.press(await vi.waitFor(() => fixture.getByRole('menuitem', { name: 'CI' }))); });
    await fixture.getByRole('textbox', { label: 'Use workflow from', value: 'main' });
    await fixture.getByRole('textbox', { label: 'count' });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow)).toEqual([]);
  });

  it('opens the page on the workflow and says why when the chosen workflow cannot be started by hand', async () => {
    const { fixture, calls } = await mount('runs', 'events');
    await fixture.getByText('Broken build');
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Run workflow' })); });
    await act(async () => { await fixture.press(await vi.waitFor(() => fixture.getByRole('menuitem', { name: 'CI' }))); });
    await fixture.getByText('push, pull_request');
    expect(await fixture.queryByRole('textbox', { label: 'count' })).toBeUndefined();
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow)).toEqual([]);
  });

  it('keeps definition and environment reads out of the unopened workflow list', async () => {
    const { fixture, calls } = await mount('workflows');
    await fixture.getByText('Nightly');
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.readTrigger || call.id === GITHUB_CI_ACTION_IDS_V1.listEnvironments)).toEqual([]);
  });

  it('keeps the workflow identity and edited form populated through repeated host location publications', async () => {
    const { fixture, calls, control } = await mount('workflows/42');
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Run workflow' })); });
    await fixture.getByRole('textbox', { label: 'count' });
    await act(async () => { await control({ kind: 'setTriggerDraft', values: { count: 0, flag: false, target: 'production' } }); });
    for (let n = 0; n < 3; n++) await act(async () => { await fixture.updatePageLocation('workflows/42'); });
    await fixture.getByRole('heading', { name: 'CI' });
    await fixture.getByRole('textbox', { label: 'count', value: '0' });
    await fixture.getByRole('button', { name: 'Cancel' });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.readTrigger)).toHaveLength(1);
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow)).toEqual([]);
  });

  it.each(['event-only', 'unknown'] as const)('can choose a dispatchable ref from an %s initial ref without opening a form', async initial => {
    const { fixture, calls, control } = await mount('workflows/42', 'events', initial === 'unknown' ? null : 'main');
    await fixture.getByRole('textbox', { label: 'Use workflow from', value: initial === 'unknown' ? '' : 'main' });
    expect(await fixture.queryByRole('button', { name: 'Run workflow' })).toBeUndefined();
    await act(async () => { expect(await control({ kind: 'setTriggerRef', ref: 'release/current' })).toEqual({ status: 'applied' }); });
    await fixture.getByRole('textbox', { label: 'Use workflow from', value: 'release/current' });
    await fixture.getByRole('button', { name: 'Run workflow' });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.listEnvironments || call.id === GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow)).toEqual([]);
  });

  it.each(['person', 'command'] as const)('opens, addresses and cancels the actual form, then dispatches its exact reviewed values once (%s environment continuation)', async continuation => {
    const { fixture, calls, control, command } = await mount('workflows/42');
    await fixture.getByRole('button', { name: 'Run workflow' });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.listEnvironments)).toEqual([]);
    expect(await control({ kind: 'setTriggerDraft', values: { flag: false } })).toEqual({ status: 'unavailable' });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Run workflow' })); });
    await fixture.getByRole('textbox', { label: 'Use workflow from', value: 'main' });
    await act(async () => { expect(await control({ kind: 'setTriggerRef', ref: 'release/current' })).toEqual({ status: 'applied' }); });
    await fixture.getByRole('textbox', { label: 'Use workflow from', value: 'release/current' });
    await act(async () => {
      if (continuation === 'command') await command('Load more environments');
      else await fixture.press(await fixture.getByRole('button', { name: 'Load more environments' }));
    });
    await act(async () => { expect(await control({ kind: 'setTriggerDraft', values: { flag: false, count: 0, target: 'staging' } })).toEqual({ status: 'applied' }); });
    expect((await fixture.getByRole('switch', { name: 'flag' })).state?.checked).toBe(false);
    await fixture.getByRole('textbox', { label: 'count', value: '0' });
    await act(async () => { await command('Cancel'); });
    expect(await fixture.queryByRole('textbox', { label: 'count' })).toBeUndefined();
    await fixture.getByRole('textbox', { label: 'Use workflow from', value: 'release/current' });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow)).toEqual([]);
    expect(await control({ kind: 'setTriggerDraft', values: { flag: true } })).toEqual({ status: 'unavailable' });
    await act(async () => { await command('Run workflow'); });
    await fixture.getByRole('textbox', { label: 'Use workflow from', value: 'release/current' });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Run workflow' })); });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow)).toEqual([
      { id: GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow, input: { repository, workflowId: '42', ref: 'release/current', inputs: { flag: false, count: 0, target: 'staging' } } },
    ]);
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.readTrigger)).toHaveLength(2);
    // The mounted workflow summary and Runs consume the same retained owner;
    // neither a navigation callback nor manual Refresh may repair the dispatch.
    await act(async () => { await control({ kind: 'selectView', view: 'workflows' }); });
    await fixture.getByText('Succeeded');
    await act(async () => { await control({ kind: 'selectView', view: 'runs' }); });
    await fixture.getByText('Manual dispatch');
    await act(async () => { await fixture.retire(); });
    await expect(control({ kind: 'setTriggerDraft', values: {} })).rejects.toMatchObject({ code: 'ui_host_unavailable' });
  });

  it('keeps visible Cancel available when the open form changes to an event-only ref', async () => {
    const { fixture, calls, control } = await mount('workflows/42');
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Run workflow' })); });
    await fixture.getByRole('textbox', { label: 'count' });
    await act(async () => { await control({ kind: 'setTriggerRef', ref: 'events-only' }); });
    await fixture.getByText('push, pull_request');
    expect(await fixture.queryByRole('button', { name: 'Run workflow' })).toBeUndefined();
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Cancel' })); });
    expect(await fixture.queryByRole('button', { name: 'Cancel' })).toBeUndefined();
    await fixture.getByRole('textbox', { label: 'Use workflow from', value: 'events-only' });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow)).toEqual([]);
  });

  it('addresses the visible loaded-row scope/query without changing provider filters or rereading', async () => {
    const { fixture, calls, control } = await mount('runs');
    await fixture.getByText('Broken build'); await fixture.getByText('Good build');
    const initialReads = calls.length;
    await act(async () => { expect(await control({ kind: 'setRunScope', scope: 'failed' })).toEqual({ status: 'applied' }); });
    expect((await fixture.getByRole('radio', { name: 'Failed' })).state?.checked).toBe(true);
    expect(await fixture.queryByText('Good build')).toBeUndefined();
    await act(async () => { await control({ kind: 'setQuery', query: 'no matching build' }); });
    await fixture.getByRole('textbox', { value: 'no matching build' });
    expect(await fixture.queryByText('Broken build')).toBeUndefined();
    await act(async () => { await control({ kind: 'setQuery', query: '' }); await control({ kind: 'setRunScope', scope: 'all' }); });
    await fixture.getByText('Broken build'); await fixture.getByText('Good build');
    expect(calls).toHaveLength(initialReads);
  });
});
