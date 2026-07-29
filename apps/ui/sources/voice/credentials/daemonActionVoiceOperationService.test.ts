import { describe, expect, it, vi } from 'vitest';

import {
  createDaemonActionVoiceOperationService,
} from './daemonActionVoiceOperationService';

const ACTION_ID = 'happier.voice.openai/mint-realtime-client-auth';

function projection() {
  return {
    supported: true as const,
    projection: {
      v: 2 as const,
      generation: 12,
      installedPackagesById: {},
      agentsById: {},
      backendsById: {},
      actionsById: {
        [ACTION_ID]: {
          id: 'mint-realtime-client-auth',
          pluginId: 'happier.voice.openai',
          title: 'OpenAI Realtime client authentication',
          scopes: ['session' as const],
          surfaces: ['ui' as const],
          placement: 'secondary' as const,
          dangerLevel: 'safe' as const,
          available: true,
        },
      },
      toolsById: {},
      commandsById: {},
      resourcesById: {},
      settingsById: {},
      familiesById: {},
      diagnostics: [],
    },
  };
}

describe('createDaemonActionVoiceOperationService', () => {
  it('executes the qualified action at the current generation with conversation-session UI custody', async () => {
    const describeProjection = vi.fn(async () => projection());
    const execute = vi.fn(async () => ({
      supported: true as const,
      result: {
        ok: true as const,
        result: {
          status: 200,
          finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
          headers: {},
          body: {
            value: 'ephemeral-client-secret',
            expires_at: 2_000_000_000,
          },
        },
      },
    }));
    const signal = new AbortController().signal;
    const service = createDaemonActionVoiceOperationService({
      pluginId: 'happier.voice.openai',
      actionLocalId: 'mint-realtime-client-auth',
      conversationSessionId: 'voice-session',
      signal,
      isCurrent: () => true,
      resolveMachineId: () => 'machine-1',
      resolveServerId: () => 'server-1',
      describeProjection,
      execute,
    });

    const response = await service.request({
      operationId: 'client-auth',
      parameters: { body: { session: { type: 'realtime' } } },
      signal,
    });

    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
      value: 'ephemeral-client-secret',
      expires_at: 2_000_000_000,
    });
    expect(describeProjection).toHaveBeenCalledWith('machine-1', {
      serverId: 'server-1',
      signal: expect.any(AbortSignal),
    });
    expect(execute).toHaveBeenCalledWith('machine-1', {
      serverId: 'server-1',
      expectedGeneration: '12',
      qualifiedActionId: ACTION_ID,
      input: {
        operationId: 'client-auth',
        parameters: { body: { session: { type: 'realtime' } } },
      },
      sessionId: 'voice-session',
      executionSurface: 'ui',
      signal: expect.any(AbortSignal),
    });
  });

  it('inspects exact action availability without executing the daemon action', async () => {
    const describeProjection = vi.fn(async () => projection());
    const execute = vi.fn();
    const service = createDaemonActionVoiceOperationService({
      pluginId: 'happier.voice.openai',
      actionLocalId: 'mint-realtime-client-auth',
      conversationSessionId: null,
      signal: new AbortController().signal,
      isCurrent: () => true,
      resolveMachineId: () => 'machine-1',
      resolveServerId: () => 'server-1',
      describeProjection,
      execute,
    });

    await expect(service.inspectAvailability()).resolves.toBeUndefined();

    expect(describeProjection).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed before action execution when the current projection lacks the exact action', async () => {
    const execute = vi.fn();
    const service = createDaemonActionVoiceOperationService({
      pluginId: 'happier.voice.openai',
      actionLocalId: 'mint-realtime-client-auth',
      conversationSessionId: null,
      signal: new AbortController().signal,
      isCurrent: () => true,
      resolveMachineId: () => 'machine-1',
      resolveServerId: () => 'server-1',
      describeProjection: async () => ({
        ...projection(),
        projection: { ...projection().projection, actionsById: {} },
      }),
      execute,
    });

    await expect(service.request({
      operationId: 'client-auth',
      parameters: {},
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_unavailable' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unknown fields in the daemon action response envelope', async () => {
    const service = createDaemonActionVoiceOperationService({
      pluginId: 'happier.voice.openai',
      actionLocalId: 'mint-realtime-client-auth',
      conversationSessionId: 'voice-session',
      signal: new AbortController().signal,
      isCurrent: () => true,
      resolveMachineId: () => 'machine-1',
      resolveServerId: () => 'server-1',
      describeProjection: async () => projection(),
      execute: async () => ({
        supported: true as const,
        result: {
          ok: true as const,
          result: {
            status: 200,
            finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
            headers: {},
            body: {
              value: 'ephemeral-client-secret',
              expires_at: 2_000_000_000,
            },
            unexpected: true,
          },
        },
      }),
    });

    await expect(service.request({
      operationId: 'client-auth',
      parameters: {},
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_invalid_response' });
  });
});
