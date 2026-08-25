import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
  ElevenLabsVoiceProviderSettingsSchema,
} from '../../../protocol/voice/index.js';
import { createElevenLabsSessionPreparationService } from './sessionPreparation.js';

const mocks = {
  alert: vi.fn(),
  requestAccountOperation: vi.fn(),
  startHostedConversation: vi.fn(),
  completeHostedConversation: vi.fn(),
  abortHostedConversation: vi.fn(),
  presentPaywall: vi.fn(),
};

function settings(input: Readonly<{
  selected?: boolean;
  billingMode: 'happier' | 'byo';
  agentId?: string | null;
  welcome?: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn' }>;
}>) {
  return {
    providerId: input.selected === false ? 'local_conversation' : 'happier.voice.elevenlabs/realtime-elevenlabs',
    assistantLanguage: 'fr-FR',
    welcome: input.welcome ?? { enabled: false, mode: 'immediate' as const },
    providerConfig: ElevenLabsVoiceProviderSettingsSchema.parse({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      billingMode: input.billingMode,
      agentId: input.agentId ?? '',
    }),
  };
}

function createService(
  project = vi.fn((_raw: unknown) => settings({ billingMode: 'byo', agentId: 'agent-1' })),
) {
  return createElevenLabsSessionPreparationService({
    providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
    projectVoiceSettings: project,
    presentPaywall: mocks.presentPaywall,
    alert: mocks.alert,
  });
}

function accountOperations() {
  return Object.freeze({ request: mocks.requestAccountOperation });
}

function credentials() {
  return Object.freeze({
    phase: 'prepare' as const,
    mediated: accountOperations(),
    raw: null,
  });
}

function hostedConversation() {
  return Object.freeze({
    start: mocks.startHostedConversation,
    complete: mocks.completeHostedConversation,
    abort: mocks.abortHostedConversation,
  });
}

describe('createElevenLabsSessionPreparationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestAccountOperation.mockResolvedValue({
      status: 200,
      finalUrl: 'https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent-1',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ token: 'ephemeral-token' })),
    });
    mocks.presentPaywall.mockResolvedValue({ purchased: true });
  });

  it('fails closed when the bundled settings owner is absent', async () => {
    const service = createService(vi.fn(() => ({
      ...settings({ billingMode: 'byo' }),
      providerConfig: null,
    })));
    await expect(service.prepare({
      controlSessionId: 'disabled', requestedTargetSessionId: null, retryAfterPaywall: false,
      settings: {}, credentials: credentials(), hostedConversation: null,
      signal: new AbortController().signal, platform: 'web', textOnly: false,
    })).resolves.toMatchObject({ kind: 'declined', failure: { reason: 'voice_provider_settings_unavailable' } });
    expect(mocks.startHostedConversation).not.toHaveBeenCalled();
    expect(mocks.requestAccountOperation).not.toHaveBeenCalled();
  });

  it('fails closed when the host projects malformed provider settings', async () => {
    const service = createService(vi.fn(() => ({
      ...settings({ billingMode: 'byo' }),
      providerConfig: { billingMode: 'byo', agentId: 42 },
    })));
    await expect(service.prepare({
      controlSessionId: 'invalid', requestedTargetSessionId: null, retryAfterPaywall: false,
      settings: {}, credentials: credentials(), hostedConversation: null,
      signal: new AbortController().signal, platform: 'web', textOnly: false,
    })).resolves.toMatchObject({ kind: 'declined', failure: { reason: 'voice_provider_settings_unavailable' } });
    expect(mocks.startHostedConversation).not.toHaveBeenCalled();
    expect(mocks.requestAccountOperation).not.toHaveBeenCalled();
  });

  it('fails BYO readiness closed before mint when no agent is configured', async () => {
    const service = createService(vi.fn(() => settings({ billingMode: 'byo', agentId: null })));
    await expect(service.prepare({
      controlSessionId: 'byo', requestedTargetSessionId: null, retryAfterPaywall: false,
      settings: {}, credentials: credentials(), hostedConversation: null,
      signal: new AbortController().signal, platform: 'web', textOnly: false,
    })).resolves.toMatchObject({
      kind: 'declined',
      failure: {
        reason: 'realtime_byo_not_configured',
      },
    });
    expect(mocks.alert).toHaveBeenCalledWith(
      'common.error',
      'voice.readiness.settings_missing_required_setting',
    );
  });

  it('requires the declared BYO credential only after the required Agent ID is present', async () => {
    const service = createService(vi.fn(() => settings({ billingMode: 'byo', agentId: 'agent-1' })));
    await expect(service.prepare({
      controlSessionId: 'byo-no-credential',
      requestedTargetSessionId: null,
      retryAfterPaywall: false,
      settings: {},
      credentials: Object.freeze({ phase: 'prepare', mediated: null, raw: null }),
      hostedConversation: null,
      signal: new AbortController().signal,
      platform: 'web',
      textOnly: false,
    })).resolves.toMatchObject({
      kind: 'declined',
      failure: {
        reason: 'voice_provider_credential_unavailable',
      },
    });
    expect(mocks.requestAccountOperation).not.toHaveBeenCalled();
  });

  it('uses short-lived provider auth minted from the account credential and builds the SDK configuration', async () => {
    const projected = settings({ billingMode: 'byo', agentId: 'agent-1' });
    const service = createService(vi.fn(() => projected));
    const prepared = await service.prepare({
      controlSessionId: 'control-byo', initialContext: 'context', requestedTargetSessionId: null,
      retryAfterPaywall: false, settings: {}, credentials: credentials(), hostedConversation: null,
      signal: new AbortController().signal, platform: 'web', textOnly: false,
    });
    expect(prepared).toMatchObject({ kind: 'prepared', session: { sessionConfig: { token: 'ephemeral-token' } } });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');
    expect(service.buildStartConfig({ prepared: prepared.session, settings: {} })).toMatchObject({
      connectionType: 'webrtc', conversationToken: 'ephemeral-token',
      dynamicVariables: { sessionId: 'control-byo', initialConversationContext: 'context' },
    });
    expect(mocks.requestAccountOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'conversation-token',
      parameters: { agentId: 'agent-1' },
    }));
  });

  it('uses signed websocket auth for text-only BYO and appends welcome context', async () => {
    mocks.requestAccountOperation.mockResolvedValueOnce({
      status: 200,
      finalUrl: 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent-text',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ signed_url: 'wss://provider.test/session' })),
    });
    const projected = settings({
      billingMode: 'byo', agentId: 'agent-text', welcome: { enabled: true, mode: 'immediate' },
    });
    const service = createService(vi.fn(() => projected));
    const prepared = await service.prepare({
      controlSessionId: 'control-text', initialContext: 'base', requestedTargetSessionId: null,
      retryAfterPaywall: false, settings: {}, credentials: credentials(), hostedConversation: null,
      signal: new AbortController().signal, platform: 'web', textOnly: true,
    });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');
    expect(prepared.session.sessionConfig).toMatchObject({ signedUrl: 'wss://provider.test/session', textOnly: true });
    expect(String((prepared.session.sessionConfig as Record<string, unknown>).initialContext)).toContain('friendly greeting');
    expect(service.buildStartConfig({ prepared: prepared.session, settings: projected })).toMatchObject({
      connectionType: 'websocket', signedUrl: 'wss://provider.test/session', textOnly: true,
    });
    expect(mocks.requestAccountOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'signed-url',
    }));
  });

  it('uses a WebRTC conversation token for native text-only BYO sessions', async () => {
    mocks.requestAccountOperation.mockImplementationOnce(async (request: Readonly<{
      operationId: string;
    }>) => (
      request.operationId === 'conversation-token'
        ? {
            status: 200,
            finalUrl: 'https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent-native',
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({ token: 'native-token' })),
          }
        : {
            status: 200,
            finalUrl: 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent-native',
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({ signed_url: 'wss://provider.test/native' })),
          }
    ));
    const projected = settings({ billingMode: 'byo', agentId: 'agent-native' });
    const service = createService(vi.fn(() => projected));
    const prepared = await service.prepare({
      controlSessionId: 'control-native', requestedTargetSessionId: null, retryAfterPaywall: false,
      settings: {}, credentials: credentials(), hostedConversation: null,
      signal: new AbortController().signal, platform: 'ios', textOnly: true,
    });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');
    expect(prepared.session.sessionConfig).toMatchObject({ token: 'native-token', textOnly: true });
    expect(prepared.session.sessionConfig).not.toHaveProperty('signedUrl');
    expect(service.buildStartConfig({ prepared: prepared.session, settings: projected })).toMatchObject({
      connectionType: 'webrtc', conversationToken: 'native-token', textOnly: true,
    });
    expect(mocks.requestAccountOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'conversation-token',
    }));
  });

  it('reports selection without provider work', () => {
    const projected = settings({ billingMode: 'byo', agentId: 'agent' });
    const service = createService(vi.fn(() => projected));
    expect(service.isSelected({})).toBe(true);
  });

  it('retries hosted mint once after a purchased paywall and preserves lease identity', async () => {
    mocks.startHostedConversation
      .mockResolvedValueOnce({ allowed: false, reason: 'quota_exceeded' })
      .mockResolvedValueOnce({
        allowed: true, token: 'hosted-token', leaseId: 'lease-hosted',
        bindingNonce: 'nonce-hosted', expiresAtMs: 5_000,
      });
    const service = createService(vi.fn(() => settings({ billingMode: 'happier' })));
    await expect(service.prepare({
      controlSessionId: 'hosted', requestedTargetSessionId: 'target', retryAfterPaywall: false,
      settings: {}, credentials: Object.freeze({ phase: 'prepare', mediated: null, raw: null }), hostedConversation: hostedConversation(),
      signal: new AbortController().signal, platform: 'web', textOnly: false,
    })).resolves.toMatchObject({
      kind: 'prepared', session: {
        sessionConfig: { token: 'hosted-token', leaseId: 'lease-hosted', bindingNonce: 'nonce-hosted' },
      },
    });
    expect(mocks.presentPaywall).toHaveBeenCalledTimes(1);
    expect(mocks.startHostedConversation).toHaveBeenCalledTimes(2);
  });

  it('fails hosted mode closed when bundled hosted authority is unavailable', async () => {
    const service = createService(vi.fn(() => settings({ billingMode: 'happier' })));
    await expect(service.prepare({
      controlSessionId: 'hosted-unavailable', requestedTargetSessionId: null, retryAfterPaywall: false,
      settings: {}, credentials: Object.freeze({ phase: 'prepare', mediated: null, raw: null }), hostedConversation: null,
      signal: new AbortController().signal, platform: 'web', textOnly: false,
    })).resolves.toMatchObject({
      kind: 'declined',
      failure: { reason: 'realtime_hosted_conversation_unavailable' },
    });
    expect(mocks.startHostedConversation).not.toHaveBeenCalled();
  });
});
