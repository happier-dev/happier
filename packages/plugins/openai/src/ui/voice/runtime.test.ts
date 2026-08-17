import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import type {
  VoiceAccountOperationService,
  VoiceCredentialAccess,
} from '@happier-dev/plugin-sdk/voice';
import type { RealtimeVoiceProviderRuntime } from '@happier-dev/plugin-sdk/voice/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate } from './runtime.js';
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
        session: {
          type: 'realtime',
          object: 'realtime.session',
          id: 'sess_current_contract',
          model: VALID_CONFIG.model.id,
        },
      })),
    })),
  });
}

function createCredentialAccess<P extends 'prepare' | 'connection'>(
  phase: P,
  mediated: VoiceAccountOperationService | null,
): VoiceCredentialAccess<P> {
  return Object.freeze({ phase, mediated, raw: null });
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
  it.each(['web', 'ios', 'android'] as const)(
    'admits the same public runtime on %s',
    async (platform) => {
      const { leaf } = registerPublicLeaf();

      await expect(leaf.protocol.preflight({
        controlSessionId: 'voice',
        attemptId: 1,
        request: null,
        signal: new AbortController().signal,
        platform,
        providerConfig: VALID_CONFIG,
      })).resolves.toEqual({ kind: 'ready' });

      await expect(leaf.protocol.prepare({
        controlSessionId: 'voice',
        attemptId: 1,
        reason: 'initial',
        request: null,
        signal: new AbortController().signal,
        platform,
        providerConfig: VALID_CONFIG,
        credentials: createCredentialAccess('prepare', createAccountOperations()),
      })).resolves.toMatchObject({ kind: 'prepared' });
    },
  );

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
        session: {
          type: 'realtime',
          object: 'realtime.session',
          id: 'sess_current_contract',
          model: 'gpt-realtime',
        },
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
      credentials: createCredentialAccess('prepare', Object.freeze({ request })),
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

  it.each([
    ['switches to another account', createAccountOperations('account-b')],
    ['deletes the admitted account', Object.freeze({
      request: vi.fn(async () => {
        throw Object.assign(new Error('credential_unavailable'), {
          code: 'credential_unavailable',
        });
      }),
    })],
  ] as const)('keeps minted auth attempt-local when the source %s before reconnect', async (
    _change,
    changedAccountOperations,
  ) => {
    const accountOperations = createAccountOperations('account-a');
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

    const initial = await leaf.protocol.prepare({
      controlSessionId: 'voice', attemptId: 1, reason: 'initial', request: null, signal: new AbortController().signal,
      platform: 'web', providerConfig: VALID_CONFIG,
      credentials: createCredentialAccess('prepare', accountOperations),
    });
    const reconnect = await leaf.protocol.prepare({
      controlSessionId: 'voice', attemptId: 1, reason: 'reconnect', request: null, signal: new AbortController().signal,
      platform: 'web', providerConfig: VALID_CONFIG,
      credentials: createCredentialAccess('prepare', changedAccountOperations),
    });
    expect(initial).toMatchObject({ kind: 'prepared' });
    expect(reconnect).toMatchObject({ kind: 'prepared' });
    expect(accountOperations.request).toHaveBeenCalledTimes(1);
    expect(changedAccountOperations.request).not.toHaveBeenCalled();

    await leaf.protocol.releasePrepared?.({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: { code: 'user_stop' },
    });
    await expect(leaf.protocol.prepare({
      controlSessionId: 'voice', attemptId: 1, reason: 'reconnect', request: null, signal: new AbortController().signal,
      platform: 'web', providerConfig: VALID_CONFIG,
      credentials: createCredentialAccess('prepare', changedAccountOperations),
    })).resolves.toEqual({ kind: 'declined', code: 'voice_auth_expired' });
    expect(changedAccountOperations.request).not.toHaveBeenCalled();

    await leaf.protocol.prepare({
      controlSessionId: 'voice', attemptId: 2, reason: 'initial', request: null, signal: new AbortController().signal,
      platform: 'web', providerConfig: VALID_CONFIG,
      credentials: createCredentialAccess('prepare', changedAccountOperations),
    }).catch(() => undefined);
    expect(changedAccountOperations.request).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the host account operation cannot mint WebRTC auth', async () => {
    const { leaf } = registerPublicLeaf();
    await expect(leaf.protocol.prepare({
      controlSessionId: 'voice', attemptId: 1, reason: 'initial', request: null, signal: new AbortController().signal,
      platform: 'web',
      providerConfig: VALID_CONFIG,
      credentials: createCredentialAccess('prepare', Object.freeze({
        request: async () => {
          throw Object.assign(new Error('credential_unavailable'), { code: 'credential_unavailable' });
        },
      })),
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('scopes prepared auth to its attempt, rearms it only for reconnect, and fails closed after expiry', async () => {
    const { leaf } = registerPublicLeaf();
    const prepare = async (
      token: string,
      signal = new AbortController().signal,
      attemptId = 1,
      expiresAtMs = Date.now() + 60_000,
    ) => await leaf.protocol.prepare({
      controlSessionId: 'voice',
      attemptId,
      reason: 'initial',
      request: null,
      signal,
      platform: 'web',
      providerConfig: VALID_CONFIG,
      credentials: createCredentialAccess('prepare', createAccountOperations(token, expiresAtMs)),
    });
    type NegotiatedWebRtcInput = Parameters<
      Parameters<RealtimeVoiceProviderRuntime['createConnection']>[0]['media']['createWebRtcConnection']
    >[0];
    const negotiatedInputs: NegotiatedWebRtcInput[] = [];
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
        createWebRtcConnection: vi.fn((input: NegotiatedWebRtcInput) => {
          negotiatedInputs.push(input);
          return Object.freeze({ kind: 'webrtc' as const });
        }),
        createPcmConnection: vi.fn(),
      },
      tools: [],
      ui: {},
      signal: new AbortController().signal,
      execution: { kind: 'direct_media' },
      credentials: createCredentialAccess('connection', null),
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
      credentials: createCredentialAccess(
        'prepare',
        Object.freeze({ request: abortedRequest }),
      ),
    })).resolves.toEqual({ kind: 'aborted' });

    const offerAuthorizations: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      offerAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response('answer-sdp', { status: 201 });
    }));

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

    const changedAccountOperations = createAccountOperations('short-lived-account-b');
    const reconnect = await leaf.protocol.prepare({
      controlSessionId: 'voice',
      attemptId: 2,
      reason: 'reconnect',
      request: null,
      signal: new AbortController().signal,
      platform: 'web',
      providerConfig: VALID_CONFIG,
      credentials: createCredentialAccess('prepare', changedAccountOperations),
    });
    expect(reconnect.kind).toBe('prepared');
    if (reconnect.kind !== 'prepared') return;
    expect(changedAccountOperations.request).not.toHaveBeenCalled();
    await expect(createConnection(reconnect.session, 2)).resolves.toEqual({ kind: 'webrtc' });
    await expect(createConnection(reconnect.session, 2)).rejects.toThrow('voice_webrtc_preparation_invalid');

    for (const input of negotiatedInputs) {
      await input.signaling.exchangeOffer({
        offerSdp: 'offer-sdp',
        signal: new AbortController().signal,
      });
    }
    expect(offerAuthorizations).toEqual([
      'Bearer short-lived-active',
      'Bearer short-lived-active',
    ]);

    const now = Date.now();
    const expiring = await prepare(
      'short-lived-expiring',
      new AbortController().signal,
      3,
      now + 60_000,
    );
    expect(expiring.kind).toBe('prepared');
    if (expiring.kind !== 'prepared') return;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    await expect(createConnection(expiring.session, 3)).rejects.toMatchObject({
      code: 'voice_auth_expired',
    });
    nowSpy.mockRestore();

    const authRefresh = await prepare(
      'short-lived-auth-refresh',
      new AbortController().signal,
      4,
    );
    expect(authRefresh.kind).toBe('prepared');
    if (authRefresh.kind !== 'prepared') return;
    const remintOperations = createAccountOperations('must-not-remint');
    await expect(leaf.protocol.prepare({
      controlSessionId: 'voice',
      attemptId: 4,
      reason: 'auth_refresh',
      request: null,
      signal: new AbortController().signal,
      platform: 'web',
      providerConfig: VALID_CONFIG,
      credentials: createCredentialAccess('prepare', remintOperations),
    })).resolves.toEqual({ kind: 'declined', code: 'voice_auth_expired' });
    expect(remintOperations.request).not.toHaveBeenCalled();
    await expect(createConnection(authRefresh.session, 4)).rejects.toThrow(
      'voice_webrtc_preparation_invalid',
    );
    await expect(leaf.protocol.refreshAuth?.(new AbortController().signal)).resolves.toBe(false);
  });

  it('registers only the public executable leaf while keeping OpenAI WebRTC semantics provider-owned', async () => {
    const connection = Object.freeze({ kind: 'webrtc' as const });
    const createWebRtcConnection = vi.fn(() => connection);
    const { register } = registerPublicLeaf();
    expect(register).toHaveBeenCalledWith('realtime-openai', expect.objectContaining({
      kind: 'conversation',
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
      platform: 'web', providerConfig: VALID_CONFIG,
      credentials: createCredentialAccess('prepare', createAccountOperations()),
    });
    expect(prepared).toMatchObject({ kind: 'prepared', session: { safeMetadata: { model: 'gpt-realtime' } } });
    expect(prepared.session.safeMetadata).not.toHaveProperty('providerId');
    expect(JSON.stringify(prepared.session.safeMetadata)).not.toContain('ek_short');

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init).toMatchObject({ method: 'POST', body: 'offer-sdp' });
      return new Response('answer-sdp', { status: 201 });
    }));
    const connectionCredentialRequest = vi.fn(async () => {
      throw new Error('createConnection must not reacquire long-lived credentials');
    });
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
      credentials: createCredentialAccess('connection', Object.freeze({
        request: connectionCredentialRequest,
      })),
    })).resolves.toBe(connection);
    expect(connectionCredentialRequest).not.toHaveBeenCalled();
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
