import { describe, expect, it } from 'vitest';

import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';

describe('buildAgentProbeCacheKey', () => {
  it('shares an observation across the runtime id and its equivalent concrete built-in target without merging distinct accounts or configured backends', () => {
    const context = { agentId: 'opencode', cwd: '/workspace', connectedServiceSelection: 'selected-account' };
    const runtimeId = buildAgentProbeCacheKey(context);
    expect(buildAgentProbeCacheKey({ ...context, backendTarget: { kind: 'builtInAgent', agentId: 'opencode' } })).toBe(runtimeId);
    expect(buildAgentProbeCacheKey({ ...context, connectedServiceSelection: 'other-account' })).not.toBe(runtimeId);
    expect(buildAgentProbeCacheKey({ ...context, backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom' } })).not.toBe(runtimeId);
  });

  it('keys cold probes only by their non-secret runtime inputs', () => {
    expect(buildAgentProbeCacheKey({
      agentId: 'codex' as const,
      cwd: '/workspace',
      variant: 'appServer',
      profile: 'work',
    })).toBe('agent:codex:target:none:cwd:/workspace:v:appServer:profile:work:connected:none');
  });

  it('separates requested configuration scopes while sharing equal unordered overrides', () => {
    const context = { agentId: 'codex', cwd: '/workspace' };
    const scoped = buildAgentProbeCacheKey({ ...context, configOptionOverrides: { provider: 'gateway', region: '' } });
    expect(scoped).not.toBe(buildAgentProbeCacheKey(context));
    expect(scoped).not.toBe(buildAgentProbeCacheKey({ ...context, configOptionOverrides: { provider: 'codex', region: '' } }));
    expect(scoped).toBe(buildAgentProbeCacheKey({ ...context, configOptionOverrides: { region: '', provider: 'gateway' } }));
    expect(buildAgentProbeCacheKey({ ...context, configOptionOverrides: {} })).toBe(buildAgentProbeCacheKey(context));
    const selectedModel = buildAgentProbeCacheKey({ ...context, modelId: 'first-model' });
    expect(selectedModel).not.toBe(buildAgentProbeCacheKey(context));
    expect(selectedModel).not.toBe(buildAgentProbeCacheKey({ ...context, modelId: 'second-model' }));
  });
});
