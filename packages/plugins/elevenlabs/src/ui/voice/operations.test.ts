import { describe, expect, it, vi } from 'vitest';

import {
  listElevenLabsVoicesWithAccountOperations,
  mintElevenLabsConversationAuthWithAccountOperations,
  provisionElevenLabsWithAccountOperations,
} from './operations';
import { VOICE_PROVIDER_PRESENTATIONS } from './index';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../protocol/voice/index.js';

function migrateLegacyProvisionTts() {
  const migrated = VOICE_PROVIDER_PRESENTATIONS[0].legacySettingsMigration.migrateLegacy({
    billingMode: 'byo',
    tts: {
      voiceId: 'voice_1',
      modelId: null,
      voiceSettings: {
        stability: 0.4,
        similarityBoost: 0.8,
        style: 0.35,
        useSpeakerBoost: true,
        speed: 1.1,
      },
    },
    byo: { agentId: 'agent_existing', apiKey: null },
  });
  if (!migrated) throw new Error('expected_legacy_elevenlabs_settings_to_migrate');
  expect(migrated.config.tts.voiceSettings).not.toHaveProperty('style');
  expect(migrated.config.tts.voiceSettings).not.toHaveProperty('useSpeakerBoost');
  return migrated.config.tts;
}

/** The bound account owns `voice_1`, which every provisioning fixture selects. */
const ACCOUNT_VOICE_CATALOG = Object.freeze({
  voices: [{ voice_id: 'voice_1', name: 'Voice One' }],
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
      tts: migrateLegacyProvisionTts(),
    };

    await expect(provisionElevenLabsWithAccountOperations({
      accountOperations: Object.freeze({ request }),
      request: provisionRequest,
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, agentId: 'agent_1' });
    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'tools',
      'create-tool',
      'create-tool',
      'create-agent',
    ]);
    expect(calls[2]?.parameters).toMatchObject({
      body: {
        tool_config: {
          name: 'spawnSession',
          response_timeout_secs: 120,
        },
      },
    });
    expect(calls[3]?.parameters).toMatchObject({
      body: {
        tool_config: {
          name: 'sendMessage',
          response_timeout_secs: 60,
        },
      },
    });
    expect(calls[4]?.parameters).toMatchObject({
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
    const createAgentParameters = calls[4]?.parameters as Readonly<{
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

  it('updates existing tools and the agent only through the declared PATCH operations', async () => {
    const calls: Array<Readonly<{ operationId: string; parameters?: unknown }>> = [];
    const request = vi.fn(async (input: Readonly<{
      operationId: string;
      parameters?: unknown;
    }>) => {
      calls.push(input);
      const body = input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'tools'
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
        tts: migrateLegacyProvisionTts(),
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, updated: true });
    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'tools',
      'update-tool',
      'update-agent',
    ]);
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
        : input.operationId === 'tools'
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
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, updated: true });

    expect(calls.map((call) => call.operationId)).toEqual([
      'voices',
      'tools',
      'tools',
      'update-tool',
      'update-agent',
    ]);
    expect(calls[1]?.parameters).toEqual({});
    expect(calls[2]?.parameters).toEqual({ cursor: 'tools_page_2' });
    expect(calls.some((call) => call.operationId === 'create-tool')).toBe(false);
  });

  it('rejects malformed tool pagination before mutating provider objects', async () => {
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => ({
      status: 200,
      finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'tools'
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
            speed: null,
          },
        },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_response_invalid',
      stage: 'list_tools',
    });

    expect(request).toHaveBeenCalledTimes(2);
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
      status: input.operationId === 'update-tool' ? 422 : 200,
      finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(input.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : input.operationId === 'tools'
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
    expect(calls).toEqual(['voices', 'tools', 'create-tool', 'create-agent']);
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
