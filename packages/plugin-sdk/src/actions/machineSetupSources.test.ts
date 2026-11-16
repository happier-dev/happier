import { describe, expect, it } from 'vitest';
import { buildMachineSetupTargetApplyInput, machineSetupApplyTargetFromPlanV1, waitForMachineSetupOperationV1 } from './index.public.js';
import type { PluginActionResultById } from './actionTypeMap.generated.js';

describe('public Machine setup Plan to Apply', () => {
  it('preserves the admitted preset reference and omits presentation-only Plan facts', () => {
    const source = { kind: 'accountPresetOpaque' as const, presetId: 'preset', presetRevision: 3,
      contentEncryptionMode: 'plain' as const };
    const sources = [{ kind: 'direct' as const, setup: {} }, source];
    const plan = { desiredRevision: 4, sources, exclusions: [], support: [], recipePlans: [],
      recipeTitles: [{ ref: { pluginId: 'acme.setup', recipeId: 'tool', revision: '1' }, title: 'Tool' }] };
    const target = machineSetupApplyTargetFromPlanV1({ homeId: 'home', machineId: 'machine' }, plan);
    const input = buildMachineSetupTargetApplyInput(target);
    expect(input).toEqual({ homeId: 'home', machineId: 'machine', targets: [{
      homeId: 'home', machineId: 'machine', desiredRevision: 4, sources, exclusions: [], recipePlans: [],
    }] });
  });
});

describe('public Machine setup settlement', () => {
  it.each(['succeeded', 'failed'] as const)('waits for the retained operation and preserves its %s verdict', async state => {
    const failure = { errorCode: 'setup_failed', error: 'Setup failed' };
    const operation = { version: 1 as const, operationId: 'setup-operation', revision: 2,
      actionId: 'machines.setup.apply', state, scope: { accountId: 'account', machineId: 'machine' },
      title: 'Apply setup', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported' as const,
      ...(state === 'failed' ? { error: failure } : {}) };
    const response = { kind: 'found', operation } satisfies PluginActionResultById['action.operations.get'];
    const requests: unknown[] = [];
    const result = await waitForMachineSetupOperationV1('setup-operation', async request => {
      requests.push(request);
      return response;
    });
    expect(requests).toEqual([{ operationId: 'setup-operation', waitForTerminal: true }]);
    expect(result).toEqual(state === 'succeeded' ? null : { ok: false, ...failure });
  });
});
