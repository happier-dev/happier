import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  fetchToken: vi.fn(),
  completeSession: vi.fn(),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
  TokenStorage: { getCredentials: mocks.getCredentials },
}));

vi.mock('@/sync/api/voice/apiVoice', () => ({
  fetchHappierVoiceToken: mocks.fetchToken,
  completeHappierVoiceSession: mocks.completeSession,
}));

import { createBundledHostedConversationService } from './bundledConversationRuntimeHost';

describe('createBundledHostedConversationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCredentials.mockResolvedValue({ token: 'account-token' });
    mocks.fetchToken.mockResolvedValue({
      allowed: true,
      token: 'provider-token',
      leaseId: 'lease-1',
      bindingNonce: 'nonce-1',
      expiresAtMs: 12_000,
    });
    mocks.completeSession.mockResolvedValue(undefined);
  });

  it('binds the minted lease to one attempt and completes through the canonical API', async () => {
    const service = createBundledHostedConversationService({
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    await expect(service.start({ sessionId: 'session-1' })).resolves.toEqual({
      allowed: true,
      token: 'provider-token',
      leaseId: 'lease-1',
      bindingNonce: 'nonce-1',
      expiresAtMs: 12_000,
    });
    await service.complete({ providerConversationId: 'provider-conversation-1' });
    await service.complete({ providerConversationId: 'ignored-second-completion' });

    expect(mocks.fetchToken).toHaveBeenCalledWith(
      { token: 'account-token' },
      expect.objectContaining({ sessionId: 'session-1' }),
    );
    expect(mocks.completeSession).toHaveBeenCalledTimes(1);
    expect(mocks.completeSession).toHaveBeenCalledWith(
      { token: 'account-token' },
      {
        leaseId: 'lease-1',
        providerConversationId: 'provider-conversation-1',
      },
    );
  });

  it('aborts in-flight admission without creating a second server settlement writer', async () => {
    let admissionStarted = false;
    let observedAbort = false;
    mocks.fetchToken.mockImplementationOnce(async (_credentials, input) => {
      admissionStarted = true;
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => {
        observedAbort = input.signal.aborted;
        resolve();
      }, { once: true }));
      throw Object.assign(new Error('aborted'), { code: 'aborted' });
    });
    const service = createBundledHostedConversationService({
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    const start = service.start({ sessionId: null });
    await vi.waitFor(() => expect(admissionStarted).toBe(true));
    await service.abort();
    await expect(start).rejects.toMatchObject({ code: 'aborted' });

    expect(observedAbort).toBe(true);
    expect(mocks.completeSession).not.toHaveBeenCalled();
  });

  it('rejects admission after the owning Voice generation is revoked', async () => {
    const service = createBundledHostedConversationService({
      signal: new AbortController().signal,
      isCurrent: () => false,
    });

    await expect(service.start({ sessionId: null })).rejects.toMatchObject({
      code: 'hosted_conversation_generation_revoked',
    });
    expect(mocks.fetchToken).not.toHaveBeenCalled();
  });
});
