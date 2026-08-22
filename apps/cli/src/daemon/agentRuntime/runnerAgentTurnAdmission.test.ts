import { describe, expect, it } from 'vitest';
import {
  createAgentSessionRunnerFactoryBinding,
  createHostDeclarativeAcpRunnerBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  authorizeRunnerAgentNewTurn,
  evaluateRunnerAgentNewTurnAdmission,
} from './runnerAgentTurnAdmission';

function retainedAgent(input: Readonly<{
  pluginVersion: string;
  immutableGenerationId: string;
}>) {
  return createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'happier.agent.acme',
    pluginVersion: input.pluginVersion,
    agentId: 'acme',
    localAgentId: 'acme',
    immutableGenerationId: input.immutableGenerationId,
    locator: {
      module: './agent/factory.js',
      export: 'createAgentRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: 'agent/factory.js',
    loadMode: 'immutable-js',
  });
}

const generationG = retainedAgent({
  pluginVersion: '1.0.0',
  immutableGenerationId: 'generation-g',
});

describe('runner Agent new-turn admission', () => {
  it('admits an exact retained host declarative ACP binding', async () => {
    const hostBinding = createHostDeclarativeAcpRunnerBinding({
      kind: 'host_declarative_acp_v1',
      v: 1,
      pluginId: 'happier.agent.acme',
      pluginVersion: '1.0.0',
      agentId: 'acme',
      qualifiedAgentId: 'happier.agent.acme/agents/acme',
      localAgentId: 'acme',
      immutableGenerationId: 'generation-g',
    });

    await expect(authorizeRunnerAgentNewTurn({
      retainedAgent: hostBinding,
    })).resolves.toEqual({ status: 'admitted' });
    expect(evaluateRunnerAgentNewTurnAdmission({
      retainedAgent: hostBinding,
    })).toEqual({ status: 'admitted' });
  });

  it('admits an exact retained binding', async () => {
    await expect(authorizeRunnerAgentNewTurn({
      retainedAgent: generationG,
    })).resolves.toEqual({ status: 'admitted' });
  });

  it('denies a malformed retained binding', async () => {
    await expect(authorizeRunnerAgentNewTurn({
      retainedAgent: { agentId: 'acme' },
    })).resolves.toEqual({
      status: 'denied',
      reason: 'retained_agent_binding_invalid',
    });
  });
});
