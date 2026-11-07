import { describe, expect, it } from 'vitest';

import { DEPLOY_HOST_DOCKER_ITEM, readDeployHostReadiness } from './EnvironmentMachineChoice';

const other = { kind: 'softwareRecipe', selection: { ref: { pluginId: 'happier.machine.recipes', recipeId: 'caddy', revision: '1' }, inputs: {} } } as const;
const prepared = (status: 'satisfied' | 'drifted' | 'unverifiable', otherStatus: 'satisfied' | 'drifted' = 'satisfied') => ({
  ok: true as const,
  input: { targets: [{ homeId: 'home', machineId: 'vps-3', sources: [{ kind: 'direct', setup: { items: [other, DEPLOY_HOST_DOCKER_ITEM] } }] }] },
  facts: [{ homeId: 'home', machineId: 'vps-3', support: [
    { sourceIndex: 0, itemIndex: 0, status: otherStatus }, { sourceIndex: 0, itemIndex: 1, status },
  ] }],
}) as never;

describe('deploy host readiness from the Machine setup Plan', () => {
  it('reads the Docker recipe’s own status, not another item’s', () => {
    expect(readDeployHostReadiness(prepared('satisfied', 'drifted'), 'vps-3')).toBe('ready');
    expect(readDeployHostReadiness(prepared('drifted'), 'vps-3')).toBe('needsSetup');
  });

  it('keeps an unchecked or failed Plan unknown, never ready', () => {
    expect(readDeployHostReadiness(prepared('unverifiable'), 'vps-3')).toBe('unknown');
    expect(readDeployHostReadiness({ ok: false, errorCode: 'machine_offline', error: 'machine_offline' }, 'vps-3')).toBe('unknown');
  });
});
