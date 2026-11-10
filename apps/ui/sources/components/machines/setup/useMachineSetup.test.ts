import { describe, expect, it } from 'vitest';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

import { readMachineSetupApps, readMachineSetupRecipes } from './useMachineSetup';

const docker = {
  pluginId: 'happier.machine-recipes',
  recipeId: 'docker',
  revision: '1',
};
const firewall = {
  pluginId: 'happier.machine-recipes',
  recipeId: 'firewall',
  revision: '2',
};
const item = (ref: typeof docker) => ({
  kind: 'setupRecipe' as const,
  selection: { ref, inputs: {} },
});

describe('readMachineSetupApps', () => {
  it('lists each app the sources hold, in source order, with where it came from', () => {
    const app = (name: string) => ({ kind: 'app' as const, definition: { name, project: { kind: 'create' as const } } });
    const rows = readMachineSetupApps([
      { kind: 'accountPreset', presetId: 'web', presetRevision: 3, setup: { items: [item(docker), app('Status page')] as never } },
      { kind: 'direct', setup: { items: [app('Analytics')] as never } },
    ]);
    expect(rows.map(row => [row.key, row.item.definition.name, row.sourceIndex])).toEqual([['0.1', 'Status page', 0], ['1.0', 'Analytics', 1]]);
  });
});

describe('readMachineSetupRecipes', () => {
  it('lists each recipe once, with its own name, the check’s state before the published one, and removal only for direct items', () => {
    const plan = MachineSetupPlanResultV1Schema.parse({
      desiredRevision: 4,
      exclusions: [],
      sources: [
        {
          kind: 'accountPreset',
          presetId: 'web',
          presetRevision: 3,
          setup: { items: [item(firewall), item(docker)] },
        },
        { kind: 'direct', setup: { items: [item(docker)] } },
      ],
      support: [{ sourceIndex: 0, itemIndex: 0, status: 'drifted' }],
      recipeTitles: [{ ref: docker, title: 'Docker' }],
    });
    const rows = readMachineSetupRecipes(plan, {
      recipes: [
        { ref: docker, status: 'satisfied' },
        { ref: firewall, status: 'satisfied' },
      ],
    });
    expect(
      rows.map((row) => [
        row.ref.recipeId,
        row.status,
        row.fromPreset,
        row.removable,
        row.title,
      ]),
    ).toEqual([
      ['firewall', 'drifted', true, false, null],
      ['docker', 'satisfied', true, false, 'Docker'],
    ]);
  });

  it('carries the selected missing fact with an unchecked recipe so its row can explain what is unavailable', () => {
    const plan = MachineSetupPlanResultV1Schema.parse({
      desiredRevision: 1, exclusions: [],
      sources: [{ kind: 'direct', setup: { items: [item(docker)] } }],
      support: [{ sourceIndex: 0, itemIndex: 0, status: 'unavailable', reason: 'required_fact_unavailable', requiredFact: 'packageManager' }],
    });
    expect(readMachineSetupRecipes(plan, null)).toMatchObject([
      { status: 'unavailable', reason: 'required_fact_unavailable', requiredFact: 'packageManager', removable: true },
    ]);
  });

  it('shows nothing until the setup has been read', () => {
    expect(
      readMachineSetupRecipes(null, {
        recipes: [{ ref: docker, status: 'satisfied' }],
      }),
    ).toHaveLength(0);
  });
});
