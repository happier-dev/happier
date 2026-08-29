import { describe, expect, it } from 'vitest';

import {
  createAgentSessionRunnerFactoryBinding,
  createHostDeclarativeAcpRunnerBinding,
} from './agentSessionRunnerFactoryBinding';

describe('Agent Session runner binding', () => {
  it('retains direct locator facts without grant-derived digests', () => {
    const binding = createAgentSessionRunnerFactoryBinding({
      v: 1,
      pluginId: 'acme.agent',
      pluginVersion: '1.0.0',
      agentId: 'acme.agent/main',
      localAgentId: 'main',
      immutableGenerationId: 'generation-g',
      locator: {
        module: './agent/runtime/factory.js',
        export: 'createAgentRuntime',
        runtimeApiVersion: 1,
      },
      normalizedModulePath: 'agent/runtime/factory.js',
      loadMode: 'immutable-js',
    });

    expect(binding).toEqual({
      v: 1,
      pluginId: 'acme.agent',
      pluginVersion: '1.0.0',
      agentId: 'acme.agent/main',
      localAgentId: 'main',
      immutableGenerationId: 'generation-g',
      locator: {
        module: './agent/runtime/factory.js',
        export: 'createAgentRuntime',
        runtimeApiVersion: 1,
      },
      normalizedModulePath: 'agent/runtime/factory.js',
      loadMode: 'immutable-js',
    });
    expect(binding).not.toHaveProperty('manifestDigest');
    expect(binding).not.toHaveProperty('moduleDigest');
    expect(binding).not.toHaveProperty('runtimeBindingDigest');
  });

  it('retains direct host-declarative identity without a digest envelope', () => {
    const binding = createHostDeclarativeAcpRunnerBinding({
      kind: 'host_declarative_acp_v1',
      v: 1,
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.0.0',
      agentId: 'codex',
      qualifiedAgentId: 'happier.agent.codex/agents/codex',
      localAgentId: 'codex',
      immutableGenerationId: 'generation-codex',
    });

    expect(binding).not.toHaveProperty('manifestDigest');
    expect(binding).not.toHaveProperty('runtimeBindingDigest');
  });
});
