import { describe, expect, it, vi } from 'vitest';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
} from '@/rpc/handlers/registerSessionHandlers';

import { createSpawnNewSessionLifecycleActionHandler } from './createSpawnNewSessionLifecycleActionHandler';

describe('createSpawnNewSessionLifecycleActionHandler dev adaptation', () => {
  it('generates a daemon nonce and forwards rich spawn fields for fresh initial prompts', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-rich',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    const legacyRuntimeDescriptorV1 = {
      v: 1,
      agentId: 'codex',
      provider: {
        providerExtra: {
          owner: 'happier',
          schemaId: 'codex-runtime',
          v: 1,
        },
        backendMode: 'appServer',
      },
    } as const;
    const mcpSelection = {
      forceIncludeServerIds: ['server-a'],
      forceExcludeServerIds: ['server-b'],
    } as const;
    const connectedServices = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'profile',
          profileId: 'codex-profile',
        },
      },
    } as const;
    const sessionConfigOptionOverrides = {
      v: 1,
      updatedAt: 1710000000000,
      overrides: {
        reasoning_effort: { updatedAt: 1710000000000, value: 'xhigh' },
      },
    } as const;
    const configOptions = { ultracode: true } as const;

    const result = await handler({
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      initialPrompt: 'Inspect this workspace.',
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 1710000000001,
      agentModeId: 'plan',
      agentModeUpdatedAt: 1710000000002,
      modelId: 'gpt-5',
      modelUpdatedAt: 1710000000003,
      sessionConfigOptionOverrides,
      configOptions,
      profileId: 'codex-profile',
      environmentVariables: { FEATURE_FLAG: 'enabled' },
      connectedServices,
      connectedServicesUpdatedAt: 1710000000004,
      mcpSelection: {
        v: 1,
        managedServersEnabled: true,
        ...mcpSelection,
      },
      transcriptStorage: 'persisted',
      runtimeDescriptorV1: legacyRuntimeDescriptorV1,
      terminal: { mode: 'tmux' },
      windowsTerminalWindowName: 'Happier Test',
    });

    expect(result).toEqual({ type: 'success', sessionId: 'session-rich' });
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/project',
      spawnNonce: expect.any(String),
      initialPrompt: 'Inspect this workspace.',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 1710000000001,
      agentModeId: 'plan',
      agentModeUpdatedAt: 1710000000002,
      modelSelection: {
        v: 1,
        updatedAt: 1710000000003,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'gpt-5',
        },
      },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: expect.any(Number),
        overrides: {
          reasoning_effort: { updatedAt: 1710000000000, value: 'xhigh' },
          ultracode: { updatedAt: expect.any(Number), value: true },
        },
      },
      profileId: 'codex-profile',
      environmentVariables: { FEATURE_FLAG: 'enabled' },
      connectedServices,
      connectedServicesUpdatedAt: 1710000000004,
      mcpSelection: {
        v: 1,
        managedServersEnabled: true,
        ...mcpSelection,
      },
      transcriptStorage: 'persisted',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          agentExtra: {
            owner: 'happier',
            schemaId: 'codex-runtime',
            v: 1,
          },
          backendMode: 'appServer',
        },
      },
      terminal: { mode: 'tmux' },
      windowsTerminalWindowName: 'Happier Test',
    }));
    expect(spawnSession.mock.calls[0]?.[0].spawnNonce).not.toHaveLength(0);
  });

  it('rejects conflicting configOptions shorthand before spawning', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-rich',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });

    const result = await handler({
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1710000000000,
        overrides: {
          reasoning_effort: { updatedAt: 1710000000000, value: 'xhigh' },
        },
      },
      configOptions: {
        reasoning_effort: 'high',
      },
    });

    expect(result).toEqual(expect.objectContaining({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    }));
    expect(spawnSession).not.toHaveBeenCalled();
  });
});
