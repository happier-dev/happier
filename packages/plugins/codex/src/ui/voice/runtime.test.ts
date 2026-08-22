import type {
  VoiceCredentialAccess,
  VoiceCredentialAccessPhase,
} from '@happier-dev/plugin-sdk/voice';
import type {
  RealtimeVoiceProviderRuntime,
  VoiceClientToolDefinition,
  VoiceRealtimeConnection,
} from '@happier-dev/plugin-sdk/voice/client';
import type {
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
  AgentSessionRealtimeStartResult,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  activate,
  createCodexRealtimeVoiceProviderRuntime,
} from './runtime.js';

function createConnection(): VoiceRealtimeConnection {
  return {
    kind: 'webrtc',
    connect: async () => {},
    sendControl: async () => {},
    async *controlEvents() {},
    async *transportEvents() {},
    close: async () => {},
    state: () => 'idle',
    currentProviderSessionId: () => null,
    playbackCursorMs: () => null,
    beginOutputInterruptionCandidate: () => 'unsupported',
    resolveOutputInterruptionCandidate: () => {},
  };
}

const SENTINEL_TOOL = {
  name: 'readCurrentUiContext',
  description: 'Read the privacy-qualified current UI context.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  execute: async () => ({ ok: true }),
} satisfies VoiceClientToolDefinition;

function createHandle(): AgentSessionRealtimeHandle {
  return {
    stop: vi.fn(async () => ({ status: 'stopped' as const })),
    watch: vi.fn((_listener: (event: AgentSessionRealtimeLifecycleEvent) => void) => ({
      dispose() {},
    })),
    dispose: vi.fn(),
  };
}

function preparedSession(
  runtime: RealtimeVoiceProviderRuntime,
  signal: AbortSignal,
  attemptId = 1,
) {
  return runtime.protocol.prepare({
    controlSessionId: 'voice-global',
    attemptId,
    reason: 'initial',
    request: {},
    platform: 'web',
    providerConfig: {},
    credentials: credentialAccess('prepare'),
    providerConversation: null,
    hostedConversation: null,
    signal,
  });
}

function credentialAccess<P extends VoiceCredentialAccessPhase>(
  phase: P,
): VoiceCredentialAccess<P> {
  return Object.freeze({ phase, mediated: null, raw: null });
}

describe('Codex Agent-session realtime Voice leaf', () => {
  it.each(['web', 'ios', 'android'] as const)(
    'admits the same public runtime on %s',
    async (platform) => {
      const runtime = createCodexRealtimeVoiceProviderRuntime();
      const signal = new AbortController().signal;

      await expect(runtime.protocol.preflight?.({
        controlSessionId: 'voice-global',
        attemptId: 1,
        request: {},
        platform,
        providerConfig: {},
        signal,
      })).resolves.toEqual({ kind: 'ready' });
      await expect(runtime.protocol.prepare({
        controlSessionId: 'voice-global',
        attemptId: 1,
        reason: 'initial',
        request: {},
        platform,
        providerConfig: {},
        credentials: credentialAccess('prepare'),
        providerConversation: null,
        hostedConversation: null,
        signal,
      })).resolves.toMatchObject({ kind: 'prepared' });
    },
  );

  it('registers the same runtime through normal activation without a private host', () => {
    const register = vi.fn();

    activate({ voiceProviders: { register } });

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(
      'realtime-codex',
      expect.objectContaining({
        kind: 'conversation',
        microphoneMode: 'host_webrtc',
      }),
    );
    expect(register.mock.calls[0]?.[1]?.beforeInterrupt).toBeUndefined();
  });

  it('uses only the bound execution service for WebRTC offer exchange', async () => {
    const runtime = createCodexRealtimeVoiceProviderRuntime();
    const signal = new AbortController().signal;
    await expect(runtime.protocol.preflight?.({
      controlSessionId: 'voice-global',
      attemptId: 7,
      request: {},
      platform: 'web',
      providerConfig: {},
      signal,
    })).resolves.toEqual({ kind: 'ready' });
    const prepared = await preparedSession(runtime, signal, 7);
    expect(prepared).toEqual({
      kind: 'prepared',
      session: {
        config: {},
        safeMetadata: {},
      },
    });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');

    const handle = createHandle();
    const setMuted = vi.fn();
    const start = vi.fn(async () => ({
      status: 'started' as const,
      transport: { kind: 'webrtc' as const, answerSdp: 'answer-sdp' },
      handle,
    }));
    const createWebRtcConnection = vi.fn(() => createConnection());
    const connection = await runtime.createConnection({
      session: prepared.session,
      attemptId: 7,
      mic: {
        ensureActive: async () => {},
        setMuted,
        isMuted: () => false,
        teardown: async () => {},
        getStream: () => null,
      },
      interruption: { duckGain: 0.2, retainedOutputMaxMs: 250 },
      levels: { onOutputLevel: () => {} },
      media: {
        createSdkHandleConnection: () => { throw new Error('unexpected SDK connection'); },
        createWebRtcConnection,
        createPcmConnection: () => { throw new Error('unexpected PCM connection'); },
      },
      tools: [SENTINEL_TOOL],
      ui: {} as never,
      signal,
      credentials: credentialAccess('connection'),
      execution: {
        kind: 'experimental_agent_session_realtime',
        agentSessionRealtime: {
          inspect: vi.fn(async () => ({ status: 'available' as const, transport: 'webrtc' as const })),
          start,
        },
      },
    });

    expect(createWebRtcConnection).toHaveBeenCalledTimes(1);
    const negotiated = createWebRtcConnection.mock.calls[0]?.[0];
    expect(negotiated?.control).toEqual({
      label: 'oai-events',
      onOpen: expect.any(Function),
    });
    const sendJson = vi.fn(async () => {});
    await negotiated?.control.onOpen({ sendJson });
    expect(sendJson).toHaveBeenCalledWith({
      type: 'session.update',
      session: {
        type: 'realtime',
        tools: [{
          type: 'function',
          name: 'readCurrentUiContext',
          description: 'Read the privacy-qualified current UI context.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        }],
        tool_choice: 'auto',
      },
    });
    expect(runtime.encodeToolResults([{
      v: 1,
      responseId: 'response-1',
      callId: 'call-1',
      toolName: 'readCurrentUiContext',
      order: 0,
      status: 'success',
      output: { ok: true },
    }])).toEqual([{
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '{"ok":true}',
      },
    }]);
    expect(runtime.encodeToolContinuation('response-1')).toEqual({ type: 'response.create' });
    expect(runtime.encodeContextUpdate('Current UI: Triage issue')).toEqual([{
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: '[Context update]\nCurrent UI: Triage issue' }],
      },
    }]);
    expect(setMuted).not.toHaveBeenCalled();
    await expect(negotiated?.signaling.exchangeOffer({
      offerSdp: 'offer-sdp',
      signal,
    })).resolves.toEqual({ answerSdp: 'answer-sdp' });
    expect(start).toHaveBeenCalledWith(
      { transport: { kind: 'webrtc', offerSdp: 'offer-sdp' } },
      { signal },
    );
    expect(connection.kind).toBe('webrtc');
    expect(handle.watch).not.toHaveBeenCalled();
    expect(handle.stop).not.toHaveBeenCalled();
    expect(handle.dispose).not.toHaveBeenCalled();

    const final = {
      type: 'turn.done',
      turn: { id: 'turn-7', role: 'assistant', transcript: 'Done' },
    } as const;
    expect(runtime.protocol.decodeControl(final)).toEqual([
      expect.objectContaining({
        type: 'transcript',
        event: expect.objectContaining({
          type: 'voice.transcript.final',
          itemId: 'codex-v3:7:turn-7',
          revision: 1,
        }),
      }),
    ]);
    expect(runtime.protocol.decodeControl(final)).toEqual([]);
  });

  it('settles a started zero-final attempt through releasePrepared exactly once', async () => {
    const runtime = createCodexRealtimeVoiceProviderRuntime();
    const signal = new AbortController().signal;
    const diagnostic = vi.fn();
    const createWebRtcConnection = vi.fn(() => createConnection());
    const stalePrepared = await preparedSession(runtime, signal, 7);
    if (stalePrepared.kind !== 'prepared') throw new Error('expected prepared');
    await runtime.createConnection({
      session: stalePrepared.session,
      attemptId: 7,
      mic: {} as never,
      interruption: { duckGain: 0.2, retainedOutputMaxMs: 250 },
      levels: { onOutputLevel: () => {} },
      media: {
        createSdkHandleConnection: () => { throw new Error('unexpected SDK connection'); },
        createWebRtcConnection,
        createPcmConnection: () => { throw new Error('unexpected PCM connection'); },
      },
      tools: [],
      signal,
      credentials: credentialAccess('connection'),
      execution: {
        kind: 'experimental_agent_session_realtime',
        agentSessionRealtime: {
          inspect: vi.fn(async () => ({
            status: 'available' as const,
            activeSessionId: 'session-stale',
            detail: null,
          })),
          start: vi.fn(),
        },
      },
      ui: { diagnostic },
    });
    const prepared = await preparedSession(runtime, signal, 8);
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');

    await runtime.createConnection({
      session: prepared.session,
      attemptId: 8,
      mic: {} as never,
      interruption: { duckGain: 0.2, retainedOutputMaxMs: 250 },
      levels: { onOutputLevel: () => {} },
      media: {
        createSdkHandleConnection: () => { throw new Error('unexpected SDK connection'); },
        createWebRtcConnection,
        createPcmConnection: () => { throw new Error('unexpected PCM connection'); },
      },
      tools: [],
      ui: { diagnostic } as never,
      signal,
      credentials: credentialAccess('connection'),
      execution: {
        kind: 'experimental_agent_session_realtime',
        agentSessionRealtime: {
          inspect: vi.fn(async () => ({
            status: 'available' as const,
            transport: 'webrtc' as const,
          })),
          start: vi.fn(async () => ({
            status: 'started' as const,
            transport: { kind: 'webrtc' as const, answerSdp: 'answer-sdp' },
            handle: createHandle(),
          })),
        },
      },
    });
    const negotiated = createWebRtcConnection.mock.calls[1]?.[0];
    await negotiated?.signaling.exchangeOffer({ offerSdp: 'offer-sdp', signal });

    await runtime.protocol.releasePrepared?.({
      controlSessionId: 'voice-global',
      attemptId: 7,
      reason: { code: 'user_stop' },
    });
    expect(diagnostic).not.toHaveBeenCalled();
    await runtime.protocol.releasePrepared?.({
      controlSessionId: 'voice-global',
      attemptId: 8,
      reason: { code: 'user_stop' },
    });
    await runtime.protocol.releasePrepared?.({
      controlSessionId: 'voice-global',
      attemptId: 8,
      reason: { code: 'user_stop' },
    });

    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith({
      code: 'codex_v3_conversational_transcript_unavailable',
      severity: 'warning',
    });
    expect(runtime.protocol.decodeControl({
      type: 'turn.done',
      turn: { id: 'late-turn', role: 'assistant', transcript: 'Late' },
    })).toEqual([]);
  });

  it('does not classify release before upstream start as transcript unavailable', async () => {
    const runtime = createCodexRealtimeVoiceProviderRuntime();
    const signal = new AbortController().signal;
    const prepared = await preparedSession(runtime, signal, 9);
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');
    const diagnostic = vi.fn();

    await runtime.createConnection({
      session: prepared.session,
      attemptId: 9,
      mic: {} as never,
      interruption: { duckGain: 0.2, retainedOutputMaxMs: 250 },
      levels: { onOutputLevel: () => {} },
      media: {
        createSdkHandleConnection: () => { throw new Error('unexpected SDK connection'); },
        createWebRtcConnection: () => createConnection(),
        createPcmConnection: () => { throw new Error('unexpected PCM connection'); },
      },
      tools: [],
      ui: { diagnostic } as never,
      signal,
      credentials: credentialAccess('connection'),
      execution: {
        kind: 'experimental_agent_session_realtime',
        agentSessionRealtime: {
          inspect: vi.fn(async () => ({
            status: 'available' as const,
            transport: 'webrtc' as const,
          })),
          start: vi.fn(),
        },
      },
    });

    await runtime.protocol.releasePrepared?.({
      controlSessionId: 'voice-global',
      attemptId: 9,
      reason: { code: 'aborted' },
    });

    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('fails closed when the host supplies the wrong execution authority', async () => {
    const runtime = createCodexRealtimeVoiceProviderRuntime();
    const signal = new AbortController().signal;
    const prepared = await preparedSession(runtime, signal);
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');

    await expect(runtime.createConnection({
      session: prepared.session,
      attemptId: 1,
      mic: {} as never,
      interruption: { duckGain: 0.2, retainedOutputMaxMs: 250 },
      levels: { onOutputLevel: () => {} },
      media: {} as never,
      tools: [],
      ui: {} as never,
      signal,
      credentials: credentialAccess('connection'),
      execution: { kind: 'direct_media' },
    })).rejects.toThrow('voice_agent_realtime_execution_authority_required');
  });

  it.each([
    'authentication_required',
    'session_unavailable',
    'unsupported_runtime',
    'update_required',
    'feature_unavailable',
  ] as const)('preserves the typed %s readiness reason for the host policy owner', async (reason) => {
    const runtime = createCodexRealtimeVoiceProviderRuntime();
    const signal = new AbortController().signal;
    const prepared = await preparedSession(runtime, signal, 2);
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');

    await expect(runtime.createConnection({
      session: prepared.session,
      attemptId: 2,
      mic: {} as never,
      interruption: { duckGain: 0.2, retainedOutputMaxMs: 250 },
      levels: { onOutputLevel: () => {} },
      media: {} as never,
      tools: [],
      ui: {} as never,
      signal,
      credentials: credentialAccess('connection'),
      execution: {
        kind: 'experimental_agent_session_realtime',
        agentSessionRealtime: {
          inspect: vi.fn(async () => ({
            status: 'unavailable' as const,
            reason,
            diagnostic: { code: 'fixture_diagnostic', severity: 'error' as const },
          })),
          start: vi.fn(),
        },
      },
    })).rejects.toMatchObject({
      code: reason,
      message: `voice_agent_realtime_${reason}:fixture_diagnostic`,
    });
  });

  it.each([
    {
      label: 'runtime-version update remediation after readiness races',
      result: {
        status: 'unavailable' as const,
        diagnostic: {
          code: 'codex_realtime_runtime_version_unsupported',
          severity: 'error' as const,
        },
      },
      expectedCode: 'update_required',
      expectedMessage:
        'voice_agent_realtime_unavailable:codex_realtime_runtime_version_unsupported',
    },
    {
      label: 'runtime-install remediation after readiness races',
      result: {
        status: 'unavailable' as const,
        diagnostic: {
          code: 'codex_realtime_runtime_unavailable',
          severity: 'error' as const,
        },
      },
      expectedCode: 'unsupported_runtime',
      expectedMessage: 'voice_agent_realtime_unavailable:codex_realtime_runtime_unavailable',
    },
    {
      label: 'authentication remediation after readiness races',
      result: {
        status: 'unavailable' as const,
        diagnostic: {
          code: 'codex_realtime_authentication_required',
          severity: 'error' as const,
        },
      },
      expectedCode: 'authentication_required',
      expectedMessage:
        'voice_agent_realtime_unavailable:codex_realtime_authentication_required',
    },
    {
      label: 'session remediation after disposal races',
      result: {
        status: 'failed' as const,
        diagnostic: {
          code: 'codex_realtime_agent_session_disposed',
          severity: 'error' as const,
        },
      },
      expectedCode: 'session_unavailable',
      expectedMessage:
        'voice_agent_realtime_failed:codex_realtime_agent_session_disposed',
    },
    {
      label: 'retains retry-unavailable diagnostic after the same-thread retry fence',
      result: {
        status: 'unavailable' as const,
        diagnostic: {
          code: 'codex_realtime_retry_unavailable',
          severity: 'error' as const,
        },
      },
      expectedCode: 'codex_realtime_retry_unavailable',
      expectedMessage:
        'voice_agent_realtime_unavailable:codex_realtime_retry_unavailable',
    },
    {
      label: 'retains runtime-restart-required diagnostic after an ambiguous admission',
      result: {
        status: 'failed' as const,
        diagnostic: {
          code: 'codex_realtime_runtime_restart_required',
          severity: 'error' as const,
        },
      },
      expectedCode: 'codex_realtime_runtime_restart_required',
      expectedMessage:
        'voice_agent_realtime_failed:codex_realtime_runtime_restart_required',
    },
    {
      label: 'runtime-update remediation after V3 notification races',
      result: {
        status: 'failed' as const,
        diagnostic: {
          code: 'codex_realtime_version_unsupported',
          severity: 'error' as const,
        },
      },
      expectedCode: 'update_required',
      expectedMessage: 'voice_agent_realtime_failed:codex_realtime_version_unsupported',
    },
    {
      label: 'feature-unavailable remediation after readiness races',
      result: {
        status: 'unavailable' as const,
        diagnostic: {
          code: 'codex_realtime_feature_disabled',
          severity: 'error' as const,
        },
      },
      expectedCode: 'feature_unavailable',
      expectedMessage: 'voice_agent_realtime_unavailable:codex_realtime_feature_disabled',
    },
    {
      label: 'unknown provider diagnostic',
      result: {
        status: 'failed' as const,
        diagnostic: { code: 'upstream_rejected', severity: 'error' as const },
      },
      expectedCode: 'upstream_rejected',
      expectedMessage: 'voice_agent_realtime_failed:upstream_rejected',
    },
    {
      label: 'busy status',
      result: { status: 'busy' as const },
      expectedCode: 'voice_agent_realtime_busy',
      expectedMessage: 'voice_agent_realtime_busy',
    },
    {
      label: 'failed status without a diagnostic',
      // The runtime boundary permits a failed DTO with its optional diagnostic omitted.
      result: {
        status: 'failed' as const,
        diagnostic: undefined,
      } as unknown as AgentSessionRealtimeStartResult,
      expectedCode: 'voice_agent_realtime_failed',
      expectedMessage: 'voice_agent_realtime_failed',
    },
  ])('returns typed $label start failure without a credential, fallback, or manual turn path', async ({
    result,
    expectedCode,
    expectedMessage,
  }) => {
    const runtime = createCodexRealtimeVoiceProviderRuntime();
    const signal = new AbortController().signal;
    const prepared = await preparedSession(runtime, signal, 2);
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');
    const createWebRtcConnection = vi.fn(() => createConnection());

    await runtime.createConnection({
      session: prepared.session,
      attemptId: 2,
      mic: {} as never,
      interruption: { duckGain: 0.2, retainedOutputMaxMs: 250 },
      levels: { onOutputLevel: () => {} },
      media: {
        createSdkHandleConnection: () => { throw new Error('unexpected SDK connection'); },
        createWebRtcConnection,
        createPcmConnection: () => { throw new Error('unexpected PCM connection'); },
      },
      tools: [],
      ui: {} as never,
      signal,
      credentials: credentialAccess('connection'),
      execution: {
        kind: 'experimental_agent_session_realtime',
        agentSessionRealtime: {
          inspect: vi.fn(async () => ({ status: 'available' as const, transport: 'webrtc' as const })),
          start: vi.fn(async () => result),
        },
      },
    });
    const negotiated = createWebRtcConnection.mock.calls[0]?.[0];

    await expect(negotiated?.signaling.exchangeOffer({
      offerSdp: 'offer-sdp',
      signal,
    })).rejects.toMatchObject({
      code: expectedCode,
      message: expectedMessage,
    });
    expect(runtime.encodeTextTurn('delegate this')).toEqual([]);
    expect(runtime.encodePostCancelControls).toBeUndefined();
    expect(runtime.encodePostBargeInControls).toBeUndefined();
  });
});
