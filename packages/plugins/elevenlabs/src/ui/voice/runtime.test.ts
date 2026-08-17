import { describe, expect, it, vi } from 'vitest';
import type {
  VoiceClientToolDefinition,
  VoiceRealtimeConnection,
} from '@happier-dev/plugin-sdk/voice/client';

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
  close(): Promise<void>;
}> }>, observations?: Readonly<{
  onControl?(event: unknown): void;
  onTransport?(event: Readonly<{ type: 'session_identity'; sessionId: string }>): void;
}>): VoiceRealtimeConnection {
  let state: ReturnType<VoiceRealtimeConnection['state']> = 'idle';
  let providerSessionId: string | null = null;
  let closePromise: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    if (!closePromise) {
      state = 'closed';
      closePromise = input.driver.close();
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
            onControl(event) { observations?.onControl?.(event); },
            onTransport(event) {
              providerSessionId = event.sessionId;
              observations?.onTransport?.(event);
            },
            onRemoteClose() { void close(); },
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
    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    async close() { await close(); },
    state: () => state,
    currentProviderSessionId: () => providerSessionId,
    playbackCursorMs: () => null,
    beginOutputInterruptionCandidate: () => 'unsupported',
    resolveOutputInterruptionCandidate() {},
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

  it('executes declared Create Agent through settings-phase credential access and returns only its settings patch', async () => {
    const runtime = createElevenLabsVoiceProviderRuntime();
    let toolSequence = 0;
    const request = vi.fn(async (call: Readonly<{
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
      .filter((call) => call.operationId === 'create-tool' || call.operationId === 'update-tool');
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
    const request = vi.fn(async (call: Readonly<{
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
    const request = vi.fn(async (call: Readonly<{ operationId: string }>) => {
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
    const request = vi.fn(async (call: Readonly<{ operationId: string }>) => {
      const body = call.operationId === 'voices'
        ? ACCOUNT_VOICE_CATALOG
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

  it('keeps auth bounded, delegates SDK media, and closes hosted bookkeeping with the connection', async () => {
    sdk.startSession.mockResolvedValueOnce({
      endSession: sdk.endSession,
      setMicMuted: sdk.setMicMuted,
      sendUserMessage: sdk.sendUserMessage,
      sendContextualUpdate: sdk.sendContextualUpdate,
      getId: sdk.getId,
    });
    const runtime = createElevenLabsVoiceProviderRuntime();
    const signal = new AbortController().signal;
    const prepared = await runtime.protocol.prepare({
      controlSessionId: 'control-1', attemptId: 1, reason: 'initial', request: {},
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
        mediated: { request: vi.fn(async () => ({
          status: 200,
          finalUrl: 'https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent-1',
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({ token: 'short-lived-token' })),
        })) },
      },
      providerConversation: null,
      hostedConversation: null,
      signal,
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('expected_prepared');
    expect(prepared.session.safeMetadata).not.toHaveProperty('token');

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
    const startOptions = sdk.startSession.mock.calls[0]?.[0] as Readonly<{
      clientTools?: Readonly<Record<string, (parameters: unknown) => Promise<unknown>>>;
    }>;
    expect(await startOptions.clientTools?.readSession?.({})).toEqual({
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

  it('aborts hosted bookkeeping and suppresses late SDK publication after End Voice', async () => {
    let resolveSdkStart!: (conversation: Readonly<{
      endSession: () => Promise<void>;
      setMicMuted: (muted: boolean) => void;
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
