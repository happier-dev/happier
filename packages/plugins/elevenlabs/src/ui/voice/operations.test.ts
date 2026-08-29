import { describe, expect, it, vi } from 'vitest';

import {
  listElevenLabsVoicesWithAccountOperations,
  mintElevenLabsConversationAuthWithAccountOperations,
  provisionElevenLabsWithAccountOperations,
} from './operations';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
  ElevenLabsVoiceProviderSettingsSchema,
} from '../../protocol/voice/index.js';

function createProvisionTtsSettings() {
  return ElevenLabsVoiceProviderSettingsSchema.parse({
    ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
    tts: {
      voiceId: 'voice_1',
      modelId: null,
      voiceSettings: {
        stability: 0.4,
        similarityBoost: 0.8,
        speed: 1.1,
      },
    },
  }).tts;
}

/** The bound account owns `voice_1`, which every provisioning fixture selects. */
const ACCOUNT_VOICE_CATALOG = Object.freeze({
  voices: [{ voice_id: 'voice_1', name: 'Voice One' }],
});

const EXACT_SEND_MESSAGE_TOOL_CONFIG = Object.freeze({
  tool_error_handling_mode: 'passthrough',
  tool_call_sound_behavior: 'auto',
  pre_tool_speech: 'auto',
  interruption_mode: 'allow',
  response_timeout_secs: 60,
  execution_mode: 'immediate',
  expects_response: true,
  parameters: { properties: {}, type: 'object' },
  description: 'Send a message.',
  name: 'sendMessage',
  type: 'client',
});

/**
 * Obviously synthetic: a voice the bound account cannot resolve. It must never
 * coincide with the shipped default, or "the default provisions cleanly" and
 * "an unknown voice is refused" stop being distinguishable — the exact
 * collision that let an unresolvable shipped default go unnoticed.
 */
const NOT_OWNED_VOICE_ID = 'voice_id_not_in_account_fixture';

/**
 * ElevenLabs' standard premade set, which every account resolves. Measured live
 * against a BYO account (`GET /v1/voices`, 2026-08-08): every entry came back
 * `category: 'premade'`, `hpp4J3VqNfWAUOO0d1Us` ("Bella") was present, and the
 * previously shipped default `EST9Ui6982FZPSi7gCHi` was absent from the whole
 * catalog. The default voice id is written out literally on purpose: deriving
 * it from the manifest would make the catalog agree with any default at all.
 */
const PREMADE_ACCOUNT_VOICE_CATALOG = Object.freeze({
  voices: [
    { voice_id: 'voice_id_other_premade_fixture', name: 'Another premade voice', category: 'premade' },
    { voice_id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Bella - Professional, Bright, Warm', category: 'premade' },
  ],
});

describe('ElevenLabs public account operations', () => {
  it('finds an existing Happier Voice agent on a later catalog page', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const cursor = (input.parameters as Readonly<{ cursor?: unknown }>).cursor;
      const body = cursor === 'agents_page_2'
        ? {
            agents: [{ agent_id: 'agent_existing', name: 'Happier Voice' }],
            has_more: false,
            next_cursor: null,
          }
        : {
            agents: Array.from({ length: 50 }, (_, index) => ({
              agent_id: `unrelated_${index}`,
              name: `Unrelated ${index}`,
            })),
            has_more: true,
            next_cursor: 'agents_page_2',
          };
      return Object.freeze({
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: { kind: 'list' },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      ok: true,
      agents: [{ agentId: 'agent_existing', name: 'Happier Voice' }],
    });
    expect(calls.map((call) => call.operationId)).toEqual(['agents', 'agents']);
    expect(calls[0]?.parameters).toEqual({});
    expect(calls[1]?.parameters).toEqual({ cursor: 'agents_page_2' });
  });

  it.each([
    ['a missing next cursor', (_callCount: number) => ({ agents: [], has_more: true, next_cursor: null }), 1],
    ['a repeated next cursor', (_callCount: number) => ({
      agents: [],
      has_more: true,
      next_cursor: 'same_cursor',
    }), 2],
  ] as const)('rejects %s before exposing an incomplete agent catalog', async (_label, page, expectedCalls) => {
    let callCount = 0;
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => {
      const body = page(callCount);
      callCount += 1;
      return Object.freeze({
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: { kind: 'list' },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'list_agents',
    });
    expect(request).toHaveBeenCalledTimes(expectedCalls);
  });

  it('rejects an unbounded paginated agent catalog after the shared page ceiling', async () => {
    let callCount = 0;
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => {
      const body = {
        agents: [],
        has_more: true,
        next_cursor: `cursor_${callCount++}`,
      };
      return Object.freeze({
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: { kind: 'list' },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'list_agents',
    });
    expect(request).toHaveBeenCalledTimes(100);
  });

  it('provisions through the public bounded GET, POST, and PATCH account operations', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const bodies: Readonly<Record<string, unknown>> = {
        voices: ACCOUNT_VOICE_CATALOG,
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
        name: 'spawnSession',
        description: 'Create a session.',
        parameters: { type: 'object', properties: {} },
      }, {
        name: 'sendMessage',
        description: 'Send a message.',
        parameters: { type: 'object', properties: {} },
      }],
      tts: createProvisionTtsSettings(),
    };

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: provisionRequest,
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, agentId: 'agent_1' });
    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'create-tool',
      'create-tool',
      'create-agent',
    ]);
    expect(calls[1]?.parameters).toMatchObject({
      body: {
        tool_config: {
          name: 'spawnSession',
          response_timeout_secs: 120,
        },
      },
    });
    expect(calls[2]?.parameters).toMatchObject({
      body: {
        tool_config: {
          name: 'sendMessage',
          response_timeout_secs: 60,
        },
      },
    });
    expect(calls[3]?.parameters).toMatchObject({
      body: {
        name: 'Happier Voice',
        conversation_config: {
          tts: {
            voice_id: 'voice_1',
            stability: 0.4,
            similarity_boost: 0.8,
            speed: 1.1,
          },
        },
      },
    });
    const createAgentParameters = calls[3]?.parameters as Readonly<{
      body?: Readonly<{
        conversation_config?: Readonly<{
          turn?: unknown;
          tts?: Readonly<{ voice_settings?: unknown }>;
        }>;
      }>;
    }>;
    expect(createAgentParameters.body?.conversation_config).not.toHaveProperty('turn');
    expect(createAgentParameters.body?.conversation_config?.tts).not.toHaveProperty('voice_settings');
    expect(createAgentParameters.body?.conversation_config?.tts).not.toHaveProperty('style');
    expect(createAgentParameters.body?.conversation_config?.tts).not.toHaveProperty('use_speaker_boost');
    expect(JSON.stringify(createAgentParameters)).not.toMatch(
      /"(?:style|useSpeakerBoost|use_speaker_boost|voice_settings)"/u,
    );
    expect(calls.some((call) => (
      call.parameters != null
      && typeof call.parameters === 'object'
      && ('method' in call.parameters || 'url' in call.parameters)
    ))).toBe(false);
  });

  it('creates isolated tools instead of patching matching workspace tools for a new agent', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const bodies: Readonly<Record<string, unknown>> = {
        voices: ACCOUNT_VOICE_CATALOG,
        tools: {
          tools: [{
            id: 'tool_shared',
            tool_config: { type: 'client', name: 'sendMessage' },
          }],
        },
        'create-tool': { id: 'tool_created' },
        'create-agent': { agent_id: 'agent_created' },
      };
      return Object.freeze({
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(bodies[input.operationId] ?? {})),
      });
    });

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'create',
        prompt: 'Create a separate Happier Voice agent.',
        tools: [{
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: createProvisionTtsSettings(),
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, agentId: 'agent_created' });

    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'create-tool',
      'create-agent',
    ]);
    expect(calls[2]?.parameters).toMatchObject({
      body: {
        conversation_config: {
          agent: { prompt: { tool_ids: ['tool_created'] } },
        },
      },
    });
  });

  it('copy-on-writes a changed selected-agent dependency without mutating either shared tool', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const bodies: Readonly<Record<string, unknown>> = {
        voices: ACCOUNT_VOICE_CATALOG,
        agent: {
          agent_id: 'agent_selected',
          conversation_config: {
            agent: { prompt: { tool_ids: ['tool_selected'] } },
          },
        },
        tools: {
          tools: [
            {
              id: 'tool_other_agent',
              tool_config: { type: 'client', name: 'sendMessage' },
            },
            {
              id: 'tool_selected',
              tool_config: { type: 'client', name: 'sendMessage' },
            },
          ],
        },
        'create-tool': { id: 'tool_replacement' },
        'update-agent': {},
      };
      return Object.freeze({
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(bodies[input.operationId] ?? {})),
      });
    });

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'update',
        agentId: 'agent_selected',
        prompt: 'Keep helping.',
        tools: [{
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: createProvisionTtsSettings(),
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, updated: true });

    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'agent',
      'tools',
      'create-tool',
      'update-agent',
    ]);
    expect(calls[3]?.parameters).toMatchObject({
      body: { tool_config: { name: 'sendMessage', description: 'Send a message.' } },
    });
    expect(calls[4]?.parameters).toMatchObject({
      agentId: 'agent_selected',
      body: { conversation_config: { agent: { prompt: { tool_ids: ['tool_replacement'] } } } },
    });
  });

  it('reuses an exact selected-agent dependency and only updates the agent', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters?: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters?: unknown;
    }>) => {
      calls.push(input);
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'agent'
          ? {
              agent_id: 'agent_existing',
              conversation_config: {
                agent: { prompt: { tool_ids: ['tool_existing'] } },
              },
            }
        : input.operationId === 'tools'
          ? { tools: [{ id: 'tool_existing', tool_config: EXACT_SEND_MESSAGE_TOOL_CONFIG }] }
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
        tts: createProvisionTtsSettings(),
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, updated: true });
    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'agent',
      'tools',
      'update-agent',
    ]);
    expect(calls.some((call) => call.operationId === 'create-tool')).toBe(false);
    const updateAgentParameters = calls[3]?.parameters as Readonly<{
      body?: Readonly<{
        conversation_config?: Readonly<{ turn?: unknown }>;
      }>;
    }>;
    expect(updateAgentParameters.body?.conversation_config).not.toHaveProperty('turn');
    expect(updateAgentParameters.body?.conversation_config).toMatchObject({
      tts: { stability: 0.4, similarity_boost: 0.8, speed: 1.1 },
    });
    expect(JSON.stringify(updateAgentParameters)).not.toMatch(
      /"(?:style|useSpeakerBoost|use_speaker_boost|voice_settings)"/u,
    );
  });

  it('reuses an existing Happier client tool from a later tools page', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'agent'
          ? {
              agent_id: 'agent_existing',
              conversation_config: {
                agent: { prompt: { tool_ids: ['tool_existing'] } },
              },
            }
        : input.operationId === 'tools'
        ? (
            (input.parameters as Readonly<{ cursor?: unknown }>).cursor === 'tools_page_2'
              ? {
                  tools: [{
                    id: 'tool_existing',
                    tool_config: EXACT_SEND_MESSAGE_TOOL_CONFIG,
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
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, updated: true });

    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'agent',
      'tools',
      'tools',
      'update-agent',
    ]);
    expect(calls[2]?.parameters).toEqual({});
    expect(calls[3]?.parameters).toEqual({ cursor: 'tools_page_2' });
    expect(calls.some((call) => call.operationId === 'create-tool')).toBe(false);
  });

  it('rejects malformed tool pagination before mutating provider objects', async () => {
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => ({
      status: 200,
      finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'agent'
          ? {
              agent_id: 'agent_existing',
              conversation_config: {
                agent: { prompt: { tool_ids: ['tool_existing'] } },
              },
            }
        : input.operationId === 'tools'
          ? { tools: [], has_more: true, next_cursor: null }
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
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'list_tools',
    });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: 'tools' }));
  });

  it('uses the current preferred ElevenLabs client-tool DTO', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'tools'
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
      status: input.operationId === 'update-agent' ? 422 : 200,
      finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'agent'
          ? {
              agent_id: 'agent_existing',
              conversation_config: {
                agent: { prompt: { tool_ids: ['tool_existing'] } },
              },
            }
        : input.operationId === 'tools'
          ? {
              tools: [{
                id: 'tool_existing',
                tool_config: EXACT_SEND_MESSAGE_TOOL_CONFIG,
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
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'update_agent',
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'update-agent',
    }));
  });

  it('retains created tools when create-agent may have committed before returning a malformed success', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    let createdToolCount = 0;
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'create-tool'
          ? { id: `tool_created_${++createdToolCount}` }
          : {};
      return Object.freeze({
        // The provider accepted and applied the agent write, but its success
        // response cannot be decoded by this client.
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: input.operationId === 'create-agent'
          ? new TextEncoder().encode('{')
          : new TextEncoder().encode(JSON.stringify(body)),
      });
    });

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'create',
        prompt: 'Create a Happier Voice agent.',
        tools: [{
          name: 'spawnSession',
          description: 'Create a session.',
          parameters: { type: 'object', properties: {} },
        }, {
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: createProvisionTtsSettings(),
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'create_agent',
      cleanupIncomplete: true,
    });

    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'create-tool',
      'create-tool',
      'create-agent',
    ]);
  });

  it('marks cleanup incomplete without deleting after a 2xx tool create returns no usable id', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'create-tool'
          ? { id: '   ' }
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
        kind: 'create',
        prompt: 'Create a Happier Voice agent.',
        tools: [{
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: createProvisionTtsSettings(),
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'create_tool',
      cleanupIncomplete: true,
    });

    expect(calls.map((call) => call.operationId)).toEqual(['voices', 'create-tool']);
  });

  it('retains copy-on-write tools when update-agent may have committed before returning a malformed success', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    let createdToolCount = 0;
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'agent'
          ? {
              agent_id: 'agent_existing',
              conversation_config: {
                agent: { prompt: { tool_ids: ['tool_existing'] } },
              },
            }
          : input.operationId === 'tools'
            ? {
                tools: [{
                  id: 'tool_existing',
                  tool_config: { type: 'client', name: 'sendMessage' },
                }],
                has_more: false,
                next_cursor: null,
              }
            : input.operationId === 'create-tool'
              ? { id: `tool_created_${++createdToolCount}` }
              : {};
      return Object.freeze({
        // A 2xx update may already have published these tool ids even though
        // the response body cannot be decoded by this client.
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: input.operationId === 'update-agent'
          ? new TextEncoder().encode('{')
          : new TextEncoder().encode(JSON.stringify(body)),
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
        }, {
          name: 'spawnSession',
          description: 'Create a session.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: createProvisionTtsSettings(),
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'update_agent',
      cleanupIncomplete: true,
    });

    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'agent',
      'tools',
      'create-tool',
      'create-tool',
      'update-agent',
    ]);
    expect(calls.some((call) => (
      call.operationId === 'delete-tool'
      && (call.parameters as Readonly<{ toolId?: unknown }>).toolId === 'tool_existing'
    ))).toBe(false);
  });

  it('marks cleanup incomplete without deleting when the account-operation authority is already cancelled', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => {
      calls.push(input.operationId);
      if (input.operationId === 'create-agent') controller.abort();
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'create-tool'
          ? { id: 'tool_created' }
          : {};
      return Object.freeze({
        status: input.operationId === 'create-agent' ? 422 : 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });

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
        tts: createProvisionTtsSettings(),
      },
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'create_agent',
      cleanupIncomplete: true,
    });

    expect(calls).toEqual(['voices', 'create-tool', 'create-agent']);
  });

  it('marks cleanup incomplete without deleting when the account-operation authority retires without aborting its signal', async () => {
    const calls: string[] = [];
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => {
      calls.push(input.operationId);
      if (input.operationId === 'create-agent') {
        throw Object.assign(new Error('voice_account_operation_cancelled'), {
          code: 'voice_account_operation_cancelled',
        });
      }
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'create-tool'
          ? { id: 'tool_created' }
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
        kind: 'create',
        prompt: 'Create a Happier Voice agent.',
        tools: [{
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: createProvisionTtsSettings(),
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'voice_account_operation_cancelled',
      stage: 'create_agent',
      cleanupIncomplete: true,
    });

    expect(calls).toEqual(['voices', 'create-tool', 'create-agent']);
  });

  it('marks cleanup incomplete and stops deleting when authority is lost during pre-final-write cleanup', async () => {
    const controller = new AbortController();
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    let createdToolCount = 0;
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      if (input.operationId === 'delete-tool'
        && (input.parameters as Readonly<{ toolId?: unknown }>).toolId === 'tool_created_2') {
        controller.abort();
      }
      const thirdToolCreate = input.operationId === 'create-tool' && createdToolCount === 2;
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'create-tool'
          ? { id: `tool_created_${++createdToolCount}` }
          : {};
      return Object.freeze({
        status: thirdToolCreate ? 422 : 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'create',
        prompt: 'Create a Happier Voice agent.',
        tools: [{
          name: 'spawnSession',
          description: 'Create a session.',
          parameters: { type: 'object', properties: {} },
        }, {
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }, {
          name: 'requestHumanApproval',
          description: 'Request approval.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: createProvisionTtsSettings(),
      },
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'create_tool',
      cleanupIncomplete: true,
    });

    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'create-tool',
      'create-tool',
      'create-tool',
      'delete-tool',
    ]);
    expect(calls.at(-1)?.parameters).toEqual({ toolId: 'tool_created_2' });
  });

  it('stops further deletes when cleanup reports account-operation retirement before the final agent write', async () => {
    const controller = new AbortController();
    const calls: Array<Readonly<{ operationId: string; parameters: unknown }>> = [];
    let createdToolCount = 0;
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters: unknown;
    }>) => {
      calls.push(input);
      if (input.operationId === 'delete-tool'
        && (input.parameters as Readonly<{ toolId?: unknown }>).toolId === 'tool_created_2') {
        throw Object.assign(new Error('voice_account_operation_cancelled'), {
          code: 'voice_account_operation_cancelled',
        });
      }
      const thirdToolCreate = input.operationId === 'create-tool' && createdToolCount === 2;
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'create-tool'
          ? { id: `tool_created_${++createdToolCount}` }
          : {};
      return Object.freeze({
        status: thirdToolCreate ? 422 : 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: {
        kind: 'create',
        prompt: 'Create a Happier Voice agent.',
        tools: [{
          name: 'spawnSession',
          description: 'Create a session.',
          parameters: { type: 'object', properties: {} },
        }, {
          name: 'sendMessage',
          description: 'Send a message.',
          parameters: { type: 'object', properties: {} },
        }, {
          name: 'requestHumanApproval',
          description: 'Request approval.',
          parameters: { type: 'object', properties: {} },
        }],
        tts: createProvisionTtsSettings(),
      },
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'create_tool',
      cleanupIncomplete: true,
    });

    expect(controller.signal.aborted).toBe(false);
    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'create-tool',
      'create-tool',
      'create-tool',
      'delete-tool',
    ]);
    expect(calls.at(-1)?.parameters).toEqual({ toolId: 'tool_created_2' });
  });

  it('refuses to provision a voice the bound account does not own, before any provider write', async () => {
    const calls: string[] = [];
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => {
      calls.push(input.operationId);
      const body = input.operationId === 'voices'
        ? { voices: [{ voice_id: 'SAz9YHcvj6GT2YYXdXww', name: 'Present in this account' }] }
        : input.operationId === 'tools'
          ? { tools: [], has_more: false, next_cursor: null }
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
          // Persisted from a previous ElevenLabs account; the bound API key's
          // account has no such voice, so the agent write is already doomed.
          voiceId: NOT_OWNED_VOICE_ID,
          modelId: null,
          voiceSettings: { stability: null, similarityBoost: null, speed: null },
        },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_not_found', stage: 'validate_voice' });

    // No tool was created or patched: the partial-write window never opens.
    expect(calls).toEqual(['voices']);
  });

  it('provisions with the shipped default voice against the standard premade catalog', async () => {
    const calls: string[] = [];
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => {
      calls.push(input.operationId);
      const bodies: Readonly<Record<string, unknown>> = {
        voices: PREMADE_ACCOUNT_VOICE_CATALOG,
        tools: { tools: [], has_more: false, next_cursor: null },
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

    // A BYO user who never opens the voice picker provisions with exactly these
    // settings, so a default the account cannot resolve fails every such user.
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
        tts: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts,
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, agentId: 'agent_1' });
    expect(calls).toEqual(['voices', 'create-tool', 'create-agent']);
  });

  it('keeps the shipped default voice distinct from the not-owned fixture', () => {
    const defaultVoiceId = ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceId;
    expect(defaultVoiceId).not.toBe(NOT_OWNED_VOICE_ID);
    expect(PREMADE_ACCOUNT_VOICE_CATALOG.voices.map((voice) => voice.voice_id))
      .not.toContain(NOT_OWNED_VOICE_ID);
    expect(PREMADE_ACCOUNT_VOICE_CATALOG.voices.map((voice) => voice.voice_id))
      .toContain(defaultVoiceId);
  });

  it('reports an unreadable voice catalog as an invalid provider response, not a missing voice', async () => {
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => ({
      status: 200,
      finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({})),
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
          voiceSettings: { stability: null, similarityBoost: null, speed: null },
        },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'validate_voice',
    });
    expect(request).toHaveBeenCalledTimes(1);
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

  it('separates a real empty account catalog from a malformed voices payload', async () => {
    const respond = (payload: unknown) => vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://api.elevenlabs.io/v1/voices',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(payload)),
    }));

    await expect(listElevenLabsVoicesWithAccountOperations({
      accountOperations: Object.freeze({ request: respond({ voices: [] }) }),
      signal: new AbortController().signal,
    })).resolves.toEqual([]);

    for (const malformed of [{}, { voices: null }, { voices: { v1: 'Alpha' } }, []]) {
      await expect(listElevenLabsVoicesWithAccountOperations({
        accountOperations: Object.freeze({ request: respond(malformed) }),
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    }
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
      connectionType: 'websocket',
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
      connectionType: 'websocket',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      message: 'credential_unavailable',
    });
  });

  it('uses signed-url auth only when the preparation owner selects WebSocket', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_1',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ signed_url: 'wss://provider.test/session' })),
    }));

    await expect(mintElevenLabsConversationAuthWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      agentId: 'agent_1',
      connectionType: 'websocket',
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'signed_url', value: 'wss://provider.test/session' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'signed-url' }));
  });
});
