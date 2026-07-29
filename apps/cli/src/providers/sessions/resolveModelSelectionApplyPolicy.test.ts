import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import {
  resolveNativeAgentModelApplyPolicy,
  resolveAgentProviderApplyPolicyFromRegistry,
  resolveSessionModelSelectionApplyPolicy,
} from './resolveModelSelectionApplyPolicy';

const native = {
  agentTargetKey: 'backend:codex',
  providerConnectionId: null,
  modelId: 'native-model',
} as const;
const providerA = {
  agentTargetKey: 'backend:codex',
  providerConnectionId: ProviderConnectionIdSchema.parse('pc_a'),
  modelId: 'provider-a',
} as const;
const providerA2 = { ...providerA, modelId: 'provider-a-2' } as const;
const providerB = { ...providerA, providerConnectionId: ProviderConnectionIdSchema.parse('pc_b') } as const;

describe('resolveSessionModelSelectionApplyPolicy', () => {
  it.each([
    [{ supportsSelection: false, nonAcpApplyScope: 'next_prompt' }, 'unsupported'],
    [{ supportsSelection: true, nonAcpApplyScope: 'spawn_only' }, 'restart_session'],
    [{
      supportsSelection: true,
      nonAcpApplyScope: 'next_prompt',
      acpApplyBehavior: 'restart_session',
    }, 'restart_session'],
    [{
      supportsSelection: true,
      nonAcpApplyScope: 'next_prompt',
      acpApplyBehavior: 'set_model',
    }, 'live'],
  ] as const)('maps native Agent model capability %o to %s', (modelConfig, expected) => {
    expect(resolveNativeAgentModelApplyPolicy(modelConfig)).toBe(expected);
  });

  it('uses the Agent-owned model apply policy for native-only changes', () => {
    expect(resolveSessionModelSelectionApplyPolicy({
      current: native,
      next: { ...native, modelId: 'native-next' },
      agentPolicy: 'restart_session',
    })).toBe('restart_session');
    expect(resolveSessionModelSelectionApplyPolicy({
      current: native,
      next: { ...native, modelId: 'native-next' },
      agentPolicy: 'live',
    })).toBe('live');
  });

  it('requires exact authorization before a same-connection provider model change can be live', () => {
    expect(resolveSessionModelSelectionApplyPolicy({
      current: providerA,
      next: providerA2,
      agentPolicy: 'restart_session',
    })).toBe('restart_session');
    expect(resolveSessionModelSelectionApplyPolicy({
      current: providerA,
      next: providerA2,
      agentPolicy: 'live',
    })).toBe('restart_session');
  });

  it('does not infer an identical provider ref is live without exact authorization facts', () => {
    expect(resolveSessionModelSelectionApplyPolicy({
      current: providerA,
      next: { ...providerA },
      agentPolicy: 'restart_session',
    })).toBe('restart_session');
  });

  it.each([
    [native, providerA],
    [providerA, providerB],
    [providerA, native],
  ] as const)('requires restart for a provider source transition', (current, next) => {
    expect(resolveSessionModelSelectionApplyPolicy({
      current,
      next,
      agentPolicy: 'live',
    })).toBe('restart_session');
  });

  it('resolves policy by the agent-owned backend target without agent-name branching', () => {
    const registry = {
      contributes: {
        agentDefinitionsById: new Map([
          ['agent-codex', {
            definition: {
              ownedBackendIds: ['codex'],
              providerRequirements: {
                acceptsProtocols: ['openai-responses'],
                required: {},
                credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
                authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
                materialization: 'engineConfig',
                applyPolicy: 'restart_session',
                supportsFreeformModelIds: true,
              },
            },
          }],
        ]),
      },
    };

    expect(resolveAgentProviderApplyPolicyFromRegistry({
      registry,
      backendId: 'codex',
    })).toBe('restart_session');
    expect(resolveAgentProviderApplyPolicyFromRegistry({
      registry,
      backendId: 'native-only',
    })).toBe('unsupported');
  });
});
