import { describe, expect, it } from 'vitest';

import {
  createAgentSessionRunnerFactoryBinding,
  createHostDeclarativeAcpRunnerBinding,
  verifyAgentSessionRunnerBindingV1,
} from './agentSessionRunnerFactoryBinding';

describe('Agent Session runner binding', () => {
  it.each([
    { kind: 'account_release', pluginId: 'acme.agent', version: '1.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
    { kind: 'bundled_first_party', packagedRuntime: { kind: 'app_bundle', bundleId: 'ui-bundle' } },
    { kind: 'bundled_first_party', packagedRuntime: { kind: 'source_declaration', packageName: '@acme/agent' } },
  ])('refuses portable declaration custody before admitting a Machine runner: $kind', (sourceCustody) => {
    expect(() => verifyAgentSessionRunnerBindingV1({
      kind: 'host_declarative_acp_v1', v: 1, pluginId: 'acme.agent', pluginVersion: '1.0.0',
      agentId: 'acme.agent/main', qualifiedAgentId: 'acme.agent/agents/main', localAgentId: 'main', sourceCustody,
    })).toThrow();
  });

  it('retains direct locator facts without grant-derived digests', () => {
    const binding = createAgentSessionRunnerFactoryBinding({
      v: 1,
      pluginId: 'acme.agent',
      pluginVersion: '1.0.0',
      agentId: 'acme.agent/main',
      localAgentId: 'main',
      sourceCustody: {
        kind: 'managed',
        immutableGenerationId: 'generation-g',
        installSource: 'archive',
      },
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
      sourceCustody: {
        kind: 'managed',
        immutableGenerationId: 'generation-g',
        installSource: 'archive',
      },
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
    const input = {
      kind: 'host_declarative_acp_v1',
      v: 1,
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.0.0',
      agentId: 'codex',
      qualifiedAgentId: 'happier.agent.codex/agents/codex',
      localAgentId: 'codex',
      sourceCustody: {
        kind: 'bundled_first_party',
        packagedRuntime: {
          kind: 'pinned_runner_snapshot',
          snapshotId: 'runner-snapshot-codex',
        },
      },
    } as const;
    const binding = createHostDeclarativeAcpRunnerBinding(input);

    expect(binding).toEqual(input);
    expect(binding).not.toHaveProperty('manifestDigest');
    expect(binding).not.toHaveProperty('runtimeBindingDigest');
    expect(binding).not.toHaveProperty('immutableGenerationId');
  });

  it('rejects generation-shaped bundled custody and process-local occurrence identity', () => {
    const input = {
      kind: 'host_declarative_acp_v1',
      v: 1,
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.0.0',
      agentId: 'codex',
      qualifiedAgentId: 'happier.agent.codex/agents/codex',
      localAgentId: 'codex',
      sourceCustody: {
        kind: 'bundled_first_party',
        packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: 'runner-snapshot-codex' },
      },
    } as const;
    expect(verifyAgentSessionRunnerBindingV1(input)).toEqual(input);
    for (const forbidden of [
      { immutableGenerationId: 'legacy-generation' },
      { occurrenceId: 'process-local-occurrence' },
    ]) {
      expect(() => verifyAgentSessionRunnerBindingV1({ ...input, ...forbidden })).toThrow();
    }
  });
});
