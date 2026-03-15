import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { SessionClientPort } from '@/api/session/sessionClientPort';

const mockClaudeLocalLauncher = vi.fn(async (_session: any) => ({ type: 'exit', code: 0 } as const));

vi.mock('./claudeLocalLauncher', () => ({
  claudeLocalLauncher: mockClaudeLocalLauncher,
}));

vi.mock('./claudeRemoteLauncher', () => ({
  claudeRemoteLauncher: vi.fn(async () => 'exit' as const),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

function createSessionClientStub(): SessionClientPort {
  const client = Object.assign(new EventEmitter(), {
    sessionId: 'api-session-1',
    rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => undefined) },
    sendSessionEvent: vi.fn(),
    sendClaudeSessionMessage: vi.fn(),
    sendAgentMessage: vi.fn(),
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn(),
    keepAlive: vi.fn(),
    getMetadataSnapshot: vi.fn(() => null),
    waitForMetadataUpdate: vi.fn(async () => true),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  });
  return client as unknown as SessionClientPort;
}

describe('loop (Agent Teams env)', () => {
  it('seeds Session.claudeCodeExperimentalAgentTeamsEnabled from loop options for the initial local spawn', async () => {
    const client = createSessionClientStub();
    const queue = new MessageQueue2<any>(() => 'mode');

    const { loop } = await import('./loop');

    await loop({
      path: '/tmp',
      onModeChange: () => {},
      session: client,
      messageQueue: queue,
      hookSettingsPath: '/tmp/hooks.json',
      startingMode: 'local',
      claudeCodeExperimentalAgentTeamsEnabled: true,
    } as any);

    expect(mockClaudeLocalLauncher).toHaveBeenCalled();
    const sessionArg = mockClaudeLocalLauncher.mock.calls[0]?.[0];
    expect(sessionArg?.claudeCodeExperimentalAgentTeamsEnabled).toBe(true);
  });
});
