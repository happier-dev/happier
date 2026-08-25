import { describe, expect, it } from 'vitest';

import {
  normalizeSessionCreateSpawnRequest,
  type SessionCreateSpawnRequestNormalizerDeps,
} from './normalizeSessionCreateSpawnRequest';

function createDeps(
  overrides: Partial<SessionCreateSpawnRequestNormalizerDeps> = {},
): SessionCreateSpawnRequestNormalizerDeps {
  return {
    activeServerId: 'server-1',
    defaultAgentId: 'claude',
    readSettings: async () => ({
      machineIdByServerIdByAccountId: {
        'server-1': { 'account-1': 'machine-account-current' },
      },
      lastTokenSubByServerId: { 'server-1': 'account-1' },
    }),
    readAgentDefinitions: () => [
      {
        id: 'claude',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      {
        id: 'review-bot',
        identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
      },
    ],
    now: () => 100,
    ...overrides,
  };
}

describe('normalizeSessionCreateSpawnRequest', () => {
  it('normalizes permission aliases and rejects unknown modes before Action dispatch', async () => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      permissionMode: 'read_only',
    }, createDeps());

    expect(normalized.input.permissionMode).toBe('read-only');
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      permissionMode: 'surprise-me',
    }, createDeps())).rejects.toThrow(/permission mode/i);
  });

  it('keeps a Provider-bound literal model named default while native default still resets', async () => {
    const providerBound = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      modelId: 'default',
      providerConnectionId: 'provider-1',
    }, createDeps());

    expect(providerBound.input.modelSelection).toMatchObject({
      v: 1,
      ref: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'provider-1',
        modelId: 'default',
      },
    });

    const nativeDefault = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      modelId: 'default',
    }, createDeps());

    expect(nativeDefault.input.modelSelection).toBeUndefined();
  });

  it('emits one strict V2 request with the exact target and configured external Agent identity', async () => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      modelId: 'review-model',
      providerConnectionId: 'provider-1',
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      configOptions: { reasoning_effort: 'high' },
      title: 'Review',
      initialMessage: 'Please review this branch.',
    }, createDeps());

    expect(normalized).toEqual({
      agentId: 'review-bot',
      input: {
        executionTarget: { serverId: 'server-1', machineId: 'machine-account-current' },
        directory: '/repo/project',
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
        },
        modelSelection: {
          v: 1,
          updatedAt: 100,
          ref: {
            agentTargetKey: 'backend:review-bot',
            providerConnectionId: 'provider-1',
            modelId: 'review-model',
          },
        },
        permissionMode: 'safe-yolo',
        agentModeId: 'plan',
        configuration: {
          mode: { value: null, updatedAtMs: 100 },
          model: { value: null, updatedAtMs: 100 },
          permissionIntent: { value: null, updatedAtMs: 100 },
          options: {
            reasoning_effort: { value: 'high', updatedAtMs: 100 },
          },
        },
        title: 'Review',
        initialMessage: 'Please review this branch.',
      },
    });
  });

  it('normalizes explicit environment variables into the strict V2 Action input', async () => {
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      environmentVariables: { TOKEN: 'secret', camelCase: 'daemon-compatible' },
    }, createDeps())).resolves.toMatchObject({
      input: {
        environmentVariables: { TOKEN: 'secret', camelCase: 'daemon-compatible' },
      },
    });
  });

  it('rejects conflicting configuration aliases before Action dispatch', async () => {
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 10,
        overrides: {
          reasoning_effort: { updatedAt: 10, value: 'low' },
        },
      },
      configOptions: { reasoning_effort: 'high' },
    }, createDeps())).rejects.toThrow(/conflicts/);
  });
});
