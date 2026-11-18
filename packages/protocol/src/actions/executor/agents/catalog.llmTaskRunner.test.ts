import { expect, it } from 'vitest';

import { createActionExecutor } from '../../actionExecutor.js';

const runner = {
  v: 1,
  modelSelection: {
    agentTargetKey: 'agent:happier.agent.codex/codex',
    providerConnectionId: null,
    modelId: 'gpt-6-luna',
  },
  permissionMode: 'no_tools',
} as const;

// AUTO-LIVE U1: the spec admitted this read, but the dispatcher sent it down the per-Agent path, which has no Agent
// selector and refused it as invalid_parameters on the Machine (unknown_agent on the UI host).
it('answers a background task runner read from the Machine runner owner, with no Agent selector', async () => {
  const seen: unknown[] = [];
  // The host's runner port is the boundary: on a Machine it reads that Machine's ready Agents.
  const executor = createActionExecutor({
    agentsModelsList: async (args) => {
      seen.push(args);
      return {
        items: [],
        llmTaskRunner: {
          ok: true,
          source: 'auto',
          title: 'GPT-6-Luna',
          runner,
        },
      };
    },
  });
  const result = await executor.execute(
    'agents.models.list',
    {
      purpose: 'llm_task_runner',
      task: 'deploy_suggestion',
      machineId: 'machine-a',
    },
    {
      surface: 'ui',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      serverId: 'home-a',
    },
  );
  expect(result).toEqual({
    ok: true,
    result: {
      items: [],
      llmTaskRunner: { ok: true, source: 'auto', title: 'GPT-6-Luna', runner },
    },
  });
  expect(seen).toEqual([
    expect.objectContaining({
      purpose: 'llm_task_runner',
      task: 'deploy_suggestion',
      machineId: 'machine-a',
    }),
  ]);
});
