import type { VoiceCredentialAccess } from '@happier-dev/plugin-sdk/voice';
import type { VoiceHostedConversationService } from '@happier-dev/plugin-sdk/voice/client';
import { describe, expect, it, vi } from 'vitest';

import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, ElevenLabsVoiceProviderSettingsSchema } from '../../../protocol/voice/index.js';
import { createElevenLabsProtocolAdapter } from './protocol.js';
import { createElevenLabsEventMapper } from './eventMapper.js';
import { createElevenLabsSessionLifecycle } from './sessionLifecycle.js';
import { createElevenLabsSessionPreparationService } from './sessionPreparation.js';

function createFixture(billingMode: 'byo' | 'happier' = 'byo') {
  // Only mediated HTTP and hosted-conversation operations replace system
  // boundaries; preparation, lifecycle and event decoding stay real.
  const request = vi.fn(async (input: Readonly<{ operationId: string }>) => ({
    status: 200,
    finalUrl: input.operationId === 'agent'
      ? 'https://api.elevenlabs.io/v1/convai/agents/agent-1'
      : 'https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent-1',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(input.operationId === 'agent' ? {
      agent_id: 'agent-1', tags: ['happier_voice_config_v1'],
      platform_settings: {
        auth: { enable_auth: true },
        overrides: { conversation_config_override: {
          agent: { first_message: true, language: true, prompt: { prompt: true } },
          conversation: { text_only: true },
        } },
      },
    } : { token: 'ephemeral-token' })),
  }));
  const credentials = {
    phase: 'prepare', mediated: { request }, raw: null,
  } satisfies VoiceCredentialAccess<'prepare'>;
  const hostedConversation = {
    start: vi.fn(async () => ({
      allowed: true as const, leaseId: 'lease-1', bindingNonce: 'binding-1',
      token: 'ephemeral-token', expiresAtMs: 60_000,
    })),
    complete: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  } satisfies VoiceHostedConversationService;
  const providerConfig = ElevenLabsVoiceProviderSettingsSchema.parse({
    ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, billingMode, agentId: 'agent-1',
  });
  const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
  const preparation = createElevenLabsSessionPreparationService({
    providerId,
    projectVoiceSettings: (settings) => ({ providerId, assistantLanguage: null, providerConfig: settings }),
    alert() {},
  });
  // Compose the same lease lookup/release bindings as the public runtime, so
  // a completed lease cannot be returned again during adapter cleanup.
  const hostedByLeaseId = new Map<string, Pick<VoiceHostedConversationService, 'complete' | 'abort'>>();
  const lifecycle = createElevenLabsSessionLifecycle({
    takeHostedConversation: (leaseId) => hostedByLeaseId.get(leaseId) ?? null,
    forgetHostedConversation: (leaseId) => { hostedByLeaseId.delete(leaseId); },
  });
  const runtime = createElevenLabsProtocolAdapter({
    preparation, lifecycle, eventMapper: createElevenLabsEventMapper(),
    onDiagnosticError() {},
    rememberHostedConversation: (leaseId, service) => { hostedByLeaseId.set(leaseId, service); },
  });
  const prepare = (attemptId: number, initialContext = 'context') => runtime.adapter.prepare({
    controlSessionId: 'control-1', attemptId, reason: 'initial',
    request: { initialContext, requestedTargetSessionId: 'target-1', textOnly: false },
    platform: 'web', providerConfig, credentials,
    providerConversation: null, hostedConversation: billingMode === 'happier' ? hostedConversation : null,
    signal: new AbortController().signal,
  });
  return { runtime, prepare, hostedConversation };
}

describe('createElevenLabsProtocolAdapter', () => {
  it('maps controller preparation into provider-owned session config and lifecycle metadata', async () => {
    const { runtime, prepare, hostedConversation } = createFixture();
    await expect(prepare(1)).resolves.toEqual({
      kind: 'prepared',
      session: {
        config: {
          conversationToken: 'ephemeral-token', connectionType: 'webrtc', textOnly: false,
          dynamicVariables: { sessionId: 'control-1', initialConversationContext: 'context' },
          overrides: { conversation: { textOnly: false }, agent: {} },
        },
        initialContextDelivery: 'prepared',
        safeMetadata: { billingMode: 'byo', expiresAtMs: null },
      },
    });
    await expect(prepare(2, 'replacement context')).resolves.toMatchObject({
      kind: 'prepared', session: { config: { dynamicVariables: { initialConversationContext: 'replacement context' } } },
    });
    await runtime.adapter.releasePrepared?.({ controlSessionId: 'control-1', attemptId: 1, reason: { code: 'replaced' } });
    runtime.handleSessionIdentity({ controlSessionId: 'control-1', conversationId: 'conversation-1' });
    await runtime.endSession();
    expect(hostedConversation.start).not.toHaveBeenCalled();
    expect(hostedConversation.complete).not.toHaveBeenCalled();
    expect(hostedConversation.abort).not.toHaveBeenCalled();
  });

  it('keeps raw ElevenLabs event semantics in the provider leaf and emits canonical transcript events', async () => {
    const { runtime, prepare } = createFixture();
    await prepare(1);
    expect(runtime.adapter.decodeControl({ type: 'elevenlabs.mode', mode: 'speaking' }))
      .toEqual([{ type: 'assistant_output_started' }]);
    expect(runtime.adapter.decodeControl({ type: 'elevenlabs.mode', mode: 'listening' }))
      .toEqual([{ type: 'assistant_output_stopped' }]);
    expect(runtime.adapter.decodeControl({ type: 'elevenlabs.output_audio' })).toEqual([]);
    expect(runtime.adapter.decodeControl({
      type: 'future.provider.event', token: 'sentinel-secret-token', transcript: 'sentinel-private-transcript',
    })).toEqual([]);
  });

  it('preserves the exact-message text payload for the SDK connection', () => {
    const { runtime } = createFixture();
    expect(runtime.adapter.encodeTurnControl('send_exact_message', { text: 'Keep this exact message.' }))
      .toEqual({ type: 'voice.user_text', text: 'Keep this exact message.' });
    expect(runtime.adapter.encodeTurnControl('send_exact_message', {})).toBeNull();
  });

  it('settles the current hosted provider identity through the real lifecycle', async () => {
    const { runtime, prepare, hostedConversation } = createFixture('happier');
    const prepared = await prepare(1);
    if (prepared.kind !== 'prepared') throw new Error('Expected a prepared hosted session');
    expect(prepared.session.safeMetadata).toEqual({ billingMode: 'happier', expiresAtMs: 60_000 });
    runtime.handleSessionIdentity({ controlSessionId: 'control-1', conversationId: 'conversation-hosted' });
    await runtime.endSession();
    expect(hostedConversation.complete.mock.calls).toEqual([[{ providerConversationId: 'conversation-hosted' }]]);
    expect(hostedConversation.abort).not.toHaveBeenCalled();
  });

  it('discards prepared provider state when the controller tears down before session identity', async () => {
    const { runtime, prepare, hostedConversation } = createFixture('happier');
    await expect(prepare(1)).resolves.toMatchObject({
      kind: 'prepared', session: { safeMetadata: { billingMode: 'happier', expiresAtMs: 60_000 } },
    });
    expect(hostedConversation.start).toHaveBeenCalledWith({ sessionId: 'target-1' });
    await runtime.adapter.releasePrepared?.({ controlSessionId: 'control-1', attemptId: 1, reason: { code: 'error' } });
    runtime.handleSessionIdentity({ controlSessionId: 'control-1', conversationId: 'late-identity' });
    await runtime.endSession();
    expect(hostedConversation.abort).toHaveBeenCalledTimes(1);
    expect(hostedConversation.complete).not.toHaveBeenCalled();
  });
});
