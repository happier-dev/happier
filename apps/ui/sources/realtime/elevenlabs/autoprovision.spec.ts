import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { installRealtimeCommonModuleMocks } from '../realtimeTestHelpers';

vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));
vi.mock('@happier-dev/agents', () => ({
  buildElevenLabsVoiceAgentPrompt: vi.fn(
    () => 'Claude Code prompt with {{initialConversationContext}} and {{sessionId}}',
  ),
}));
vi.mock('@/voice/tools/resolveDisabledVoiceActionIds', () => ({
  resolveDisabledVoiceActionIdsFromState: vi.fn(() => []),
}));

installRealtimeCommonModuleMocks({
  storage: () =>
    createStorageModuleStub({
      storage: {
        getState: vi.fn(() => ({ settings: {} })),
      },
    }),
});

const REQUIRED_CLIENT_TOOL_SPECS = [
  {
    name: 'startReview',
    description: 'Start a review for the active session.',
    parameters: {
      type: 'object',
      description: 'Parameters',
      properties: {
        sessionId: { type: 'string', description: 'Session id' },
        engineIds: {
          type: 'array',
          description: 'Review engines',
          items: { type: 'string', description: 'Engine id' },
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'spawnSessionPicker',
    description: 'Open the session picker.',
    parameters: {
      type: 'object',
      description: 'Parameters',
      properties: {
        sessionId: { type: 'string', description: 'Session id' },
      },
      required: ['sessionId'],
    },
  },
] as const;

const EXPECTED_CLIENT_EVENTS = [
  'audio',
  'interruption',
  'agent_response',
  'agent_response_correction',
  'agent_chat_response_part',
  'user_transcript',
  'conversation_initiation_metadata',
  'client_tool_call',
  'agent_tool_response',
  'guardrail_triggered',
] as const;

vi.mock('./requiredClientTools', () => ({
  resolveElevenLabsRequiredClientTools: vi.fn(() => REQUIRED_CLIENT_TOOL_SPECS),
}));

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

  function okVoices(voices: unknown[] = []): Response {
    return okJson({ voices });
  }

  beforeEach(() => {
    vi.resetModules();
    resetRuntimeFetch();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    resetRuntimeFetch();
    globalThis.fetch = originalFetch;
  });

  it('creates an agent using existing client tools when available', async () => {
    const requiredToolSpecs = REQUIRED_CLIENT_TOOL_SPECS;
        const requiredToolNames = requiredToolSpecs.map((s) => s.name);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolSpecs.map(({ name, description }) => ({
            id: `tool_${name}`,
            tool_config: {
              type: 'client',
              name,
              description,
              parameters: { type: 'object', description: 'Parameters', properties: {} },
              expects_response: true,
              execution_mode: 'immediate',
              response_timeout_secs: name === 'spawnSessionPicker' ? 120 : 60,
            },
          })),
        }),
      )
      .mockResolvedValueOnce(okVoices())
      .mockResolvedValueOnce(okJson({ agent_id: 'agent_1' }));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    const result = await createHappierElevenLabsAgent({ apiKey: 'xi_test' });
    expect(result.agentId).toBe('agent_1');

    expect(fetchMock()).toHaveBeenCalledTimes(3);
    expect(fetchMock().mock.calls[0]?.[0]).toContain('/v1/convai/tools');
    expect(fetchMock().mock.calls[1]?.[0]).toContain('/v1/voices');
    expect(fetchMock().mock.calls[2]?.[0]).toContain('/v1/convai/agents/create');

    const body = JSON.parse(fetchMock().mock.calls[2]?.[1]?.body);
    expect(body.conversation_config.agent.prompt.tool_ids).toEqual(requiredToolNames.map((name) => `tool_${name}`));
    expect(body.conversation_config.tts?.voice_id).toBe('EST9Ui6982FZPSi7gCHi');
    expect(body.conversation_config.agent.prompt.prompt).toContain('{{initialConversationContext}}');
    expect(body.conversation_config.agent.prompt.prompt).toContain('{{sessionId}}');
    expect(String(body.conversation_config.agent.prompt.prompt)).not.toMatch(/Claude Code/i);
    expect(body.conversation_config.conversation?.client_events).toEqual([...EXPECTED_CLIENT_EVENTS]);
  });

  it('patches existing client tool schemas when they contain unsupported fields', async () => {
    const requiredToolSpecs = REQUIRED_CLIENT_TOOL_SPECS;
    const requiredToolNames = requiredToolSpecs.map((s) => s.name);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolSpecs.map(({ name, description }) => ({
            id: `tool_${name}`,
            tool_config: {
              type: 'client',
              name,
              description,
              // Historical invalid schema: ElevenLabs rejects JSON-schema `additionalProperties`.
              parameters: { type: 'object', properties: {}, additionalProperties: true },
              expects_response: true,
              execution_mode: 'immediate',
              response_timeout_secs: name === 'spawnSessionPicker' ? 120 : 60,
            },
          })),
        }),
      )
      // One PATCH per tool (ensureClientToolIds)
      .mockImplementation(async (url: string, init?: any) => {
        if (String(url).includes('/v1/convai/tools/') && init?.method === 'PATCH') {
          return okJson({ ok: true });
        }
        if (String(url).includes('/v1/voices')) {
          return okVoices();
        }
        if (String(url).includes('/v1/convai/agents/create')) {
          return okJson({ agent_id: 'agent_1' });
        }
        return okJson({ tools: [] });
      });

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    const result = await createHappierElevenLabsAgent({ apiKey: 'xi_test' });
    expect(result.agentId).toBe('agent_1');

    const patchCalls = fetchMock().mock.calls.filter((call) => String(call?.[0] ?? '').includes('/v1/convai/tools/') && call?.[1]?.method === 'PATCH');
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);

    const body = JSON.parse(String(patchCalls[0]?.[1]?.body ?? '{}'));
    expect(JSON.stringify(body?.tool_config?.parameters ?? {})).not.toContain('additionalProperties');
    expect(body?.tool_config?.expects_response).toBe(true);
    expect(body?.tool_config?.execution_mode).toBe('immediate');

    const createCall = fetchMock().mock.calls.find((call) => String(call?.[0] ?? '').includes('/v1/convai/agents/create'));
    expect(createCall).toBeTruthy();
    const createBody = JSON.parse(String(createCall?.[1]?.body ?? '{}'));
    expect(createBody.conversation_config.agent.prompt.tool_ids).toEqual(requiredToolNames.map((n) => `tool_${n}`));
    expect(createBody.conversation_config.conversation?.client_events).toEqual([...EXPECTED_CLIENT_EVENTS]);
  });

  it('creates missing client tools before creating the agent', async () => {
    const requiredToolNames = REQUIRED_CLIENT_TOOL_SPECS.map((s) => s.name);

    fetchMock().mockResolvedValueOnce(okJson({ tools: [] }));
    for (const name of requiredToolNames) {
      fetchMock().mockResolvedValueOnce(okJson({ id: `tool_${name}` }));
    }
    fetchMock().mockResolvedValueOnce(okVoices());
    fetchMock().mockResolvedValueOnce(okJson({ agent_id: 'agent_1' }));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    const result = await createHappierElevenLabsAgent({ apiKey: 'xi_test' });
    expect(result.agentId).toBe('agent_1');

    expect(fetchMock()).toHaveBeenCalledTimes(requiredToolNames.length + 3);
    expect(fetchMock().mock.calls[1]?.[0]).toContain('/v1/convai/tools');
    expect(fetchMock().mock.calls[2]?.[0]).toContain('/v1/convai/tools');
    expect(fetchMock().mock.calls[requiredToolNames.length + 1]?.[0]).toContain('/v1/voices');
    expect(fetchMock().mock.calls[requiredToolNames.length + 2]?.[0]).toContain('/v1/convai/agents/create');

    const toolCreateBody = JSON.parse(fetchMock().mock.calls[1]?.[1]?.body);
    expect(toolCreateBody.tool_config).toMatchObject({
      type: 'client',
      expects_response: true,
      execution_mode: 'immediate',
      parameters: expect.objectContaining({ type: 'object' }),
    });

    // Review tool schemas must satisfy ElevenLabs validation:
    // leaf parameter schemas require a description, and unions/additionalProperties are rejected.
    const toolCreateBodies = fetchMock()
      .mock.calls
      .filter((call) => String(call?.[0] ?? '').includes('/v1/convai/tools') && call?.[1]?.method === 'POST')
      .map((call) => JSON.parse(String(call?.[1]?.body ?? '{}')));
    const startReview = toolCreateBodies.find((b) => b?.tool_config?.name === 'startReview');
    expect(startReview).toBeTruthy();
    expect(JSON.stringify(startReview?.tool_config?.parameters ?? {})).not.toContain('additionalProperties');
    expect(JSON.stringify(startReview?.tool_config?.parameters ?? {})).not.toContain('oneOf');
    expect(startReview?.tool_config?.parameters?.properties?.sessionId?.description).toBeTruthy();
    expect(startReview?.tool_config?.parameters?.properties?.engineIds?.items?.description).toBeTruthy();

    const spawnPicker = toolCreateBodies.find((b) => b?.tool_config?.name === 'spawnSessionPicker');
    expect(spawnPicker).toBeTruthy();
    expect(Number(spawnPicker?.tool_config?.response_timeout_secs ?? 0)).toBe(120);
  });

  it('updates an existing agent to the latest template', async () => {
    const requiredToolSpecs = REQUIRED_CLIENT_TOOL_SPECS;
        const requiredToolNames = requiredToolSpecs.map((s) => s.name);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolSpecs.map(({ name, description }) => ({
            id: `tool_${name}`,
            tool_config: {
              type: 'client',
              name,
              description,
              parameters: { type: 'object', description: 'Parameters', properties: {} },
              expects_response: true,
              execution_mode: 'immediate',
              response_timeout_secs: name === 'spawnSessionPicker' ? 120 : 60,
            },
          })),
        }),
      )
      .mockResolvedValueOnce(okVoices())
      .mockResolvedValueOnce(okJson({ agent_id: 'agent_1' }));

    const { updateHappierElevenLabsAgent } = await import('./autoprovision');
    await updateHappierElevenLabsAgent({ apiKey: 'xi_test', agentId: 'agent_1' });

    expect(fetchMock().mock.calls[1]?.[0]).toContain('/v1/voices');
    expect(fetchMock().mock.calls[2]?.[0]).toContain('/v1/convai/agents/agent_1');
    expect(fetchMock().mock.calls[2]?.[1]?.method).toBe('PATCH');
    const body = JSON.parse(fetchMock().mock.calls[2]?.[1]?.body);
    expect(body.conversation_config.agent.prompt.tool_ids).toEqual(requiredToolNames.map((name) => `tool_${name}`));
    expect(body.conversation_config.tts?.voice_id).toBe('EST9Ui6982FZPSi7gCHi');
    expect(body.conversation_config.conversation?.client_events).toEqual([...EXPECTED_CLIENT_EVENTS]);
  });

  it('uses provided tts configuration when creating an agent', async () => {
    const requiredToolSpecs = REQUIRED_CLIENT_TOOL_SPECS;
        const requiredToolNames = requiredToolSpecs.map((s) => s.name);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolSpecs.map(({ name, description }) => ({
            id: `tool_${name}`,
            tool_config: {
              type: 'client',
              name,
              description,
              parameters: { type: 'object', description: 'Parameters', properties: {} },
              expects_response: true,
              execution_mode: 'immediate',
              response_timeout_secs: name === 'spawnSessionPicker' ? 120 : 60,
            },
          })),
        }),
      )
      .mockResolvedValueOnce(okVoices())
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

    const body = JSON.parse(fetchMock().mock.calls[2]?.[1]?.body);
    expect(body.conversation_config?.turn?.turn_timeout).toBe(-1);
    expect(body.conversation_config.conversation?.client_events).toEqual([...EXPECTED_CLIENT_EVENTS]);
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
    const requiredToolSpecs = REQUIRED_CLIENT_TOOL_SPECS;
        const requiredToolNames = requiredToolSpecs.map((s) => s.name);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolSpecs.map(({ name, description }) => ({
            id: `tool_${name}`,
            tool_config: {
              type: 'client',
              name,
              description,
              parameters: { type: 'object', description: 'Parameters', properties: {} },
              expects_response: true,
              execution_mode: 'immediate',
              response_timeout_secs: name === 'spawnSessionPicker' ? 120 : 60,
            },
          })),
        }),
      )
      .mockResolvedValueOnce(okVoices())
      .mockResolvedValueOnce(okJson({ agent_id: '' }));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    await expect(createHappierElevenLabsAgent({ apiKey: 'xi_test' })).rejects.toThrow(
      'ElevenLabs create agent did not return an agent_id',
    );
  });

  it('surfaces update failure with sanitized ElevenLabs error', async () => {
    const requiredToolSpecs = REQUIRED_CLIENT_TOOL_SPECS;
        const requiredToolNames = requiredToolSpecs.map((s) => s.name);

    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: requiredToolSpecs.map(({ name, description }) => ({
            id: `tool_${name}`,
            tool_config: {
              type: 'client',
              name,
              description,
              parameters: { type: 'object', description: 'Parameters', properties: {} },
              expects_response: true,
              execution_mode: 'immediate',
              response_timeout_secs: name === 'spawnSessionPicker' ? 120 : 60,
            },
          })),
        }),
      )
      .mockResolvedValueOnce(okVoices())
      .mockResolvedValueOnce(errorResponse(502, 'backend unavailable'));

    const { updateHappierElevenLabsAgent } = await import('./autoprovision');
    await expect(updateHappierElevenLabsAgent({ apiKey: 'xi_test', agentId: 'agent_1' })).rejects.toThrow(
      /ElevenLabs API error \(502\)/,
    );

    const patchCall = fetchMock().mock.calls.find((call) => String(call?.[0] ?? '').includes('/v1/convai/agents/agent_1'));
    expect(patchCall).toBeTruthy();
    expect(patchCall?.[1]?.method).toBe('PATCH');
  });

  it('can discover existing Happier agents on the ElevenLabs account', async () => {
    fetchMock().mockResolvedValueOnce(
      okJson({
        agents: [
          { agent_id: 'agent_a', name: 'Happier Voice' },
          { agent_id: 'agent_b', name: 'Other' },
        ],
      }),
    );

    const { findExistingHappierElevenLabsAgents } = await import('./autoprovision');
    const found = await findExistingHappierElevenLabsAgents({ apiKey: 'xi_test' });

    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(String(fetchMock().mock.calls[0]?.[0])).toContain('/v1/convai/agents');
    expect(found).toEqual([{ agentId: 'agent_a', name: 'Happier Voice' }]);
  });
});
