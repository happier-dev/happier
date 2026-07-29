import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate } from './createRuntimeContribution.js';
import * as publicVoiceModule from './index.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

const SENTINEL_TOOL = Object.freeze({
  name: 'sendSessionMessage',
  description: 'Send a message to the selected coding session.',
  parameters: Object.freeze({ type: 'object', properties: Object.freeze({ message: Object.freeze({ type: 'string' }) }) }),
});
const VALID_CONFIG = Object.freeze({
  model: Object.freeze({ kind: 'pinned' as const, id: 'gpt-realtime' }),
  voice: 'marin',
  instructions: null,
  turnDetection: 'server_vad' as const,
  inputTranscriptionModel: null,
});

function createAccountOperations(
  token = 'ek_short',
  expiresAtMs = Date.now() + 60_000,
) {
  return Object.freeze({
    request: vi.fn(async () => Object.freeze({
      status: 200,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({
        value: token,
        expires_at: Math.floor(expiresAtMs / 1_000),
      })),
    })),
  });
}

function registerPublicLeaf() {
  const register = vi.fn();
  activate({ voiceProviders: { register } });
  return Object.freeze({ register, leaf: register.mock.calls[0]![1] });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI Realtime runtime contribution', () => {
  it('exports direct public activation and mints auth through the attempt-scoped account operation', async () => {
    const register = vi.fn();
    const activate = (
      publicVoiceModule as Readonly<{
        activate?: (api: Readonly<{ voiceProviders: Readonly<{ register: typeof register }> }>) => void;
      }>
    ).activate;

    expect(activate).toBeTypeOf('function');
    if (!activate) return;
    activate({ voiceProviders: { register } });

    expect(register).toHaveBeenCalledTimes(1);
    const leaf = register.mock.calls[0]![1];
    const request = vi.fn(async () => Object.freeze({
      status: 200,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({
        value: 'short-lived-openai-artifact',
        expires_at: Math.floor(Date.now() / 1_000) + 60,
      })),
    }));

    const prepared = await leaf.protocol.prepare({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: 'initial',
      request: null,
      signal: new AbortController().signal,
      platform: 'web',
      providerConfig: {
        model: { kind: 'pinned', id: 'gpt-realtime' },
        voice: 'marin',
        instructions: null,
        turnDetection: 'server_vad',
        inputTranscriptionModel: null,
      },
      accountOperations: Object.freeze({ request }),
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(prepared).toMatchObject({
      kind: 'prepared',
      session: {
        config: { preparationId: expect.any(Number) },
      },
    });
    if (prepared.kind === 'prepared') {
      expect(JSON.stringify(prepared.session)).not.toContain('short-lived-openai-artifact');
    }
  });

  it('uses a valid manifest-local activation id without changing the stable provider identity', () => {
    const ingested = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(ingested.ok).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.id).toBe('realtime-openai');

    const { register } = registerPublicLeaf();

    expect(register.mock.calls[0]?.[0]).toBe('realtime-openai');
  });

  it('keeps preflight daemon-independent and defers secret materialization to prepare', async () => {
    const accountOperations = createAccountOperations('must-not-mint');
    const { register } = registerPublicLeaf();

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toBe('realtime-openai');
    const leaf = register.mock.calls[0]![1];
    expect(leaf.outputLevelMeter).toBe('unavailable');
    await expect(leaf.protocol.preflight({
      controlSessionId: 'voice', attemptId: 1, request: null, signal: new AbortController().signal,
      platform: 'web', providerConfig: VALID_CONFIG,
    })).resolves.toEqual({ kind: 'ready' });
    expect(accountOperations.request).not.toHaveBeenCalled();

    await leaf.protocol.prepare({
      controlSessionId: 'voice', attemptId: 1, reason: 'initial', request: null, signal: new AbortController().signal,
      platform: 'web', providerConfig: VALID_CONFIG, accountOperations,
    });
    await leaf.protocol.prepare({
      controlSessionId: 'voice', attemptId: 1, reason: 'auth_refresh', request: null, signal: new AbortController().signal,
      platform: 'web', providerConfig: VALID_CONFIG, accountOperations,
    });
    expect(accountOperations.request).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the host account operation cannot mint WebRTC auth', async () => {
    const { leaf } = registerPublicLeaf();
    await expect(leaf.protocol.prepare({
      controlSessionId: 'voice', attemptId: 1, reason: 'initial', request: null, signal: new AbortController().signal,
      platform: 'web',
      providerConfig: VALID_CONFIG,
      accountOperations: Object.freeze({
        request: async () => {
          throw Object.assign(new Error('credential_unavailable'), { code: 'credential_unavailable' });
        },
      }),
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('scopes prepared auth to its attempt and invalidates it on reprepare, release, and abort', async () => {
    const { leaf } = registerPublicLeaf();
    const prepare = async (
      token: string,
      signal = new AbortController().signal,
      attemptId = 1,
    ) => await leaf.protocol.prepare({
      controlSessionId: 'voice',
      attemptId,
      reason: 'initial',
      request: null,
      signal,
      platform: 'web',
      providerConfig: VALID_CONFIG,
      accountOperations: createAccountOperations(token),
    });
    const createConnection = async (
      session: Readonly<{ config: unknown; safeMetadata: unknown }>,
      attemptId = 1,
    ) => await leaf.createConnection({
      session,
      attemptId,
      mic: { getStream: () => null },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 },
      levels: { onOutputLevel: vi.fn() },
      media: {
        createWebRtcConnection: vi.fn(() => Object.freeze({ kind: 'webrtc' as const })),
        createPcmConnection: vi.fn(),
      },
      tools: [],
      ui: {},
      signal: new AbortController().signal,
      execution: { kind: 'direct_media' },
    });

    const stale = await prepare('short-lived-stale');
    expect(stale.kind).toBe('prepared');
    if (stale.kind !== 'prepared') return;
    expect(JSON.stringify(stale.session)).not.toContain('short-lived-stale');

    const released = await prepare('short-lived-released');
    expect(released.kind).toBe('prepared');
    if (released.kind !== 'prepared') return;
    await expect(createConnection(stale.session)).rejects.toThrow('voice_webrtc_preparation_invalid');

    expect(leaf.protocol.releasePrepared).toBeTypeOf('function');
    await leaf.protocol.releasePrepared?.({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: { code: 'user_stop' },
    });
    await expect(createConnection(released.session)).rejects.toThrow('voice_webrtc_preparation_invalid');

    const abortController = new AbortController();
    const abortedRequest = vi.fn(async () => {
      abortController.abort();
      return createAccountOperations('short-lived-aborted').request();
    });
    await expect(leaf.protocol.prepare({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: 'initial',
      request: null,
      signal: abortController.signal,
      platform: 'web',
      providerConfig: VALID_CONFIG,
      accountOperations: Object.freeze({ request: abortedRequest }),
    })).resolves.toEqual({ kind: 'aborted' });

    const active = await prepare(
      'short-lived-active',
      new AbortController().signal,
      2,
    );
    expect(active.kind).toBe('prepared');
    if (active.kind !== 'prepared') return;
    await leaf.protocol.releasePrepared?.({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: { code: 'user_stop' },
    });
    await expect(createConnection(active.session, 2)).resolves.toEqual({ kind: 'webrtc' });
    await expect(createConnection(active.session, 2)).rejects.toThrow('voice_webrtc_preparation_invalid');
  });

  it('registers only the public executable leaf while keeping OpenAI WebRTC semantics provider-owned', async () => {
    const connection = Object.freeze({ kind: 'webrtc' as const });
    const createWebRtcConnection = vi.fn(() => connection);
    const { register } = registerPublicLeaf();
    expect(register).toHaveBeenCalledWith('realtime-openai', expect.objectContaining({
      protocol: expect.any(Object),
      createConnection: expect.any(Function),
      encodeContextUpdate: expect.any(Function),
      encodeTextTurn: expect.any(Function),
      encodePostCancelControls: expect.any(Function),
      encodePostBargeInControls: expect.any(Function),
    }));
    const leaf = register.mock.calls[0]![1];
    expect(leaf).not.toHaveProperty('resolveSurfaceCapabilities');
    await expect(leaf.protocol.preflight({
      controlSessionId: 'voice', attemptId: 1, request: null, signal: new AbortController().signal,
      platform: 'web', providerConfig: VALID_CONFIG,
    })).resolves.toEqual({ kind: 'ready' });
    expect(leaf.encodeTextTurn('hello')).toEqual([
      {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      },
      { type: 'response.create' },
    ]);
    expect(leaf.encodeContextUpdate('workspace changed')).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: '[Context update]\nworkspace changed' }],
        },
      },
    ]);
    expect(leaf.encodePostCancelControls()).toEqual([{ type: 'output_audio_buffer.clear' }]);
    expect(leaf.encodePostBargeInControls()).toEqual([{ type: 'response.create' }]);
    const prepared = await leaf.protocol.prepare({
      controlSessionId: 'voice', attemptId: 1, reason: 'initial', request: null, signal: new AbortController().signal,
      platform: 'web', providerConfig: VALID_CONFIG, accountOperations: createAccountOperations(),
    });
    expect(prepared).toMatchObject({ kind: 'prepared', session: { safeMetadata: { providerId: 'realtime_openai' } } });
    expect(JSON.stringify(prepared.session.safeMetadata)).not.toContain('ek_short');

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init).toMatchObject({ method: 'POST', body: 'offer-sdp' });
      return new Response('answer-sdp', { status: 201 });
    }));
    await expect(leaf.createConnection({
      session: prepared.session,
      attemptId: 1,
      mic: { getStream: () => null },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 },
      levels: { onOutputLevel: vi.fn() },
      media: { createWebRtcConnection, createPcmConnection: vi.fn() },
      tools: [SENTINEL_TOOL],
      ui: {},
      signal: new AbortController().signal,
      execution: { kind: 'direct_media' },
    })).resolves.toBe(connection);
    const negotiated = createWebRtcConnection.mock.calls[0]![0];
    await expect(negotiated.signaling.exchangeOffer({
      offerSdp: 'offer-sdp',
      signal: new AbortController().signal,
    })).resolves.toEqual({ answerSdp: 'answer-sdp' });
    const sendJson = vi.fn(async () => undefined);
    await negotiated.control.onOpen({ sendJson });
    expect(sendJson).toHaveBeenCalledWith({
      type: 'session.update',
      session: {
        type: 'realtime',
        tools: [{ type: 'function', ...SENTINEL_TOOL }],
        tool_choice: 'auto',
      },
    });
    expect(negotiated.control.label).toBe('oai-events');
    expect(createWebRtcConnection).toHaveBeenCalledWith({
      signaling: expect.objectContaining({ exchangeOffer: expect.any(Function) }),
      control: expect.objectContaining({ label: 'oai-events', onOpen: expect.any(Function) }),
    });
  });
});
