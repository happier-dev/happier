import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => {
  return { logger: { debug: vi.fn() } };
});

import { logger } from '@/ui/logger';
import { createGeminiBackendMessageHandler } from './createGeminiBackendMessageHandler';

describe('createGeminiBackendMessageHandler (logging)', () => {
  it('does not log tool call objectives verbatim', () => {
    const session = {
      sendAgentMessage: vi.fn(),
      keepAlive: vi.fn(),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const state = {
      thinking: false,
      accumulatedResponse: '',
      isResponseInProgress: false,
      hadToolCallInTurn: false,
      changeTitleCompleted: false,
      availableCommands: [],
    } as any;
    const diffProcessor = {
      processToolResult: vi.fn(),
      processFsEdit: vi.fn(),
    } as any;

    const handler = createGeminiBackendMessageHandler({
      session,
      messageBuffer,
      state,
      diffProcessor,
    });

    handler({
      type: 'tool-call',
      toolName: 'codebase_investigator',
      callId: 'c1',
      args: { objective: 'SUPER_SECRET_OBJECTIVE' },
    } as any);

    expect(JSON.stringify((logger as any).debug.mock.calls)).not.toContain('SUPER_SECRET_OBJECTIVE');
  });
});

