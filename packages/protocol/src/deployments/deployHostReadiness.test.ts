import { describe, expect, it } from 'vitest';
import { ActionExecuteFailureSchema } from '../actions/actionExecutionResult.js';
import { DEPLOY_HOST_DOCKER_ITEM, readDeployHostReadiness, readDeployHostRecipe } from './deployHostReadiness.js';
import type { MachineSetupPlanResultV1 } from '../machines/managed/actionsV1.js';

describe('deployment host recipe selection', () => {
  it('skips Agent items while retaining the Docker recipe and its own readiness', () => {
    const plan: MachineSetupPlanResultV1 = {
      desiredRevision: 0,
      sources: [{ kind: 'direct', setup: { items: [
        { kind: 'agent', agentId: 'catalog.example/agent' }, DEPLOY_HOST_DOCKER_ITEM,
      ] } }],
      exclusions: [],
      support: [
        { sourceIndex: 0, itemIndex: 0, status: 'drifted' },
        { sourceIndex: 0, itemIndex: 1, status: 'satisfied' },
      ],
    };
    const result = { targets: [{ homeId: 'home', machineId: 'host', plan }],
      review: { machineId: 'host', machines: [{ machineId: 'host', online: true }] } };
    expect(readDeployHostRecipe(result, 'host')).toEqual({ item: DEPLOY_HOST_DOCKER_ITEM, status: 'satisfied' });
    expect(readDeployHostReadiness(result, 'host')).toBe('ready');
    expect(readDeployHostReadiness(result, 'another-host')).toBe('unknown');
  });
});

const other = { kind: 'softwareRecipe', selection: { ref: { pluginId: 'happier.machine.recipes', recipeId: 'caddy', revision: '1' }, inputs: {} } } as const;
const prepared = (status: 'satisfied' | 'drifted' | 'unverifiable', otherStatus: 'satisfied' | 'drifted' = 'satisfied') => ({
  ok: true as const,
  input: { targets: [{ homeId: 'home', machineId: 'vps-3', sources: [{ kind: 'direct', setup: { items: [other, DEPLOY_HOST_DOCKER_ITEM] } }] }] },
  facts: [{ homeId: 'home', machineId: 'vps-3', support: [
    { sourceIndex: 0, itemIndex: 0, status: otherStatus }, { sourceIndex: 0, itemIndex: 1, status },
  ] }],
}) as never;

describe('deploy host readiness from a prepared Machine setup Plan', () => {
  it('reads the Docker recipe’s own status, not another item’s', () => {
    expect(readDeployHostReadiness(prepared('satisfied', 'drifted'), 'vps-3')).toBe('ready');
    expect(readDeployHostReadiness(prepared('drifted'), 'vps-3')).toBe('needsSetup');
  });

  it('keeps an unchecked or failed Plan unknown, never ready', () => {
    expect(readDeployHostReadiness(prepared('unverifiable'), 'vps-3')).toBe('unknown');
    const failed = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'machine_offline', error: 'machine_offline' });
    expect(readDeployHostReadiness(failed, 'vps-3')).toBe('unknown');
  });
});
