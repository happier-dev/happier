import { describe, expect, it } from 'vitest';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

import { readMachineSetupRunRecovery } from './machineSetupRunRecovery';

const ripgrep = {
  pluginId: 'happier.machine.recipes',
  recipeId: 'install-package',
  revision: '1',
};
const node = {
  pluginId: 'happier.machine.recipes',
  recipeId: 'node',
  revision: '1',
};

function failedRun(source?: unknown) {
  return ActionOperationSnapshotV1Schema.parse({
    version: 1,
    operationId: 'run',
    revision: 2,
    actionId: 'machines.setup.apply',
    state: 'failed',
    scope: { accountId: 'account', machineId: 'devbox' },
    title: 'Apply machine setup',
    createdAt: 1,
    startedAt: 2,
    settledAt: 3,
    cancellation: 'unsupported',
    error: { errorCode: 'native_step_failed', error: 'Native step failed' },
    domainRef: {
      kind: 'machineSetup',
      serverId: 'srv',
      machineId: 'devbox',
      ...(source ? { source } : {}),
    },
  });
}

const current = MachineSetupPlanResultV1Schema.parse({
  desiredRevision: 4,
  exclusions: [],
  support: [],
  sources: [
    {
      kind: 'direct',
      setup: {
        items: [
          { kind: 'softwareRecipe', selection: { ref: node, inputs: {} } },
        ],
      },
    },
  ],
});

describe('a stopped Setup run offers its own proposal again', () => {
  it('retries the captured proposal and edits the one recipe it added, with its inputs', () => {
    const added = {
      kind: 'softwareRecipe',
      selection: { ref: ripgrep, inputs: { packages: ['ripgrep', 'fd-find'] } },
    };
    const sources = [
      {
        kind: 'direct',
        setup: {
          items: [
            { kind: 'softwareRecipe', selection: { ref: node, inputs: {} } },
            added,
          ],
        },
      },
    ];
    expect(
      readMachineSetupRunRecovery(
        failedRun({ sources, removeItemKeys: ['old'] }),
        current,
      ),
    ).toEqual({
      retry: { kind: 'sources', sources, removeItemKeys: ['old'] },
      edit: { ref: ripgrep, inputs: { packages: ['ripgrep', 'fd-find'] } },
    });
  });

  it("keeps re-planning the Machine's own setup for a run that captured no proposal", () => {
    expect(readMachineSetupRunRecovery(failedRun(), current)).toEqual({
      retry: { kind: 'reapply' },
      edit: null,
    });
  });

  it('replans only the addressed preset when its stopped run has unrelated attached sources', () => {
    const candidatePreset = { presetId: 'build', presetRevision: 2 };
    const sources = [
      { kind: 'accountPresetOpaque', ...candidatePreset, setupRevision: 5, contentEncryptionMode: 'plain' },
      { kind: 'accountPresetOpaque', presetId: 'retained', presetRevision: 1, contentEncryptionMode: 'plain' },
      ...current.sources,
    ];
    expect(readMachineSetupRunRecovery(failedRun({ sources, candidatePreset }), current)).toEqual({
      retry: { kind: 'sources', sources, candidatePreset },
      edit: null,
    });
  });

  it('offers no Edit when the proposal adds no single software recipe (a preset re-apply)', () => {
    const sources = [
      {
        kind: 'accountPresetOpaque',
        presetId: 'build',
        presetRevision: 2,
        contentEncryptionMode: 'plain',
      },
      ...current.sources,
    ];
    expect(
      readMachineSetupRunRecovery(failedRun({ sources }), current),
    ).toMatchObject({ retry: { kind: 'sources' }, edit: null });
  });
});
