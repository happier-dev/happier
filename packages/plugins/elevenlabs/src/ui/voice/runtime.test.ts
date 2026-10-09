import { describe, expect, it, vi } from 'vitest';
import type {
  VoiceClientToolDefinition,
  VoiceRealtimeConnection,
  VoiceRealtimeJsonValue,
} from '@happier-dev/plugin-sdk/voice/client';
import { VoiceRealtimeJsonValueSchema } from '@happier-dev/plugin-sdk/voice/client';

import {
  activate,
  createElevenLabsVoiceProviderRuntime,
} from './runtime.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../protocol/voice/index.js';

/** The bound account owns the default voice these settings fixtures select. */
const ACCOUNT_VOICE_CATALOG = Object.freeze({
  voices: [{
    voice_id: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceId,
    name: 'Default Happier Voice',
  }],
});

/** Persist provider writes at the HTTP boundary so setup verifies the actual remote configuration. */
function provisionAccountRequest<T extends Readonly<{ operationId: string; parameters?: unknown }>>(
  respond: (input: T) => Promise<Readonly<{ status: number; finalUrl: string; headers: Readonly<Record<string, string>>; body: Uint8Array }>>,
) {
  let writtenAgent: Record<string, unknown> | null = null;
  return vi.fn(async (input: T) => {
    const response = await respond(input);
    if (response.status !== 200) return response;
    const parameters = input.parameters as Readonly<{ agentId?: string; body?: Record<string, unknown> }> | undefined;
    if (input.operationId === 'create-agent' || input.operationId === 'update-agent') {
      const result = JSON.parse(new TextDecoder().decode(response.body)) as Readonly<{ agent_id?: string }>;
      const agentId = input.operationId === 'create-agent' ? result.agent_id : parameters?.agentId;
      if (agentId && parameters?.body) writtenAgent = { ...parameters.body, agent_id: agentId };
    }
    if (input.operationId === 'agent' && writtenAgent?.agent_id === parameters?.agentId) {
      return { ...response, body: new TextEncoder().encode(JSON.stringify(writtenAgent)) };
    }
    return response;
  });
}

const HOST_NORMALIZED_TOOLS: readonly VoiceClientToolDefinition[] = Object.freeze([Object.freeze({
  name: 'hostListMachines',
  description: 'Host-normalized machine inventory',
  parameters: Object.freeze({
    type: 'object' as const,
    additionalProperties: false,
    properties: Object.freeze({
      limit: Object.freeze({ type: 'integer' as const, minimum: 1, maximum: 10 }),
    }),
    required: Object.freeze(['limit']),
  }),
  execute: async () => Object.freeze({ ok: true }),
})]);

const sdk = vi.hoisted(() => ({
  startSession: vi.fn(),
  endSession: vi.fn(async () => undefined),
  setMicMuted: vi.fn(),
  setVolume: vi.fn(),
  sendUserMessage: vi.fn(),
  sendContextualUpdate: vi.fn(),
  getId: vi.fn(() => 'conversation-1'),
}));

vi.mock('@elevenlabs/client', () => ({
  Conversation: { startSession: sdk.startSession },
}));

function createSdkHandleConnection(input: Readonly<{ driver: Readonly<{
  open(input: Readonly<{
    signal: AbortSignal;
    onControl(event: unknown): void;
    onTransport(event: Readonly<{ type: 'session_identity'; sessionId: string }>): void;
    onRemoteClose(reason: string): void;
  }>): Promise<void>;
  sendControl(event: never): Promise<void>;
  setOutputFocusState?(state: 'active' | 'ducked' | 'suspended'): void;
  close(): Promise<void>;
}> }>, observations?: Readonly<{
  onControl?(event: unknown): void;
  onTransport?(event: Readonly<{ type: 'session_identity'; sessionId: string }>): void;
}>): VoiceRealtimeConnection {
  let state: ReturnType<VoiceRealtimeConnection['state']> = 'idle';
  let providerSessionId: string | null = null;
  let closePromise: Promise<void> | null = null;
  const controls: VoiceRealtimeJsonValue[] = [];
  const close = async (): Promise<void> => {
    if (!closePromise) {
      state = 'closed';
      // The host media facade retains pending/successful cleanup, and retries rejection.
      closePromise = input.driver.close().catch((error: unknown) => {
        closePromise = null;
        throw error;
      });
    }
    await closePromise;
  };
  return {
    kind: 'sdk_handle',
    async connect(signal) {
      state = 'connecting';
      const abort = new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
      try {
        await Promise.race([
          input.driver.open({
            signal,
            onControl(event) {
              controls.push(VoiceRealtimeJsonValueSchema.parse(event));
              observations?.onControl?.(event);
            },
            onTransport(event) {
              providerSessionId = event.sessionId;
              observations?.onTransport?.(event);
            },
            // The real host observes automatic-close errors; explicit dispose still rejects.
            onRemoteClose() { void close().catch(() => undefined); },
          }),
          abort,
        ]);
        if (state === 'closed' || signal.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        state = 'open';
      } catch (error) {
        await close();
        throw error;
      }
    },
    sendControl: async (event) => await input.driver.sendControl(event as never),
    controlEvents: () => ({ async *[Symbol.asyncIterator]() {
      while (controls.length > 0) yield controls.shift()!;
    } }),
    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    async close() { await close(); },
    state: () => state,
    currentProviderSessionId: () => providerSessionId,
    playbackCursorMs: () => null,
    beginOutputInterruptionCandidate: () => 'unsupported' as const,
    resolveOutputInterruptionCandidate: () => {},
    setOutputFocusState(state) {
      if (!input.driver.setOutputFocusState) return 'unsupported';
      try {
        input.driver.setOutputFocusState(state);
        return 'applied';
      } catch {
        return 'unsupported';
      }
    },
  };
}

describe('ElevenLabs public Voice provider leaf', () => {
  it('registers the manifest-local id through a normal host-free activate(api) entry', () => {
    const register = vi.fn();
    activate({ voiceProviders: { register } });

    expect(register).toHaveBeenCalledWith(
      PLUGIN_MANIFEST.contributes.voiceProviders[0].id,
      expect.any(Object),
    );
    const runtime = register.mock.calls[0]![1] as Record<string, unknown>;
    expect(runtime).toMatchObject({
      kind: 'conversation',
      microphoneMode: 'provider_managed',
      outputLevelMeter: 'unavailable',
      settingsActions: { execute: expect.any(Function) },
    });
    expect(runtime).not.toHaveProperty('start');
    expect(runtime).not.toHaveProperty('stop');
    expect(runtime).not.toHaveProperty('getSnapshot');
    expect((runtime.protocol as Readonly<{ encodeTurnControl(action: string): unknown }>).encodeTurnControl('cancel_response')).toBeNull();
  });

  it('preserves a native pre-abort reason when settings catalog signals lack throwIfAborted', async () => {
    const runtime = createElevenLabsVoiceProviderRuntime();
    const reason = new Error('native settings catalog aborted');
    const signal = { aborted: true, reason } as AbortSignal;

    await expect(runtime.settingsOperations.listCatalog({
      catalog: 'voices',
      credentials: { phase: 'settings', mediated: null, raw: null },
      signal,
    })).rejects.toBe(reason);
  });

  it('executes declared Create Agent through settings-phase credential access and returns only its settings patch', async () => {
    const runtime = createElevenLabsVoiceProviderRuntime();
    let toolSequence = 0;
    const request = provisionAccountRequest(async (call: Readonly<{
      operationId: string;
      parameters?: Readonly<Record<string, unknown>>;
    }>) => {
      const body = call.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : call.operationId === 'agents'
          ? { agents: [], has_more: false, next_cursor: null }
        : call.operationId === 'tools'
          ? { tools: [] }
          : call.operationId === 'create-tool'
            ? { id: `tool-${++toolSequence}` }
            : call.operationId === 'create-agent'
              ? { agent_id: 'agent-created' }
              : {};
      return {
        status: 200,
        finalUrl: 'https://api.elevenlabs.io/v1/convai/test',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
      };
    });

    const actionContext = {
      credentials: {
        phase: 'settings' as const,
        mediated: { request },
        raw: null,
      },
      interactions: {
        askQuestions: vi.fn(async () => ({
          requestId: 'questions-cancelled', kind: 'questions' as const, status: 'userCancelled' as const,
        })),
      },
      tools: HOST_NORMALIZED_TOOLS,
      signal: new AbortController().signal,
    } as const;

    await expect(runtime.settingsActions?.execute({
      actionId: 'create-agent',
      settings: {
        billingMode: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.billingMode,
        tts: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts,
        agentId: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.agentId,
      },
    }, actionContext)).resolves.toEqual({ patch: { agentId: 'agent-created' } });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'create-agent',
    }));
    const createAgentCall = request.mock.calls.find(([call]) => call.operationId === 'create-agent')?.[0];
    const createAgentPrompt = (
      createAgentCall?.parameters?.body as Readonly<{
        conversation_config?: Readonly<{ agent?: Readonly<{ prompt?: Readonly<{ prompt?: unknown }> }> }>;
      }> | undefined
    )?.conversation_config?.agent?.prompt?.prompt;
    expect(createAgentPrompt).not.toContain('SETTINGS_ACTION_CONTEXT_SENTINEL');
    const provisionedTools = request.mock.calls
      .map(([call]) => call)
      .filter((call) => call.operationId === 'create-tool');
    expect(provisionedTools).toEqual([expect.objectContaining({
      operationId: 'create-tool',
      parameters: {
        body: {
          tool_config: expect.objectContaining({
            name: 'hostListMachines',
            description: 'Host-normalized machine inventory',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } },
              required: ['limit'],
            },
          }),
        },
      },
    })]);
    expect(JSON.stringify(provisionedTools)).not.toContain('listMachines');
    expect(actionContext.interactions.askQuestions).not.toHaveBeenCalled();
  });

  it('lists multiple existing agents and updates the one explicitly selected by the user', async () => {
    const runtime = createElevenLabsVoiceProviderRuntime();
    let toolSequence = 0;
    const request = provisionAccountRequest(async (call: Readonly<{
      operationId: string;
      parameters?: Readonly<Record<string, unknown>>;
    }>) => {
      const body = call.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
          : call.operationId === 'agents'
          ? {
              agents: [
                { agent_id: 'agent-first', name: 'Happier Voice' },
                { agent_id: 'agent-second', name: 'Happier Voice' },
              ],
            }
          : call.operationId === 'agent'
            ? {
                agent_id: 'agent-second',
                conversation_config: {
                  agent: { prompt: { tool_ids: [] } },
                },
              }
          : call.operationId === 'tools'
            ? { tools: [], has_more: false }
            : call.operationId === 'create-tool'
              ? { id: `tool-${++toolSequence}` }
              : {};
      return {
        status: 200,
        finalUrl: 'https://api.elevenlabs.io/v1/convai/test',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
      };
    });
    const askQuestions = vi.fn(async (request: Readonly<{ questions: readonly unknown[] }>) => {
      expect(request).toEqual(expect.objectContaining({
        kind: 'questions',
        title: 'Existing Happier Voice agent',
        questions: [expect.objectContaining({
          id: 'existing-agent-action',
          type: 'singleChoice',
          choices: [
            expect.objectContaining({ id: 'create-new' }),
            expect.objectContaining({ id: 'update-existing-0', description: expect.stringContaining('agent-first') }),
            expect.objectContaining({ id: 'update-existing-1', description: expect.stringContaining('agent-second') }),
          ],
        })],
      }));
      return {
        requestId: 'questions-1',
        kind: 'questions' as const,
        status: 'answered' as const,
        answers: {
          'existing-agent-action': {
            kind: 'singleChoice' as const,
            answer: { kind: 'choice' as const, choiceId: 'update-existing-1' },
          },
        },
      };
    });

    await expect(runtime.settingsActions?.execute({
      actionId: 'create-agent',
      settings: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
    }, {
      credentials: { phase: 'settings', mediated: { request }, raw: null },
      interactions: { askQuestions },
      tools: HOST_NORMALIZED_TOOLS,
      signal: new AbortController().signal,
    })).resolves.toEqual({ patch: { agentId: 'agent-second' } });

    expect(askQuestions).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'update-agent',
      parameters: expect.objectContaining({ agentId: 'agent-second' }),
    }));
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operationId: 'create-agent' }));
  });

  it('creates a new agent when the user explicitly selects Create new', async () => {
    const runtime = createElevenLabsVoiceProviderRuntime();
    let toolSequence = 0;
    const request = provisionAccountRequest(async (call: Readonly<{ operationId: string }>) => {
      const body = call.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : call.operationId === 'agents'
          ? { agents: [{ agent_id: 'agent-existing', name: 'Happier Voice' }] }
          : call.operationId === 'tools'
            ? { tools: [], has_more: false }
            : call.operationId === 'create-tool'
              ? { id: `tool-${++toolSequence}` }
              : call.operationId === 'create-agent'
                ? { agent_id: 'agent-created' }
                : {};
      return {
        status: 200,
        finalUrl: 'https://api.elevenlabs.io/v1/convai/test',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
      };
    });

    await expect(runtime.settingsActions?.execute({
      actionId: 'create-agent',
      settings: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
    }, {
      credentials: { phase: 'settings', mediated: { request }, raw: null },
      interactions: {
        askQuestions: vi.fn(async () => ({
          requestId: 'questions-2',
          kind: 'questions' as const,
          status: 'answered' as const,
          answers: {
            'existing-agent-action': {
              kind: 'singleChoice' as const,
              answer: { kind: 'choice' as const, choiceId: 'create-new' },
            },
          },
        })),
      },
      tools: HOST_NORMALIZED_TOOLS,
      signal: new AbortController().signal,
    })).resolves.toEqual({ patch: { agentId: 'agent-created' } });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'create-agent' }));
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operationId: 'update-agent' }));
  });

  it.each([
    ['cancelled', {
      requestId: 'questions-cancelled', kind: 'questions' as const, status: 'userCancelled' as const,
    }, 'plugin_settings_action_cancelled'],
    ['unavailable', {
      requestId: 'questions-unavailable',
      kind: 'questions' as const,
      status: 'unavailable' as const,
    }, 'plugin_settings_action_interaction_unavailable'],
    ['malformed', {
      requestId: 'questions-malformed',
      kind: 'questions' as const,
      status: 'answered' as const,
      answers: {
        'existing-agent-action': {
          kind: 'singleChoice' as const,
          answer: { kind: 'choice' as const, choiceId: 'unknown-choice' },
        },
      },
    }, 'plugin_settings_action_interaction_invalid'],
  ])('fails closed before mutation when the reuse question is %s', async (_label, interactionResult, errorCode) => {
    const runtime = createElevenLabsVoiceProviderRuntime();
    const request = vi.fn(async (call: Readonly<{ operationId: string }>) => ({
      status: 200,
      finalUrl: 'https://api.elevenlabs.io/v1/convai/test',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(
        call.operationId === 'agents'
          ? { agents: [{ agent_id: 'agent-existing', name: 'Happier Voice' }] }
          : {},
      )),
    }));

    await expect(runtime.settingsActions?.execute({
      actionId: 'create-agent',
      settings: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
    }, {
      credentials: { phase: 'settings', mediated: { request }, raw: null },
      interactions: { askQuestions: vi.fn(async () => interactionResult) },
      tools: HOST_NORMALIZED_TOOLS,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: errorCode });

    expect(request.mock.calls.map(([call]) => call.operationId)).toEqual(['agents']);
  });

  it('keeps Update agent direct without listing or presenting a reuse question', async () => {
    const runtime = createElevenLabsVoiceProviderRuntime();
    let toolSequence = 0;
    const request = provisionAccountRequest(async (call: Readonly<{ operationId: string }>) => {
      const body = call.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
        : call.operationId === 'agent'
          ? {
              agent_id: 'agent-direct',
              conversation_config: {
                agent: { prompt: { tool_ids: [] } },
              },
            }
        : call.operationId === 'tools'
          ? { tools: [], has_more: false }
          : call.operationId === 'create-tool'
            ? { id: `tool-${++toolSequence}` }
            : {};
      return {
        status: 200,
        finalUrl: 'https://api.elevenlabs.io/v1/convai/test',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
      };
    });
    const askQuestions = vi.fn();

    await expect(runtime.settingsActions?.execute({
      actionId: 'update-agent',
      settings: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, agentId: 'agent-direct' },
    }, {
      credentials: { phase: 'settings', mediated: { request }, raw: null },
      interactions: { askQuestions },
      tools: HOST_NORMALIZED_TOOLS,
      signal: new AbortController().signal,
    })).resolves.toEqual({ patch: { agentId: 'agent-direct' } });

    expect(askQuestions).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([call]) => call.operationId)).not.toContain('agents');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'update-agent',
      parameters: expect.objectContaining({ agentId: 'agent-direct' }),
    }));
  });

  it('releases an unconsumed hosted lease before a replacement prepare', async () => {
    const events: string[] = [];
    let activeLeaseId = '';
    let startCount = 0;
    const hostedConversation = {
      start: vi.fn(async () => {
        startCount += 1;
        activeLeaseId = `lease-${startCount}`;
        events.push(`start:${activeLeaseId}`);
        return {
          allowed: true as const,
          token: `token-${startCount}`,
          leaseId: activeLeaseId,
          bindingNonce: `nonce-${startCount}`,
          expiresAtMs: Date.now() + 60_000,
        };
      }),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => {
        events.push(`abort:${activeLeaseId}`);
      }),
    };
    const runtime = createElevenLabsVoiceProviderRuntime();
    const prepare = async (attemptId: number) => await runtime.protocol.prepare({
      controlSessionId: 'control-replacement',
      attemptId,
      reason: 'initial',
      request: {},
      platform: 'web',
      providerConfig: {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
        billingMode: 'happier',
      },
      credentials: { phase: 'prepare', mediated: null, raw: null },
      providerConversation: null,
      hostedConversation,
      signal: new AbortController().signal,
    });

    await expect(prepare(1)).resolves.toMatchObject({ kind: 'prepared' });
    await expect(prepare(2)).resolves.toMatchObject({ kind: 'prepared' });

    expect(events).toEqual([
      'start:lease-1',
      'abort:lease-1',
      'start:lease-2',
    ]);
    await runtime.protocol.releasePrepared?.({
      controlSessionId: 'control-replacement',
      attemptId: 2,
      reason: { code: 'replaced' },
    });
    expect(hostedConversation.abort).toHaveBeenCalledTimes(2);
    await runtime.dispose?.();
  });

  it('releases an unconsumed hosted lease before a replacement prepare fails', async () => {
    const events: string[] = [];
    const firstHostedConversation = {
      start: vi.fn(async () => {
        events.push('first:start');
        return {
          allowed: true as const,
          token: 'token-first',
          leaseId: 'lease-first',
          bindingNonce: 'nonce-first',
          expiresAtMs: Date.now() + 60_000,
        };
      }),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => {
        events.push('first:abort');
      }),
    };
    const failingReplacementConversation = {
      start: vi.fn(async () => {
        events.push('replacement:start');
        throw new Error('replacement_prepare_failed');
      }),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => {
        events.push('replacement:abort');
      }),
    };
    const runtime = createElevenLabsVoiceProviderRuntime();
    const prepare = async (
      attemptId: number,
      hostedConversation: typeof firstHostedConversation,
    ) => await runtime.protocol.prepare({
      controlSessionId: 'control-replacement-failure',
      attemptId,
      reason: 'initial',
      request: {},
      platform: 'web',
      providerConfig: {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
        billingMode: 'happier',
      },
      credentials: { phase: 'prepare', mediated: null, raw: null },
      providerConversation: null,
      hostedConversation,
      signal: new AbortController().signal,
    });

    await expect(prepare(1, firstHostedConversation)).resolves.toMatchObject({ kind: 'prepared' });
    await expect(prepare(2, failingReplacementConversation)).rejects.toThrow('replacement_prepare_failed');

    expect(events).toEqual([
      'first:start',
      'first:abort',
      'replacement:start',
    ]);
    expect(failingReplacementConversation.abort).not.toHaveBeenCalled();
    await runtime.dispose?.();
  });

  it('keeps auth bounded, delegates SDK media, and closes hosted bookkeeping with the connection', async () => {
    sdk.startSession.mockResolvedValueOnce({
      endSession: sdk.endSession,
      setMicMuted: sdk.setMicMuted,
      setVolume: sdk.setVolume,
      sendUserMessage: sdk.sendUserMessage,
      sendContextualUpdate: sdk.sendContextualUpdate,
      getId: sdk.getId,
    });
    const runtime = createElevenLabsVoiceProviderRuntime();
    const signal = new AbortController().signal;
    const prepared = await runtime.protocol.prepare({
      controlSessionId: 'control-1', attemptId: 1, reason: 'initial', request: {},
      attemptPolicy: {
        instructions: 'Reply in French using the admitted tools.',
        assistantLanguage: 'fr-FR',
        welcome: { enabled: true, mode: 'immediate', text: 'Bonjour, je vous écoute.' },
      },
      platform: 'web', providerConfig: {
        billingMode: 'byo',
        agentId: 'agent-1',
        tts: {
          voiceId: 'voice_id_persisted_fixture',
          modelId: null,
          voiceSettings: {
            stability: null,
            similarityBoost: null,
            speed: null,
          },
        },
      },
      credentials: {
        phase: 'prepare',
        raw: null,
        mediated: { request: vi.fn(async (request: Readonly<{ operationId: string }>) => ({
          status: 200,
          finalUrl: request.operationId === 'agent'
            ? 'https://api.elevenlabs.io/v1/convai/agents/agent-1'
            : 'https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent-1',
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(request.operationId === 'agent' ? {
            agent_id: 'agent-1',
            tags: ['happier_voice_config_v1'],
            platform_settings: {
              auth: { enable_auth: true },
              overrides: { conversation_config_override: {
                agent: { first_message: true, language: true, prompt: { prompt: true } },
                conversation: { text_only: true },
                tts: { voice_id: true },
              } },
            },
          } : { token: 'short-lived-token' })),
        })) },
      },
      providerConversation: null,
      hostedConversation: null,
      signal,
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('expected_prepared');
    expect(prepared.session.safeMetadata).not.toHaveProperty('token');

    // Native interruption can arrive before the provider SDK handle exists.
    // The provider runtime must retain that exact desired mute and seed the
    // eventual handle rather than treating it as a successful no-op.
    await runtime.setInputMuted?.(true);
    const publicSdkHandleConnection = vi.fn(createSdkHandleConnection);
    const connection = await runtime.createConnection({
      session: prepared.session,
      attemptId: 1,
      mic: {
        ensureActive: vi.fn(async () => undefined), teardown: vi.fn(async () => undefined),
        setMuted: vi.fn(), isMuted: vi.fn(() => true), getStream: vi.fn(() => null),
      },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 },
      levels: { onOutputLevel: vi.fn() },
      media: {
        createSdkHandleConnection: publicSdkHandleConnection,
        createWebRtcConnection: vi.fn(),
        createPcmConnection: vi.fn(),
      },
      tools: [{
        name: 'readSession',
        description: 'Read session state',
        parameters: { type: 'object', additionalProperties: false },
        execute: vi.fn(async () => ({ status: 'ok', path: '[redacted]' })),
      }] as never,
      ui: {} as never,
      signal,
      execution: { kind: 'direct_media' },
      credentials: { phase: 'connection', mediated: null, raw: null },
    });
    expect(publicSdkHandleConnection).toHaveBeenCalledTimes(1);
    await connection.connect(new AbortController().signal);
    expect(sdk.startSession).toHaveBeenCalledWith(expect.objectContaining({
      overrides: expect.objectContaining({
        agent: expect.objectContaining({ firstMessage: 'Bonjour, je vous écoute.', language: 'fr' }),
      }),
    }));
    const startOptions = sdk.startSession.mock.calls[0]?.[0] as Readonly<{
      clientTools?: Readonly<Record<string, (parameters: unknown) => Promise<unknown>>>;
      onIncomingEvent?: (event: unknown) => void;
    }>;
    const parameters = {};
    startOptions.onIncomingEvent?.({ type: 'client_tool_call', client_tool_call: {
      tool_call_id: 'provider-read', tool_name: 'readSession', parameters,
    } });
    const delivery = startOptions.clientTools?.readSession?.(parameters);
    const control = await connection.controlEvents(signal)[Symbol.asyncIterator]().next();
    const decoded = runtime.protocol.decodeControl(control.value);
    expect(decoded).toMatchObject([{ type: 'tool_calls', responseId: 'provider-read' }]);
    for (const event of runtime.encodeToolResults([{
      v: 1, responseId: 'provider-read', callId: 'provider-read', toolName: 'readSession', order: 0,
      status: 'success', output: { status: 'ok', path: '[redacted]' },
    }])) await connection.sendControl(event);
    expect(await delivery).toEqual({
      status: 'ok',
      path: '[redacted]',
    });
    expect(sdk.setMicMuted).toHaveBeenCalledWith(true);
    await runtime.setInputMuted?.(false);
    expect(sdk.setMicMuted).toHaveBeenLastCalledWith(false);
    await connection.close({ code: 'user_stop' });
    expect(sdk.endSession).toHaveBeenCalledTimes(1);
    await runtime.dispose?.();
  });

  it('keeps an unresolved hosted settlement retryable after public runtime disposal fails', async () => {
    sdk.startSession.mockResolvedValueOnce({
      endSession: async () => {}, setMicMuted: () => {}, setVolume: () => {},
      sendUserMessage: () => {}, sendContextualUpdate: () => {}, getId: () => 'conversation-retry',
    });
    const complete = vi.fn().mockRejectedValueOnce(new Error('processing'))
      .mockRejectedValueOnce(new Error('processing')).mockResolvedValue(undefined);
    const abort = vi.fn();
    const runtime = createElevenLabsVoiceProviderRuntime();
    const signal = new AbortController().signal;
    const prepared = await runtime.protocol.prepare({
      controlSessionId: 'control-retry', attemptId: 1, reason: 'initial', request: {},
      platform: 'web', providerConfig: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      credentials: { phase: 'prepare', mediated: null, raw: null }, providerConversation: null,
      hostedConversation: {
        start: async () => ({ allowed: true, token: 'token', leaseId: 'lease-retry', bindingNonce: 'nonce', expiresAtMs: null }),
        complete, abort,
      }, signal,
    });
    if (prepared.kind !== 'prepared') throw new Error('expected_prepared');
    const connection = await runtime.createConnection({
      session: prepared.session, attemptId: 1,
      mic: { ensureActive: async () => {}, teardown: async () => {}, setMuted: () => {}, isMuted: () => false, getStream: () => null },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 }, levels: { onOutputLevel: () => {} },
      media: { createSdkHandleConnection, createWebRtcConnection: vi.fn(), createPcmConnection: vi.fn() },
      tools: [], ui: {} as never, signal, execution: { kind: 'direct_media' },
      credentials: { phase: 'connection', mediated: null, raw: null },
    });
    await connection.connect(signal);
    await expect(runtime.dispose?.()).rejects.toThrow('processing');
    await runtime.dispose?.();
    expect(complete.mock.calls).toEqual([
      [{ providerConversationId: 'conversation-retry' }],
      [{ providerConversationId: 'conversation-retry' }],
      [{ providerConversationId: 'conversation-retry' }],
    ]);
    expect(abort).not.toHaveBeenCalled();
  });

  it('aborts hosted bookkeeping and suppresses late SDK publication after End Voice', async () => {
    let resolveSdkStart!: (conversation: Readonly<{
      endSession: () => Promise<void>;
      setMicMuted: (muted: boolean) => void;
      setVolume: (input: Readonly<{ volume: number }>) => void;
      sendUserMessage: (message: string) => void;
      sendContextualUpdate: (update: string) => void;
      getId: () => string;
    }>) => void;
    const pendingSdkStart = new Promise<Parameters<typeof resolveSdkStart>[0]>((resolve) => {
      resolveSdkStart = resolve;
    });
    sdk.startSession.mockImplementationOnce(async () => await pendingSdkStart);
    const lateConversation = {
      endSession: vi.fn(async () => undefined),
      setMicMuted: vi.fn(),
      setVolume: vi.fn(),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      getId: vi.fn(() => 'late-conversation'),
    };
    const hostedConversation = {
      start: vi.fn(async () => ({
        allowed: true as const,
        token: 'hosted-token',
        leaseId: 'lease-late',
        bindingNonce: 'nonce-late',
        expiresAtMs: Date.now() + 60_000,
      })),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const runtime = createElevenLabsVoiceProviderRuntime();
    const attempt = new AbortController();
    const prepared = await runtime.protocol.prepare({
      controlSessionId: 'control-late',
      attemptId: 2,
      reason: 'initial',
      request: {},
      platform: 'web',
      providerConfig: {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
        billingMode: 'happier',
      },
      credentials: { phase: 'prepare', mediated: null, raw: null },
      providerConversation: null,
      hostedConversation,
      signal: attempt.signal,
    });
    if (prepared.kind !== 'prepared') throw new Error('expected_prepared');
    const controls: unknown[] = [];
    const identities: unknown[] = [];
    const connection = await runtime.createConnection({
      session: prepared.session,
      attemptId: 2,
      mic: {
        ensureActive: vi.fn(async () => undefined),
        teardown: vi.fn(async () => undefined),
        setMuted: vi.fn(),
        isMuted: vi.fn(() => false),
        getStream: vi.fn(() => null),
      },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 },
      levels: { onOutputLevel: vi.fn() },
      media: {
        createSdkHandleConnection: (input) => createSdkHandleConnection(input, {
          onControl: (event) => controls.push(event),
          onTransport: (event) => identities.push(event),
        }),
        createWebRtcConnection: vi.fn(),
        createPcmConnection: vi.fn(),
      },
      tools: [],
      ui: {} as never,
      signal: attempt.signal,
      execution: { kind: 'direct_media' },
      credentials: { phase: 'connection', mediated: null, raw: null },
    });
    const startCallsBeforeConnect = sdk.startSession.mock.calls.length;
    const connecting = connection.connect(attempt.signal);
    await vi.waitFor(() => {
      expect(sdk.startSession).toHaveBeenCalledTimes(startCallsBeforeConnect + 1);
    });
    const sdkOptions = sdk.startSession.mock.calls.at(-1)?.[0] as Readonly<{
      onConnect(): void;
      onMessage(value: unknown): void;
      onModeChange(value: unknown): void;
    }>;

    attempt.abort();
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(connection.state()).toBe('closed');

    sdkOptions.onConnect();
    sdkOptions.onMessage({ source: 'ai', message: 'late transcript' });
    sdkOptions.onModeChange({ mode: 'speaking' });
    resolveSdkStart(lateConversation);
    await vi.waitFor(() => expect(lateConversation.endSession).toHaveBeenCalledTimes(1));

    expect(controls).toEqual([]);
    expect(identities).toEqual([]);
    expect(hostedConversation.complete).not.toHaveBeenCalled();
    expect(hostedConversation.abort).toHaveBeenCalledTimes(1);
    expect(lateConversation.setMicMuted).not.toHaveBeenCalled();
    await runtime.dispose?.();
    expect(lateConversation.endSession).toHaveBeenCalledTimes(1);
    expect(hostedConversation.abort).toHaveBeenCalledTimes(1);
  });
});
