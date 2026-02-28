import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { Session } from './session';

const mockClaudeLocal = vi.fn(async (_opts: any) => {});

vi.mock('./claudeLocal', () => ({
  claudeLocal: mockClaudeLocal,
  ExitCodeError: class ExitCodeError extends Error {
    exitCode: number;
    constructor(exitCode: number) {
      super(`ExitCodeError(${exitCode})`);
      this.exitCode = exitCode;
    }
  },
}));

vi.mock('./utils/sessionScanner', () => ({
  createSessionScanner: vi.fn(async () => ({
    cleanup: vi.fn(async () => {}),
    onNewSession: vi.fn(),
  })),
}));

vi.mock('@/agent/runtime/createHappierMcpBridge', () => ({
  createHappierMcpBridge: vi.fn(async () => ({
    happierMcpServer: { url: 'http://127.0.0.1:1234', stop: vi.fn() },
    mcpServers: {
      happier: { command: 'node', args: ['happier-mcp.mjs', '--url', 'http://127.0.0.1:1234'] },
    },
  })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}));

function createSessionStub(): Session {
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

  const queue = new MessageQueue2<any>(() => 'mode');
  return new Session({
    client: client as unknown as SessionClientPort,
    path: '/tmp',
    logPath: '/tmp/log',
    sessionId: null,
    messageQueue: queue,
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
    jsRuntime: 'node',
    startedBy: 'terminal',
  });
}

describe('claudeLocalLauncher (Agent Teams env)', () => {
  it('passes Agent Teams env overlay to the Claude local spawn when enabled', async () => {
    const session = createSessionStub();
    (session as any).claudeCodeExperimentalAgentTeamsEnabled = true;

    let firstOpts: any = null;
    mockClaudeLocal.mockImplementation(async (opts: any) => {
      if (!firstOpts) firstOpts = opts;
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(result).toEqual({ type: 'exit', code: 0 });
    expect(mockClaudeLocal).toHaveBeenCalled();
    expect(firstOpts?.envOverlay?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });
});
