import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listVoiceToolActionSpecs } from '@happier-dev/protocol';

describe('ElevenLabs BYO autoprov', () => {
  const originalFetch = globalThis.fetch;

  function fetchMock() {
    return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  }

  function okJson(payload: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }

  function errorResponse(status: number, text = 'error'): Response {
    return {
      ok: false,
      status,
      json: async () => ({}),
      text: async () => text,
    } as unknown as Response;
  }

  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates an agent using existing client tools when available', async () => {
	    const requiredToolNames = listVoiceToolActionSpecs()
	      .map((spec) => spec.bindings?.voiceClientToolName)
	      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolNames.map((name) => ({
            id: `tool_${name}`,
            tool_config: { type: 'client', name, description: '' },
          })),
        }),
      )
      .mockResolvedValueOnce(okJson({ agent_id: 'agent_1' }));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    const result = await createHappierElevenLabsAgent({ apiKey: 'xi_test' });
    expect(result.agentId).toBe('agent_1');

    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(fetchMock().mock.calls[0]?.[0]).toContain('/v1/convai/tools');
    expect(fetchMock().mock.calls[1]?.[0]).toContain('/v1/convai/agents/create');

    const body = JSON.parse(fetchMock().mock.calls[1]?.[1]?.body);
    expect(body.conversation_config.agent.prompt.tool_ids).toEqual(requiredToolNames.map((name) => `tool_${name}`));
    expect(body.conversation_config.tts?.voice_id).toBe('MClEFoImJXBTgLwdLI5n');
    expect(body.conversation_config.agent.prompt.prompt).toContain('{{initialConversationContext}}');
    expect(body.conversation_config.agent.prompt.prompt).toContain('{{sessionId}}');
    expect(String(body.conversation_config.agent.prompt.prompt)).not.toMatch(/Claude Code/i);
  });

  it('creates missing client tools before creating the agent', async () => {
	    const requiredToolNames = listVoiceToolActionSpecs()
	      .map((spec) => spec.bindings?.voiceClientToolName)
	      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

    fetchMock().mockResolvedValueOnce(okJson({ tools: [] }));
    for (const name of requiredToolNames) {
      fetchMock().mockResolvedValueOnce(okJson({ id: `tool_${name}` }));
    }
    fetchMock().mockResolvedValueOnce(okJson({ agent_id: 'agent_1' }));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    const result = await createHappierElevenLabsAgent({ apiKey: 'xi_test' });
    expect(result.agentId).toBe('agent_1');

    expect(fetchMock()).toHaveBeenCalledTimes(requiredToolNames.length + 2);
    expect(fetchMock().mock.calls[1]?.[0]).toContain('/v1/convai/tools');
    expect(fetchMock().mock.calls[2]?.[0]).toContain('/v1/convai/tools');
    expect(fetchMock().mock.calls[requiredToolNames.length + 1]?.[0]).toContain('/v1/convai/agents/create');
  });

  it('updates an existing agent to the latest template', async () => {
	    const requiredToolNames = listVoiceToolActionSpecs()
	      .map((spec) => spec.bindings?.voiceClientToolName)
	      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolNames.map((name) => ({
            id: `tool_${name}`,
            tool_config: { type: 'client', name, description: '' },
          })),
        }),
      )
      .mockResolvedValueOnce(okJson({ agent_id: 'agent_1' }));

    const { updateHappierElevenLabsAgent } = await import('./autoprovision');
    await updateHappierElevenLabsAgent({ apiKey: 'xi_test', agentId: 'agent_1' });

    expect(fetchMock().mock.calls[1]?.[0]).toContain('/v1/convai/agents/agent_1');
    expect(fetchMock().mock.calls[1]?.[1]?.method).toBe('PATCH');
    const body = JSON.parse(fetchMock().mock.calls[1]?.[1]?.body);
    expect(body.conversation_config.agent.prompt.tool_ids).toEqual(requiredToolNames.map((name) => `tool_${name}`));
    expect(body.conversation_config.tts?.voice_id).toBe('MClEFoImJXBTgLwdLI5n');
  });

  it('uses provided tts configuration when creating an agent', async () => {
	    const requiredToolNames = listVoiceToolActionSpecs()
	      .map((spec) => spec.bindings?.voiceClientToolName)
	      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolNames.map((name) => ({
            id: `tool_${name}`,
            tool_config: { type: 'client', name, description: '' },
          })),
        }),
      )
      .mockResolvedValueOnce(okJson({ agent_id: 'agent_1' }));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    await createHappierElevenLabsAgent({
      apiKey: 'xi_test',
      tts: {
        voiceId: 'voice_custom',
        modelId: 'eleven_turbo_v2_5',
        voiceSettings: { stability: 0.45, similarityBoost: 0.75, useSpeakerBoost: true },
      },
    } as any);

    const body = JSON.parse(fetchMock().mock.calls[1]?.[1]?.body);
    expect(body.conversation_config.tts?.voice_id).toBe('voice_custom');
    expect(body.conversation_config.tts?.model_id).toBe('eleven_turbo_v2_5');
    expect(body.conversation_config.tts?.voice_settings?.stability).toBe(0.45);
    expect(body.conversation_config.tts?.voice_settings?.similarity_boost).toBe(0.75);
    expect(body.conversation_config.tts?.voice_settings?.use_speaker_boost).toBe(true);
  });

  it('always sends xi-api-key header and does not leak it in error messages', async () => {
    fetchMock().mockResolvedValueOnce(errorResponse(401, 'bad key: xi_test'));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    let thrown: unknown = null;
    try {
      await createHappierElevenLabsAgent({ apiKey: 'xi_test' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(String((thrown as Error)?.message ?? '')).toMatch(/ElevenLabs/i);

    const headers = fetchMock().mock.calls?.[0]?.[1]?.headers as Headers;
    expect(headers.get('xi-api-key')).toBe('xi_test');
    expect(headers.get('Content-Type')).toBe('application/json');

    expect(String((thrown as Error)?.message ?? '')).not.toContain('xi_test');
  });

  it('fails without creating an agent when client tool creation partially fails', async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ tools: [] }))
      .mockResolvedValueOnce(okJson({ id: 'tool_message' }))
      .mockResolvedValueOnce(errorResponse(500, 'tool_create_failed'));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    await expect(createHappierElevenLabsAgent({ apiKey: 'xi_test' })).rejects.toThrow(/ElevenLabs API error \(500\)/);

    const requestUrls = fetchMock().mock.calls.map((call) => String(call[0]));
    expect(requestUrls).toEqual([
      expect.stringContaining('/v1/convai/tools'),
      expect.stringContaining('/v1/convai/tools'),
      expect.stringContaining('/v1/convai/tools'),
    ]);
    expect(requestUrls.some((url) => url.includes('/v1/convai/agents/create'))).toBe(false);
  });

  it('fails when create agent response is missing agent_id', async () => {
	    const requiredToolNames = listVoiceToolActionSpecs()
	      .map((spec) => spec.bindings?.voiceClientToolName)
	      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolNames.map((name) => ({
            id: `tool_${name}`,
            tool_config: { type: 'client', name },
          })),
        }),
      )
      .mockResolvedValueOnce(okJson({ agent_id: '' }));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    await expect(createHappierElevenLabsAgent({ apiKey: 'xi_test' })).rejects.toThrow(
      'ElevenLabs create agent did not return an agent_id',
    );
  });

  it('surfaces update failure with sanitized ElevenLabs error', async () => {
	    const requiredToolNames = listVoiceToolActionSpecs()
	      .map((spec) => spec.bindings?.voiceClientToolName)
	      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolNames.map((name) => ({
            id: `tool_${name}`,
            tool_config: { type: 'client', name },
          })),
        }),
      )
      .mockResolvedValueOnce(errorResponse(502, 'backend unavailable'));

    const { updateHappierElevenLabsAgent } = await import('./autoprovision');
    await expect(updateHappierElevenLabsAgent({ apiKey: 'xi_test', agentId: 'agent_1' })).rejects.toThrow(
      /ElevenLabs API error \(502\)/,
    );

    const patchCall = fetchMock().mock.calls[1];
    expect(String(patchCall?.[0])).toContain('/v1/convai/agents/agent_1');
    expect(patchCall?.[1]?.method).toBe('PATCH');
  });
});
