import { expect, it } from 'vitest';

import { PluginProjectionV2Schema } from '../daemon/contributionRegistryProjection.js';
import { readAgentTargetReadinessV1 } from '../actions/executor/agents/agentBackendReadiness.js';
import { buildMachineAgentInventoryDescriptors, projectMachineAgentsDetectResponse } from './machineAgentInventory.js';

it('includes execution-only Agents in Machine readiness without excluding Session Agents', async () => {
  const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, agentsById: {
    reviewer: { id: 'reviewer', title: 'Reviewer', capabilities: {
      executionRuns: { open: ['create'], checkpoint: false, stop: true },
    } },
    panel: { id: 'panel', title: 'Panel', capabilities: {
      executionRuns: { open: ['create'], checkpoint: false, stop: true },
    } },
    session: { id: 'session', title: 'Session', capabilities: {
      sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
    } },
    static: { id: 'static', title: 'Static' },
  } });
  const agents = buildMachineAgentInventoryDescriptors(projection);
  const inventory = projectMachineAgentsDetectResponse({ agents, response: { protocolVersion: 1,
    results: Object.fromEntries(agents.map(({ agentId }) => [`cli.${agentId}`, { ok: true, data: {
      installed: agentId !== 'reviewer', version: null, latestVersion: null,
      update: { supported: false, command: null },
      signIn: { status: 'unknown', loginSupport: 'unsupported' },
      platform: { supported: true },
      install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null },
      dependencies: agentId === 'panel' ? [{ key: 'native-runtime', installed: false, version: null }] : [],
    } }])) } });
  // Machine RPC is the boundary; roster selection and readiness composition remain real.
  const readiness = await readAgentTargetReadinessV1({ machinesAgentsList: async () => inventory }, 'machine',
    ['reviewer', 'panel', 'session', 'static'].map(backendId => ({ kind: 'backend', backendId })), {});
  expect(readiness).toEqual(['notInstalled', 'notInstalled', 'ready', undefined]);
  expect(agents.map(agent => agent.agentId)).toEqual(['reviewer', 'panel', 'session']);
});
