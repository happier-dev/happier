import { expect, it, vi } from 'vitest';
import { readDeploymentPreparation } from '@happier-dev/protocol/actions/executor/approvalPreparation';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import * as workflowPreparation from '@happier-dev/protocol/workflows/workflowStartPreparationV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCombinedMachineSetupActionDeps } from './composeMachineSetup';

it('observes independent Machines concurrently and retains the requested review order', async () => {
  const sources = [{ kind: 'direct' as const, setup: {} }];
  const targets = ['first', 'second'].map(machineId => ({ homeId: 'home', machineId, mode: 'effects' as const }));
  let inFlight = 0;
  let peak = 0;
  const targetPlan = vi.fn(async () => {
    peak = Math.max(peak, ++inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return { desiredRevision: 0, sources, exclusions: [], support: [] };
  });
  const unexpectedEffect = async () => { throw new Error('Review must not start a Run'); };
  const deps = createCombinedMachineSetupActionDeps({
    readDeps: createUnavailableActionTransportDeps,
    targetPlan,
    readHostFacts: async () => ({ machines: targets.map(({ machineId }) => ({ machineId, online: true })) }),
    orchestrationDirectory: '/setup', startCombined: unexpectedEffect, waitForRun: unexpectedEffect,
    readInvocations: unexpectedEffect,
  });
  const result = await deps.machineSetupPlan!({ input: { homeId: 'home', machineId: 'first', targets }, context: { surface: 'cli' } });
  expect(result).toMatchObject({ targets: targets.map(({ homeId, machineId }) => ({ homeId, machineId, plan: { sources } })) });
  expect({ peak, calls: targetPlan.mock.calls.length }).toEqual({ peak: 2, calls: 2 });
});

it('parses the reviewed Setup Apply and resolves its Workflow host once per preparation', async () => {
  const input = { homeId: 'home', machineId: 'controller', targets: [{
    homeId: 'home', machineId: 'guest', desiredRevision: 0,
    sources: [{ kind: 'direct', setup: {} }], exclusions: [], recipePlans: [],
  }] };
  const unexpectedEffect = async () => { throw new Error('Preparation needs no target or Run effects for this reviewed Setup'); };
  const deps = createCombinedMachineSetupActionDeps({
    readDeps: createUnavailableActionTransportDeps,
    targetPlan: unexpectedEffect,
    readHostFacts: async () => ({ machines: [
      { machineId: 'controller', online: true },
      { machineId: 'guest', online: true },
    ] }),
    orchestrationDirectory: '/setup',
    startCombined: unexpectedEffect,
    waitForRun: unexpectedEffect,
    readInvocations: unexpectedEffect,
  });
  // Observe both real owners while leaving parsing and host admission in place.
  const parse = vi.spyOn(MachineSetupApplyInputV1Schema._zod, 'run');
  const resolveHost = vi.spyOn(workflowPreparation, 'resolveCombinedActionWorkflowHostV1');
  try {
    const result = await readDeploymentPreparation(
      { ...createUnavailableActionTransportDeps(), ...deps }, 'machines.setup.apply', input,
      { surface: 'cli', authority: 'present_user' },
    );
    expect(result).toMatchObject({ input, preview: { host: { machineId: 'controller' } } });
    expect({ schemaParses: parse.mock.calls.length, hostResolves: resolveHost.mock.calls.length })
      .toEqual({ schemaParses: 1, hostResolves: 1 });
  } finally {
    parse.mockRestore();
    resolveHost.mockRestore();
  }
});
