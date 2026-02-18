import { describe, expect, it, vi } from 'vitest';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { EnhancedMode } from './loop';

function createSessionClientStub(overrides?: Partial<SessionClientPort>): SessionClientPort {
  return {
    sessionId: 'session-test',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
      invokeLocal: vi.fn(async () => ({})),
    },
    sendSessionEvent: vi.fn(),
    sendClaudeSessionMessage: vi.fn(),
    sendAgentMessage: vi.fn(),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => null,
    waitForMetadataUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}

async function createSessionWithEnv(client: SessionClientPort, env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  const { Session } = await import('./session');
  const session = new Session({
    client,
    path: '/tmp',
    logPath: '/tmp/log',
    sessionId: null,
    mcpServers: {},
    messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
  });
  return session;
}

describe('Session keepAlive scheduling', () => {
  it('uses a slower keepAlive cadence while idle, and a faster cadence while thinking', async () => {
    vi.useFakeTimers();
    const client = createSessionClientStub({
      keepAlive: vi.fn(),
      sendAgentMessage: vi.fn(),
    });

    const session = await createSessionWithEnv(client, {
      HAPPIER_SESSION_KEEPALIVE_IDLE_MS: '10000',
      HAPPIER_SESSION_KEEPALIVE_THINKING_MS: '2000',
    });

    try {
      // Constructor sends an initial keepAlive immediately.
      expect(client.keepAlive).toHaveBeenCalledTimes(1);

      // Idle: should not tick every 2s.
      vi.advanceTimersByTime(9_999);
      expect(client.keepAlive).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(client.keepAlive).toHaveBeenCalledTimes(2);

      // Thinking: switch cadence to 2s.
      session.onThinkingChange(true);
      expect(client.keepAlive).toHaveBeenCalledTimes(3);

      vi.advanceTimersByTime(1_999);
      expect(client.keepAlive).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(1);
      expect(client.keepAlive).toHaveBeenCalledTimes(4);
    } finally {
      session.cleanup();
      vi.useRealTimers();
    }
  });
});
