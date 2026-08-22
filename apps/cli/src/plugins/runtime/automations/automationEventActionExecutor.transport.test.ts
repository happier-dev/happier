import { describe, expect, it, vi } from 'vitest';

import {
  AutomationEventAdmitInputV1Schema,
  AutomationSourceSelectorIdV1Schema,
  type AutomationEventAdmitPlainHostEvidenceV1,
  type PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';

import { createAutomationEventActionExecutor } from './automationEventActionExecutor';
import type { AutomationEventAdoptedDefinitionSetV1 } from './automationEventAdoptedDefinitionSet';

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};

const callerMaterialization: PluginMachineMaterializationRefV1 = {
  pluginId: 'com.acme.github',
  machineId: 'machine-caller',
  materializationId: 'materialization-caller',
};

describe('Automation Event E2 transport boundary', () => {
  it('normalizes a plain admission into one strict request before a custom transport receives it', async () => {
    const execute = vi.fn(async () => ({
      results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }],
      continuation: {
        kind: 'ready',
        accountCurrentness: { mode: 'plain', version: 11, contentKeyFingerprint: null },
      },
    }));
    const hostEvidence: AutomationEventAdmitPlainHostEvidenceV1 = {
      v: 1,
      t: 'plain',
      accountCurrentness: { mode: 'plain', version: 10, contentKeyFingerprint: null },
    };
    const adoptedSet: AutomationEventAdoptedDefinitionSetV1 = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({ kind: 'available', revision: '7', definitions: [] }),
      listPublicProjection: async () => ({ kind: 'unchanged', revision: '7' }),
      prepareAdmission: async (params) => (async function* () {
        yield {
          v: 1 as const,
          caller: params.caller,
          input: AutomationEventAdmitInputV1Schema.parse(params.input),
          hostEvidence,
        };
      })(),
    };
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: () => adoptedSet,
    });
    const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
      '9d5af559-2c82-4c22-b6a0-ecabce38a631',
    );
    const input = AutomationEventAdmitInputV1Schema.parse({
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      occurrenceId: 'delivery-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: [{
        automationId: 'automation-1',
        templateVersion: 3,
        sourceSelectorId,
      }],
    });

    await expect(executor({
      actionId: 'automation.event.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }],
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('automation.event.admit', {
      v: 1,
      caller: {
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
      input,
      hostEvidence,
    });
  });

  it('admits a repeated selector once and expands its outcome back to every original position', async () => {
    // The public input schema allows a provider to name the same definition
    // more than once in one admission. Grouping is the host's job: the
    // definition must be admitted exactly once and every original position
    // must receive that one outcome.
    const execute = vi.fn(async () => ({
      results: [
        { kind: 'admitted', runId: 'run-1', checkpointSafe: true },
        { kind: 'skipped', reason: 'filtered', checkpointSafe: true },
      ],
      continuation: {
        kind: 'ready',
        accountCurrentness: { mode: 'plain', version: 11, contentKeyFingerprint: null },
      },
    }));
    const hostEvidence: AutomationEventAdmitPlainHostEvidenceV1 = {
      v: 1,
      t: 'plain',
      accountCurrentness: { mode: 'plain', version: 10, contentKeyFingerprint: null },
    };
    const preparedInputs: unknown[] = [];
    const adoptedSet: AutomationEventAdoptedDefinitionSetV1 = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({ kind: 'available', revision: '7', definitions: [] }),
      listPublicProjection: async () => ({ kind: 'unchanged', revision: '7' }),
      prepareAdmission: async (params) => {
        preparedInputs.push(params.input);
        return (async function* () {
          yield {
            v: 1 as const,
            caller: params.caller,
            input: AutomationEventAdmitInputV1Schema.parse(params.input),
            hostEvidence,
          };
        })();
      },
    };
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: () => adoptedSet,
    });
    const repeated = {
      automationId: 'automation-1',
      templateVersion: 3,
      sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
        '9d5af559-2c82-4c22-b6a0-ecabce38a631',
      ),
    };
    const other = {
      automationId: 'automation-2',
      templateVersion: 1,
      sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
        '2f0b0f2e-16c9-4f4a-9a5c-3d0d1c2b4a67',
      ),
    };
    const input = AutomationEventAdmitInputV1Schema.parse({
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      occurrenceId: 'delivery-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: [repeated, other, repeated],
    });

    await expect(executor({
      actionId: 'automation.event.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      results: [
        { kind: 'admitted', runId: 'run-1', checkpointSafe: true },
        { kind: 'skipped', reason: 'filtered', checkpointSafe: true },
        { kind: 'admitted', runId: 'run-1', checkpointSafe: true },
      ],
    });

    expect(preparedInputs).toEqual([
      expect.objectContaining({ definitions: [repeated, other] }),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('automation.event.admit', expect.objectContaining({
      input: expect.objectContaining({ definitions: [repeated, other] }),
    }));
  });
});
