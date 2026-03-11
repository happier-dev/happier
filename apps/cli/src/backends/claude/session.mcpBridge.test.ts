import { describe, expect, it, vi } from 'vitest';

import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import type { EnhancedMode } from './loop';

const createHappierMcpBridgeSpy = vi.fn(async (..._args: unknown[]) => ({
  happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
  mcpServers: { happier: { command: 'from_create' } },
}));
vi.mock('@/agent/runtime/createHappierMcpBridge', () => ({
  createHappierMcpBridge: (...args: unknown[]) => createHappierMcpBridgeSpy(...args),
}));

import { Session } from './session';

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

describe('Session (MCP bridge)', () => {
  it('uses a precomputed MCP bridge when provided', async () => {
    const client = createSessionClientStub();
    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      claudeArgs: [],
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      precomputedMcpBridge: {
        mcpServers: { happier: { command: 'precomputed' }, extra: { command: 'extra' } },
        stop: vi.fn(),
      },
    } as any);

    try {
      const out = await session.getOrCreateHappierMcpBridge();
      expect(out.mcpServers).toEqual({ happier: { command: 'precomputed' }, extra: { command: 'extra' } });
    } finally {
      session.cleanup();
    }
  });
});
