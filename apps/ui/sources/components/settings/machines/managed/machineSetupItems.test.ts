import { describe, expect, it } from 'vitest';
import { MachinePresetItemV1Schema, type MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import {
  addMachineSetupSoftware,
  addMachineSetupItem,
  containsMachineSetupItem,
  groupMachineSetupItems,
  machineSetupItemPresentation,
  moveMachineSetupItem,
  removeMachineSetupItem,
  renameMachineSetupApp,
} from './machineSetupItems';

const recipe = (
  kind: 'setupRecipe' | 'softwareRecipe',
  recipeId: string,
): MachinePresetItemV1 => ({
  kind,
  selection: {
    ref: { pluginId: 'happier.machine.recipes', recipeId, revision: '1' },
    inputs: {},
  },
});
const app = (name: string): MachinePresetItemV1 =>
  MachinePresetItemV1Schema.parse({
    kind: 'app',
    authoredKey: name,
    definition: {
      name,
      project: { kind: 'create' },
      definition: { from: 'compose', document: 'services: {}\n', profiles: [], services: [] },
      bindings: [],
    },
  });
const ids = (items: readonly MachinePresetItemV1[] | undefined) =>
  (items ?? []).map((item) =>
    item.kind === 'app' ? item.definition.name : item.selection.ref.recipeId,
  );

describe('one ordered preset item list', () => {
  // Stored order interleaves kinds; each group keeps its own relative order and its stored index.
  const items = [
    recipe('softwareRecipe', 'docker'),
    recipe('setupRecipe', 'ssh'),
    app('Status page'),
    recipe('softwareRecipe', 'node'),
    recipe('setupRecipe', 'firewall'),
    app('Analytics'),
  ];

  it('groups setup, software and apps in apply order while keeping stored indexes', () => {
    const groups = groupMachineSetupItems(items);
    expect(
      groups.map((group) => [group.kind, group.rows.map((row) => row.index)]),
    ).toEqual([
      ['setupRecipe', [1, 4]],
      ['softwareRecipe', [0, 3]],
      ['app', [2, 5]],
    ]);
  });

  it('moves an item past its neighbour of the same kind and leaves other kinds in place', () => {
    expect(ids(moveMachineSetupItem(items, 3, -1))).toEqual([
      'node',
      'ssh',
      'Status page',
      'docker',
      'firewall',
      'Analytics',
    ]);
    expect(ids(moveMachineSetupItem(items, 2, 1))).toEqual([
      'docker',
      'ssh',
      'Analytics',
      'node',
      'firewall',
      'Status page',
    ]);
  });

  it('returns the same list when there is no neighbour of that kind', () => {
    expect(moveMachineSetupItem(items, 1, -1)).toBe(items);
    expect(moveMachineSetupItem(items, 5, 1)).toBe(items);
  });

  it('removes one item and clears the list when the last one goes', () => {
    expect(ids(removeMachineSetupItem(items, 2))).toEqual([
      'docker',
      'ssh',
      'node',
      'firewall',
      'Analytics',
    ]);
    expect(removeMachineSetupItem([app('Only')], 0)).toBeUndefined();
  });

  it('renames an app item in place without touching its identity', () => {
    const next = renameMachineSetupApp(items, 5, '  Web analytics ');
    expect(ids(next)).toEqual([
      'docker',
      'ssh',
      'Status page',
      'node',
      'firewall',
      'Web analytics',
    ]);
    expect(next[5]).toMatchObject({ authoredKey: 'Analytics' });
    expect(renameMachineSetupApp(items, 5, '   ')).toBe(items);
    expect(renameMachineSetupApp(items, 0, 'x')).toBe(items);
  });
});

describe('machineSetupItemPresentation', () => {
  const chrome = { value: { pluginId: 'happier.machine.recipes', recipeId: 'google-chrome', revision: '1' },
    label: 'Google Chrome', description: 'Opens pages for agents.' };
  const node = { value: { kind: 'toolchain', adapterId: 'mise', tool: 'node' }, label: 'Node.js' };

  it('names a recipe from the offered option with the identical native value', () => {
    expect(machineSetupItemPresentation(recipe('softwareRecipe', 'google-chrome'), [node, chrome]))
      .toEqual({ title: 'Google Chrome', description: 'Opens pages for agents.', offered: true });
  });

  it("carries the offered option's declared icon as the item's mark, retired revisions included", () => {
    const declared = { ...chrome, icon: 'browser' };
    expect(machineSetupItemPresentation(recipe('softwareRecipe', 'google-chrome'), [declared]).icon).toBe('browser');
    const retired = { ...declared, value: { ...chrome.value, revision: '2' } };
    expect(machineSetupItemPresentation(recipe('softwareRecipe', 'google-chrome'), [retired]).icon).toBe('browser');
  });

  it('keeps a clear fallback: a retired revision keeps the title but says so, an unknown ref keeps its id', () => {
    const retired = { ...chrome, value: { ...chrome.value, revision: '2' } };
    expect(machineSetupItemPresentation(recipe('softwareRecipe', 'google-chrome'), [retired]))
      .toEqual({ title: 'Google Chrome', offered: false });
    expect(machineSetupItemPresentation(recipe('setupRecipe', 'fonts'), [chrome]))
      .toEqual({ title: 'fonts', offered: false });
    // Options not read yet (or unreadable) say nothing about availability.
    expect(machineSetupItemPresentation(recipe('softwareRecipe', 'google-chrome'), null))
      .toEqual({ title: 'google-chrome', offered: null });
    expect(machineSetupItemPresentation(app('Analytics'), [chrome])).toEqual({ title: 'Analytics', offered: null });
  });
});

describe('addMachineSetupSoftware', () => {
  const ref = { pluginId: 'happier.machine.recipes', recipeId: 'google-chrome', revision: '1' };

  it('appends the offered recipe as a Software item and keeps everything else', () => {
    const setup = { items: [app('Analytics')], scripts: [{ body: 'echo hi' }] };
    expect(addMachineSetupSoftware(setup, ref)).toEqual({ ok: true, setup: {
      items: [app('Analytics'), { kind: 'softwareRecipe', selection: { ref, inputs: {} } }], scripts: [{ body: 'echo hi' }] } });
    expect(addMachineSetupSoftware(undefined, ref)).toEqual({ ok: true, setup: {
      items: [{ kind: 'softwareRecipe', selection: { ref, inputs: {} } }] } });
  });

  it('refuses a recipe the preset already holds, at any revision', () => {
    const setup = { items: [recipe('softwareRecipe', 'google-chrome')] };
    expect(addMachineSetupSoftware(setup, ref)).toEqual({ ok: false, reason: 'contains' });
    expect(addMachineSetupSoftware(setup, { ...ref, revision: '9' })).toEqual({ ok: false, reason: 'contains' });
  });
});


describe('catalog Agent preset items', () => {
  const agent = { kind: 'agent' as const, agentId: 'acme.coding/reviewer' };

  it('keeps Agent rows in the ordered draft and identifies them separately from recipes', () => {
    const setup = { items: [recipe('softwareRecipe', 'node'), agent, app('Analytics')], scripts: [{ body: 'echo retained' }] };
    expect(groupMachineSetupItems(setup.items).map(group => [group.kind, group.rows.map(row => row.index)]))
      .toEqual([['softwareRecipe', [0]], ['agent', [1]], ['app', [2]]]);
    expect(containsMachineSetupItem(setup, agent)).toBe(true);
    expect(addMachineSetupItem(setup, agent)).toEqual({ ok: false, reason: 'contains' });
    expect(addMachineSetupItem({ scripts: setup.scripts }, agent)).toEqual({ ok: true,
      setup: { scripts: setup.scripts, items: [agent] } });
  });

  it('names a selected Agent from its catalog offer and retains its identity when the offer is absent', () => {
    const offer = { agentId: agent.agentId, title: 'Reviewer', description: 'Reviews code', icon: 'robot' };
    expect(machineSetupItemPresentation(agent, null, [offer])).toEqual({ title: 'Reviewer', description: 'Reviews code', icon: 'robot', offered: true });
    expect(machineSetupItemPresentation(agent, null, [])).toEqual({ title: agent.agentId, offered: false });
    expect(machineSetupItemPresentation(agent, null, null)).toEqual({ title: agent.agentId, offered: null });
  });
});
