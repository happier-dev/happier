import { describe, expect, it, vi } from 'vitest';

import {
  listElevenLabsVoicesWithAccountOperations,
  mintElevenLabsConversationAuthWithAccountOperations,
  provisionElevenLabsWithAccountOperations,
} from './providerOperations';

describe('ElevenLabs public account operations', () => {
  it('provisions through the public bounded GET, POST, and PATCH account operations', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const bodies: Readonly<Record<string, unknown>> = {
        agents: { agents: [] },
        tools: { tools: [] },
        'create-tool': { id: 'tool_1' },
        'create-agent': { agent_id: 'agent_1' },
      };
      return Object.freeze({
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(bodies[input.operationId] ?? {})),
      });
    });
    const provisionRequest = {
      kind: 'create' as const,
      prompt: 'Create a Happier Voice agent.',
      tools: [{
        name: 'sendMessage',
        description: 'Send a message.',
        parameters: { type: 'object', properties: {} },
      }],
      tts: {
        voiceId: 'voice_1',
        modelId: null,
        voiceSettings: {
          stability: null,
          similarityBoost: null,
          style: null,
          useSpeakerBoost: null,
          speed: null,
        },
      },
    };

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: provisionRequest,
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, agentId: 'agent_1' });
    expect(calls.map((call) => call.operationId)).toEqual([
      'tools',
      'create-tool',
      'create-agent',
    ]);
    expect(calls[1]?.parameters).toMatchObject({
      body: { tool_config: { name: 'sendMessage' } },
    });
    expect(calls[2]?.parameters).toMatchObject({
      body: { name: 'Happier Voice' },
    });
    expect(calls.some((call) => (
      call.parameters != null
      && typeof call.parameters === 'object'
      && ('method' in call.parameters || 'url' in call.parameters)
    ))).toBe(false);
  });

  it('updates existing tools and the agent only through the declared PATCH operations', async () => {
    const operationIds: string[] = [];
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => {
      operationIds.push(input.operationId);
      const body = input.operationId === 'tools'
        ? { tools: [{ id: 'tool_existing', tool_config: { type: 'client', name: 'sendMessage' } }] }
        : {};
      return Object.freeze({
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'update',
        agentId: 'agent_existing',
        prompt: 'Keep helping.',
        tools: [{
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: {
          voiceId: 'voice_1',
          modelId: null,
          voiceSettings: {
            stability: null,
            similarityBoost: null,
            style: null,
            useSpeakerBoost: null,
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, updated: true });
    expect(operationIds).toEqual(['tools', 'update-tool', 'update-agent']);
  });

  it('reuses an existing Happier client tool from a later tools page', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const body = input.operationId === 'tools'
        ? (
            (input.parameters as Readonly<{ cursor?: unknown }>).cursor === 'tools_page_2'
              ? {
                  tools: [{
                    id: 'tool_existing',
                    tool_config: { type: 'client', name: 'sendMessage' },
                  }],
                  has_more: false,
                  next_cursor: null,
                }
              : {
                  tools: Array.from({ length: 30 }, (_, index) => ({
                    id: `unrelated_${index}`,
                    tool_config: { type: 'client', name: `unrelated${index}` },
                  })),
                  has_more: true,
                  next_cursor: 'tools_page_2',
                }
          )
        : {};
      return Object.freeze({
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'update',
        agentId: 'agent_existing',
        prompt: 'Keep helping.',
        tools: [{
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: {
          voiceId: 'voice_1',
          modelId: null,
          voiceSettings: {
            stability: null,
            similarityBoost: null,
            style: null,
            useSpeakerBoost: null,
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, updated: true });

    expect(calls.map((call) => call.operationId)).toEqual([
      'tools',
      'tools',
      'update-tool',
      'update-agent',
    ]);
    expect(calls[0]?.parameters).toEqual({});
    expect(calls[1]?.parameters).toEqual({ cursor: 'tools_page_2' });
    expect(calls.some((call) => call.operationId === 'create-tool')).toBe(false);
  });

  it('rejects malformed tool pagination before mutating provider objects', async () => {
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => ({
      status: 200,
      finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(input.operationId === 'tools'
        ? { tools: [], has_more: true, next_cursor: null }
        : {})),
    }));

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'create',
        prompt: 'Create a Happier Voice agent.',
        tools: [{
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: {
          voiceId: 'voice_1',
          modelId: null,
          voiceSettings: {
            stability: null,
            similarityBoost: null,
            style: null,
            useSpeakerBoost: null,
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'list_tools',
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'tools' }));
  });

  it('uses the current preferred ElevenLabs client-tool DTO', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const body = input.operationId === 'tools'
        ? { tools: [], has_more: false, next_cursor: null }
        : input.operationId === 'create-tool'
          ? { id: 'tool_1' }
          : input.operationId === 'create-agent'
            ? { agent_id: 'agent_1' }
            : {};
      return Object.freeze({
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });

    await provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'create',
        prompt: 'Create a Happier Voice agent.',
        tools: [{
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: {
          voiceId: 'voice_1',
          modelId: null,
          voiceSettings: {
            stability: null,
            similarityBoost: null,
            style: null,
            useSpeakerBoost: null,
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    });

    const createTool = calls.find((call) => call.operationId === 'create-tool');
    expect(createTool?.parameters).toMatchObject({
      body: {
        tool_config: {
          interruption_mode: 'allow',
          pre_tool_speech: 'auto',
          tool_error_handling_mode: 'passthrough',
        },
      },
    });
    expect(createTool?.parameters).not.toMatchObject({
      body: {
        tool_config: {
          disable_interruptions: expect.anything(),
          force_pre_tool_speech: expect.anything(),
        },
      },
    });
  });

  it('attributes provider failures to a bounded provisioning stage', async () => {
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => ({
      status: input.operationId === 'update-tool' ? 422 : 200,
      finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(input.operationId === 'tools'
        ? {
            tools: [{
              id: 'tool_existing',
              tool_config: { type: 'client', name: 'sendMessage' },
            }],
            has_more: false,
            next_cursor: null,
          }
        : {})),
    }));

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'update',
        agentId: 'agent_existing',
        prompt: 'Keep helping.',
        tools: [{
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: {
          voiceId: 'voice_1',
          modelId: null,
          voiceSettings: {
            stability: null,
            similarityBoost: null,
            style: null,
            useSpeakerBoost: null,
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'update_tool',
    });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'update-agent',
    }));
  });

  it('rejects an oversized schema-valid provision request before touching the provider', async () => {
    const request = vi.fn();

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'create',
        prompt: 'Create a Happier Voice agent.',
        tools: [{
          name: 'oversizedTool',
          description: 'Schema-valid tool with an oversized nested parameter.',
          parameters: {
            properties: {
              oversized: { type: 'string', description: 'x'.repeat(512_001) },
            },
          },
        }],
        tts: {
          voiceId: 'voice_1',
          modelId: null,
          voiceSettings: {
            stability: null,
            similarityBoost: null,
            style: null,
            useSpeakerBoost: null,
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'invalid_parameters' });
    expect(request).not.toHaveBeenCalled();
  });

  it('sanitizes catalog metadata returned by the bounded voices operation', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://api.elevenlabs.io/v1/voices',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        voices: [
          { voice_id: 'v2', name: 'Beta', category: 'premade', preview_url: 'https://cdn.example/b.mp3' },
          { voice_id: 'v1', name: 'Alpha', labels: { accent: 'neutral' } },
          {
            voice_id: 'v3',
            name: 'Canonical fields win',
            category: 'premade',
            preview_url: 'https://cdn.example/c.mp3',
            labels: {
              accent: 'neutral',
              category: 'spoofed',
              previewUrl: 'file:///etc/passwd',
            },
          },
          {
            voice_id: 'local-file',
            name: 'Unsafe local file',
            preview_url: 'file:///etc/passwd',
            labels: { previewUrl: 'file:///etc/passwd', category: 'spoofed', accent: 'kept' },
          },
          { voice_id: '', name: 'invalid' },
        ],
      })),
    }));

    await expect(listElevenLabsVoicesWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      signal: new AbortController().signal,
    })).resolves.toEqual([
      { id: 'v1', name: 'Alpha', metadata: { accent: 'neutral' } },
      { id: 'v2', name: 'Beta', metadata: { category: 'premade', previewUrl: 'https://cdn.example/b.mp3' } },
      {
        id: 'v3',
        name: 'Canonical fields win',
        metadata: { accent: 'neutral', category: 'premade', previewUrl: 'https://cdn.example/c.mp3' },
      },
      { id: 'local-file', name: 'Unsafe local file', metadata: { accent: 'kept' } },
    ]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'voices',
      parameters: {},
    }));
  });

  it('rejects an unsafe signed-url artifact returned by the bounded auth operation', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_1',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ signed_url: 'file:///tmp/provider-controlled' })),
    }));

    await expect(mintElevenLabsConversationAuthWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      agentId: 'agent_1',
      textOnly: true,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('classifies an unauthorized bounded account operation as unavailable credentials', async () => {
    const request = vi.fn(async () => ({
      status: 401,
      finalUrl: 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_1',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('private provider response'),
    }));

    await expect(mintElevenLabsConversationAuthWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      agentId: 'agent_1',
      textOnly: true,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      message: 'credential_unavailable',
    });
  });
});
