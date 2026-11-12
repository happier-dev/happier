// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiActionControlTestHost, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { administerTriageAction, readTriageActionsForSurface } from '../../actions/actionsCatalog.js';
import {
  TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
  TriageAdministerActionInputV1Schema,
} from '../../actions/actionsCatalogProtocol.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../../settings/actions.js';
import { createTestkitAccountKv } from '../../settings/testkit/accountKv.test-support.js';
import { TriageActionsEditor } from './ActionsEditor.js';
import { useTriageActions } from './useTriageActions.js';
import { useTriageLaunchProfiles } from './useLaunchProfiles.js';
import { useTriagePromptInvocations } from './usePromptInvocations.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
const hostControls = new WeakMap<PluginUiTestkit, ReturnType<typeof createPluginUiActionControlTestHost>>();
const pendingPresses = new Set<Promise<void>>();
const editorSurface = defineUiSurface(() => <TriageActionsEditor actions={useTriageActions()} />);

async function mountEditor() {
  const account = createTestkitAccountKv();
  const deps = { catalog: account.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'custom-action' };
  let release!: () => void;
  let settlement: 'apply' | 'fail' = 'apply';
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const controls = createPluginUiActionControlTestHost(async ({ input }) => {
    await pending;
    if (settlement === 'fail') return { ok: false, errorCode: 'unavailable', error: 'Account transport unavailable' };
    return { ok: true, result: await administerTriageAction(TriageAdministerActionInputV1Schema.parse(input), deps) };
  });
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-editor-continuity', mountNonce: 'fixture-editor-continuity' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: editorSurface,
      surfaceContext: createSurfaceContextFixture({}),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        actionControl: controls.handler,
        // Only the Action transport and Account KV boundaries are replaced;
        // the hook, command parser, catalog mutation and revision CAS stay real.
        executeAction: async ({ action, input }) => {
          const actionId = typeof action === 'string' ? action : action.localId;
          if (actionId === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1) {
            return await readTriageActionsForSurface({ v: 1 }, deps);
          }
          if (actionId === TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1) {
            throw new Error('Person writes must reach the host control, never raw executeAction');
          }
          throw new Error('Unrelated catalog is unavailable');
        },
      },
    });
  });
  mounted.push(fixture);
  hostControls.set(fixture, controls);
  await act(async () => { await Promise.resolve(); });
  return {
    fixture,
    account,
    async settle(outcome: 'apply' | 'fail' = 'apply') {
      settlement = outcome;
      await act(async () => { release(); await pending; await Promise.all(pendingPresses); });
    },
    async read() { return await readTriageActionsForSurface({ v: 1 }, deps); },
  };
}

async function press(fixture: PluginUiTestkit, name: string) {
  await act(async () => {
    const host = hostControls.get(fixture);
    if (name === 'Save' || name === 'Restore') {
      expect(host?.presentation(name), 'A person write requires a host-rendered control').toBeDefined();
      const pending = host!.press(name);
      pendingPresses.add(pending);
      void pending.finally(() => pendingPresses.delete(pending));
      await Promise.resolve();
      return;
    }
    const controls = await fixture.getAllByRole('button');
    // Item includes its description in the accessible name, while standalone
    // Save/Cancel controls carry only their label.
    const control = controls.find((candidate) => candidate.name === name)
      ?? controls.find((candidate) => candidate.name?.startsWith(name));
    expect(control, JSON.stringify(controls.map((candidate) => candidate.name))).toBeDefined();
    await fixture.press(control!);
  });
}

function nameField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
}

async function typeName(value: string) {
  const field = nameField();
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(nameField()?.value).toBe(value);
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await act(async () => { await fixture.dispose(); });
});

describe('action editor draft settlement', () => {
  it.each([false, true])('reacquires editor catalogs only under admitted requester custody and fences late old results (initially admitted: %s)', async (initiallyAdmitted) => {
    const calls: Array<Readonly<{ action: string; signal: AbortSignal | undefined }>> = [];
    const held: Array<() => void> = [];
    let current = false;
    const result = (action: string, label: string) => action === 'sessions.spawn.profiles.list'
      ? { coverage: 'complete', items: [{ id: 'profile', name: label }] }
      : { coverage: 'complete', items: [{ id: 'prompt', token: '/prompt', title: label, allowArgs: false }] };
    const surface = defineUiSurface(() => {
      const profiles = useTriageLaunchProfiles();
      const invocations = useTriagePromptInvocations();
      return <Text value={[...profiles.profiles.map(profile => profile.name),
        ...invocations.invocations.map(invocation => invocation.title)].join('|')} />;
    });
    const context = createSurfaceContextFixture({ requesterExecutionReady: initiallyAdmitted,
      machineConnectionPending: true, machineExecutionReady: false });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `catalog-custody-${initiallyAdmitted}`, mountNonce: `catalog-custody-${initiallyAdmitted}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface, surfaceContext: context,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { executeAction: async ({ action, signal }) => {
        const actionId = String(action);
        calls.push({ action: actionId, signal });
        if (current) return result(actionId, 'current');
        return await new Promise<ReturnType<typeof result>>(resolve => { held.push(() => resolve(result(actionId, 'old'))); });
      } },
    });
    mounted.push(fixture);
    try {
      if (!initiallyAdmitted) {
        expect(calls).toHaveLength(0);
        await act(async () => { await fixture.updateSurface({ ...context, requesterExecutionReady: true }); });
      }
      expect(calls).toHaveLength(2);
      await act(async () => { await fixture.updateSurface({ ...context, requesterExecutionReady: false }); });
      expect(calls).toHaveLength(2);
      current = true;
      await act(async () => { await fixture.updateSurface({ ...context, requesterExecutionReady: true }); });
      await expect(fixture.getByText('current|current')).resolves.toBeDefined();
      expect(calls).toHaveLength(4);
      expect(calls.slice(0, 2).every(call => call.signal?.aborted)).toBe(true);
      await act(async () => { for (const finish of held) finish(); });
      await expect(fixture.getByText('current|current')).resolves.toBeDefined();
      await expect(fixture.queryByText('old|old')).resolves.toBeUndefined();
    } finally { for (const finish of held) finish(); }
  });

  it('keeps newer update input and saves it against the acknowledged revision', async () => {
    const editor = await mountEditor();
    await press(editor.fixture, 'Ask');
    await typeName('Submitted name');
    await press(editor.fixture, 'Save');
    await typeName('Newer name');
    await editor.settle();

    expect(nameField()?.value).toBe('Newer name');
    expect((await editor.read()).actions.find((action) => action.actionId === 'ask')?.label).toBe('Submitted name');
    expect(hostControls.get(editor.fixture)?.presentation('Save')?.disabled).not.toBe(true);
    await press(editor.fixture, 'Save');
    expect((await editor.read()).actions.find((action) => action.actionId === 'ask')?.label).toBe('Newer name');
    expect(nameField()).toBeNull();
  });

  it('keeps newer create input until the person explicitly cancels it', async () => {
    const editor = await mountEditor();
    await press(editor.fixture, 'Add an action');
    await typeName('Submitted creation');
    await press(editor.fixture, 'Save');
    await typeName('Next creation');
    await editor.settle();

    expect(nameField()?.value).toBe('Next creation');
    expect((await editor.read()).actions.find((action) => action.actionId === 'custom-action')?.label).toBe('Submitted creation');
    await press(editor.fixture, 'Cancel');
    await press(editor.fixture, 'Add an action');
    expect(nameField()?.value).toBe('');
  });

  it('does not restore a cancelled pending draft or clear a reopened editor', async () => {
    const editor = await mountEditor();
    await press(editor.fixture, 'Ask');
    await typeName('Submitted name');
    await press(editor.fixture, 'Save');
    await press(editor.fixture, 'Cancel');
    expect(nameField()).toBeNull();
    await editor.settle();
    expect(nameField()).toBeNull();
    await press(editor.fixture, 'Submitted name');
    expect(nameField()?.value).toBe('Submitted name');
    await typeName('Reopened name');
    await press(editor.fixture, 'Cancel');
    await press(editor.fixture, 'Submitted name');
    expect(nameField()?.value).toBe('Submitted name');
  });

  it.each(['conflict', 'fail'] as const)('retains exact newer input after %s', async (outcome) => {
    const editor = await mountEditor();
    await press(editor.fixture, 'Ask');
    await typeName('Submitted name');
    await press(editor.fixture, 'Save');
    await typeName('  Newer unsaved name  ');
    if (outcome === 'conflict') {
      editor.account.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [] });
    }
    await editor.settle(outcome === 'fail' ? 'fail' : 'apply');

    expect(nameField()?.value).toBe('  Newer unsaved name  ');
    expect((await editor.read()).actions.find((action) => action.actionId === 'ask')?.label).toBe('Ask');
    expect(hostControls.get(editor.fixture)?.presentation('Save')?.disabled).toBe(true);
  });
});
