import { describe, expect, it, vi } from 'vitest';

import { startChannelBridgeFromEnv } from './startChannelBridgeWorker';

const credentials = {
  token: 'token-1',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array([1, 2, 3]),
  },
};

describe('startChannelBridgeFromEnv', () => {
  it('returns null when telegram token is not configured and no custom adapters are provided', async () => {
    const handle = await startChannelBridgeFromEnv({
      credentials,
      env: {},
    });

    expect(handle).toBeNull();
  });

  it('starts with injected adapters/deps even without telegram env configuration', async () => {
    const stopSpy = vi.fn();
    const adapter = {
      providerId: 'fake',
      pullInboundMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
      stop: stopSpy,
    };

    const deps = {
      listSessions: vi.fn(async () => []),
      resolveSessionIdOrPrefix: vi.fn(async () => ({ ok: false as const, code: 'session_not_found' as const })),
      sendUserMessageToSession: vi.fn(async () => undefined),
      resolveLatestSessionSeq: vi.fn(async () => 0),
      fetchAgentMessagesAfterSeq: vi.fn(async () => []),
      onWarning: vi.fn(),
    };

    const handle = await startChannelBridgeFromEnv({
      credentials,
      env: { HAPPIER_CHANNEL_BRIDGE_TICK_MS: '500' } as NodeJS.ProcessEnv,
      adapters: [adapter],
      deps,
    });

    expect(handle).not.toBeNull();
    handle?.trigger();
    await handle?.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});

