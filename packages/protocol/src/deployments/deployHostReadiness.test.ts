import { describe, expect, it } from 'vitest';
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
