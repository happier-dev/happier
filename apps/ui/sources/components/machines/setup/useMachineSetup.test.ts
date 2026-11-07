import { describe, expect, it } from 'vitest';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

import { readMachineSetupRecipes } from './useMachineSetup';

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

  it('shows nothing until the setup has been read', () => {
    expect(
      readMachineSetupRecipes(null, {
        recipes: [{ ref: docker, status: 'satisfied' }],
      }),
    ).toHaveLength(0);
  });
});
