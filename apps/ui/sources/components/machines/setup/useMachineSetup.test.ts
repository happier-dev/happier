import { describe, expect, it } from 'vitest';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachinePresetItemV1Schema } from '@happier-dev/protocol/machines/managed/machineSetupV1';

import {
  readMachineSetupApps,
  readMachineSetupRecipes,
  readOpenedMachineSetupSources,
} from './useMachineSetup';

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
    const app = (name: string) => MachinePresetItemV1Schema.parse({ kind: 'app', definition: {
      name, project: { kind: 'create' },
      definition: { from: 'compose', document: 'services: {}', profiles: [], services: [] }, bindings: [],
    } });
    const rows = readMachineSetupApps([
      { sourceIndex: 0, source: { kind: 'accountPreset', presetId: 'web', presetRevision: 3, setup: { items: [item(docker), app('Status page')] as never } } },
      { sourceIndex: 1, source: { kind: 'direct', setup: { items: [app('Analytics')] as never } } },
    ]);
    expect(rows.map(row => [row.key, row.item.definition.name, row.sourceIndex])).toEqual([['0.1', 'Status page', 0], ['1.0', 'Analytics', 1]]);
  });
});

describe('readOpenedMachineSetupSources', () => {
  it('keeps an unavailable opaque attachment out of private presentation while retaining later opened source indexes', () => {
    const opened = readOpenedMachineSetupSources([
      {
        kind: 'unavailable',
        source: {
          kind: 'accountPresetOpaque',
          presetId: 'team-only',
          presetRevision: 4,
          contentEncryptionMode: 'e2ee',
        },
      },
      {
        kind: 'opened',
        presetName: 'Exact retained name',
        source: {
          kind: 'direct',
          setup: { items: [item(docker)] },
        },
      },
    ]);

    expect(opened).toMatchObject([
      { sourceIndex: 1, source: { kind: 'direct' } },
    ]);
    expect(readMachineSetupApps(opened)).toEqual([]);
  });
});

describe('readMachineSetupRecipes', () => {
  it('lists each recipe once, with its own name, the check’s state before the published one, and removal only for direct items', () => {
    const plan = MachineSetupPlanResultV1Schema.parse({
      desiredRevision: 4,
      exclusions: [],
      sources: [
        { kind: 'accountPresetOpaque', presetId: 'web', presetRevision: 3, contentEncryptionMode: 'plain' },
        { kind: 'direct', setup: { items: [item(docker)] } },
      ],
      support: [{ sourceIndex: 0, itemIndex: 0, status: 'drifted' }],
      recipeTitles: [{ ref: docker, title: 'Docker' }],
    });
    const rows = readMachineSetupRecipes(plan, [
      { sourceIndex: 0, source: {
        kind: 'accountPreset', presetId: 'web', presetRevision: 3,
        setup: { items: [item(firewall), item(docker)] },
      }, presetName: 'Historical web' },
      { sourceIndex: 1, source: { kind: 'direct', setup: { items: [item(docker)] } } },
    ], {
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
        row.presetName,
      ]),
    ).toEqual([
      ['firewall', 'drifted', true, false, null, 'Historical web'],
      ['docker', 'satisfied', true, false, 'Docker', 'Historical web'],
    ]);
  });

  it('carries the selected missing fact with an unchecked recipe so its row can explain what is unavailable', () => {
    const plan = MachineSetupPlanResultV1Schema.parse({
      desiredRevision: 1, exclusions: [],
      sources: [{ kind: 'direct', setup: { items: [item(docker)] } }],
      support: [{ sourceIndex: 0, itemIndex: 0, status: 'unavailable', reason: 'required_fact_unavailable', requiredFact: 'packageManager' }],
    });
    expect(readMachineSetupRecipes(plan, [{ sourceIndex: 0, source: {
      kind: 'direct', setup: { items: [item(docker)] },
    } }], null)).toMatchObject([
      { status: 'unavailable', reason: 'required_fact_unavailable', requiredFact: 'packageManager', removable: true },
    ]);
  });

  it('projects the retained direct recipe from Plan and drops it after removal even with stale native inventory', () => {
    const curl = { kind: 'setupRecipe' as const, selection: {
      ref: { pluginId: 'happier.machine.recipes', recipeId: 'install-package', revision: '1' },
      inputs: { package: { manager: 'apt', apt: { name: 'curl' } } },
    } };
    const plan = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 1, exclusions: [],
      sources: [{ kind: 'direct', setup: { items: [curl] } }],
      support: [{ sourceIndex: 0, itemIndex: 0, status: 'satisfied' }],
    });
    expect(readMachineSetupRecipes(plan, [{ sourceIndex: 0, source: { kind: 'direct', setup: { items: [curl] } } }], null)).toMatchObject([
      { item: curl, sourceIndex: 0, removable: true, status: 'satisfied' },
    ]);
    expect(readMachineSetupRecipes({ ...plan, desiredRevision: 2,
      sources: [{ kind: 'direct', setup: {} }], support: [] }, [], {
        recipes: [{ ref: curl.selection.ref, status: 'satisfied' }],
      })).toEqual([]);
  });

  it('shows nothing until the setup has been read', () => {
    expect(
      readMachineSetupRecipes(null, [], {
        recipes: [{ ref: docker, status: 'satisfied' }],
      }),
    ).toHaveLength(0);
  });
});
