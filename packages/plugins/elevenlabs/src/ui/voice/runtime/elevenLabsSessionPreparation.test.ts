import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ElevenLabsVoiceProviderSettingsSchema } from '../../../protocol/voice/index.js';
import { createElevenLabsSessionPreparationService } from './elevenLabsSessionPreparation.js';

const mocks = {
  alert: vi.fn(),
  getCredentials: vi.fn(),
  credentialStatus: vi.fn(),
  mintConversationAuth: vi.fn(),
  fetchToken: vi.fn(),
  presentPaywall: vi.fn(),
};

function settings(input: Readonly<{
  selected?: boolean;
  billingMode: 'happier' | 'byo';
  agentId?: string | null;
  welcome?: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn' }>;
}>) {
  return {
    providerId: input.selected === false ? 'local_conversation' : 'realtime_elevenlabs',
    assistantLanguage: 'fr-FR',
    welcome: input.welcome ?? { enabled: false, mode: 'immediate' as const },
    providerConfig: ElevenLabsVoiceProviderSettingsSchema.parse({
      billingMode: input.billingMode,
      byo: { agentId: input.agentId ?? null },
    }),
  };
}

function createService(project = vi.fn((_raw: unknown) => settings({ billingMode: 'byo', agentId: 'agent-1' }))) {
  return createElevenLabsSessionPreparationService({
    providerId: 'realtime_elevenlabs',
    projectVoiceSettings: project,
    createProviderClient: () => ({
      credentialStatus: mocks.credentialStatus,
      mintConversationAuth: mocks.mintConversationAuth,
    }),
    getCredentials: mocks.getCredentials,
    fetchHostedVoiceToken: mocks.fetchToken,
    presentPaywall: mocks.presentPaywall,
    alert: mocks.alert,
    createMachineError: (input) => input,
  });
}

describe('createElevenLabsSessionPreparationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCredentials.mockResolvedValue({ token: 'token' });
    mocks.credentialStatus.mockResolvedValue({ exists: true });
    mocks.mintConversationAuth.mockResolvedValue({ kind: 'token', value: 'ephemeral-token' });
    mocks.presentPaywall.mockResolvedValue({ purchased: true });
  });

  it('fails closed when the bundled settings owner is absent', async () => {
    const service = createService(vi.fn(() => ({
      ...settings({ billingMode: 'byo' }),
      providerConfig: null,
    })));
    await expect(service.prepare({
      controlSessionId: 'disabled', requestedTargetSessionId: null, retryAfterPaywall: false,
      settings: {}, signal: new AbortController().signal, textOnly: false,
    })).resolves.toMatchObject({ kind: 'declined', error: { reason: 'voice_provider_settings_unavailable' } });
    expect(mocks.fetchToken).not.toHaveBeenCalled();
    expect(mocks.mintConversationAuth).not.toHaveBeenCalled();
  });

  it('fails BYO readiness closed before mint when no agent is configured', async () => {
    const service = createService(vi.fn(() => settings({ billingMode: 'byo', agentId: null })));
    await expect(service.prepare({
      controlSessionId: 'byo', requestedTargetSessionId: null, retryAfterPaywall: false,
      settings: {}, signal: new AbortController().signal, textOnly: false,
    })).resolves.toMatchObject({ kind: 'declined', error: { reason: 'realtime_byo_not_configured' } });
    expect(mocks.credentialStatus).not.toHaveBeenCalled();
  });

  it('uses only broker-minted BYO auth and builds the SDK configuration', async () => {
    const projected = settings({ billingMode: 'byo', agentId: 'agent-1' });
    const service = createService(vi.fn(() => projected));
    const prepared = await service.prepare({
      controlSessionId: 'control-byo', initialContext: 'context', requestedTargetSessionId: null,
      retryAfterPaywall: false, settings: {}, signal: new AbortController().signal, textOnly: false,
    });
    expect(prepared).toMatchObject({ kind: 'prepared', session: { sessionConfig: { token: 'ephemeral-token' } } });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');
    expect(service.buildStartConfig({ prepared: prepared.session, settings: {} })).toMatchObject({
      connectionType: 'webrtc', conversationToken: 'ephemeral-token',
      dynamicVariables: { sessionId: 'control-byo', initialConversationContext: 'context' },
    });
  });

  it('uses signed websocket auth for text-only BYO and appends welcome context', async () => {
    mocks.mintConversationAuth.mockResolvedValueOnce({ kind: 'signed_url', value: 'wss://provider.test/session' });
    const projected = settings({
      billingMode: 'byo', agentId: 'agent-text', welcome: { enabled: true, mode: 'immediate' },
    });
    const service = createService(vi.fn(() => projected));
    const prepared = await service.prepare({
      controlSessionId: 'control-text', initialContext: 'base', requestedTargetSessionId: null,
      retryAfterPaywall: false, settings: {}, signal: new AbortController().signal, textOnly: true,
    });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');
    expect(prepared.session.sessionConfig).toMatchObject({ signedUrl: 'wss://provider.test/session', textOnly: true });
    expect(String((prepared.session.sessionConfig as Record<string, unknown>).initialContext)).toContain('friendly greeting');
  });

  it('reports selection without provider work', () => {
    const projected = settings({ billingMode: 'byo', agentId: 'agent' });
    const service = createService(vi.fn(() => projected));
    expect(service.isSelected({})).toBe(true);
    expect(mocks.credentialStatus).not.toHaveBeenCalled();
  });

  it('retries hosted mint once after a purchased paywall and preserves lease identity', async () => {
    mocks.fetchToken
      .mockResolvedValueOnce({ allowed: false, reason: 'quota_exceeded' })
      .mockResolvedValueOnce({
        allowed: true, token: 'hosted-token', leaseId: 'lease-hosted',
        bindingNonce: 'nonce-hosted', expiresAtMs: 5_000,
      });
    const service = createService(vi.fn(() => settings({ billingMode: 'happier' })));
    await expect(service.prepare({
      controlSessionId: 'hosted', requestedTargetSessionId: 'target', retryAfterPaywall: false,
      settings: {}, signal: new AbortController().signal, textOnly: false,
    })).resolves.toMatchObject({
      kind: 'prepared', session: {
        sessionConfig: { token: 'hosted-token', leaseId: 'lease-hosted', bindingNonce: 'nonce-hosted' },
      },
    });
    expect(mocks.presentPaywall).toHaveBeenCalledTimes(1);
    expect(mocks.fetchToken).toHaveBeenCalledTimes(2);
  });
});
