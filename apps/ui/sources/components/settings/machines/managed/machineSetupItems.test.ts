import { describe, expect, it } from 'vitest';
import type { MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import {
  groupMachineSetupItems,
  machineSetupItemTitle,
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
  ({
    kind: 'app',
    authoredKey: name,
    definition: {
      name,
      project: { kind: 'create' },
      definition: { from: 'compose', compose: 'services: {}\n' },
      bindings: {},
    },
  }) as unknown as MachinePresetItemV1;
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

describe('machineSetupItemTitle', () => {
  const localize = (pluginId: string, value: unknown) => `${pluginId}:${String(value)}`;
  const recipes = {
    'happier.machine.recipes/google-chrome': {
      pluginId: 'happier.machine.recipes',
      definition: { id: 'google-chrome', revision: '1', title: 'Google Chrome' },
    },
  };

  it('names a recipe by its declared title from the app catalog, localized through its plugin', () => {
    expect(machineSetupItemTitle(recipe('softwareRecipe', 'google-chrome'), recipes, localize))
      .toBe('happier.machine.recipes:Google Chrome');
  });

  it('falls back to the recipe id when no declaration is held, and names an App by its Environment name', () => {
    expect(machineSetupItemTitle(recipe('setupRecipe', 'fonts'), recipes, localize)).toBe('fonts');
    expect(machineSetupItemTitle(recipe('softwareRecipe', 'google-chrome'), undefined, localize)).toBe('google-chrome');
    expect(machineSetupItemTitle(app('Analytics'), recipes, localize)).toBe('Analytics');
  });
});
