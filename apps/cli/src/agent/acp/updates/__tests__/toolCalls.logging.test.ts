import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => {
  return { logger: { debug: vi.fn() } };
});

import { logger } from '@/ui/logger';
import type { TransportHandler } from '@/agent/transport';

import { handleToolCall } from '../../toolCalls/legacy/handlers';
import type { SessionUpdate } from '../types';
import { createLegacyHandlerContextFixture } from '../../__tests__/legacyToolRuntimeFixture';

function createHandlerContext() {
  const transport: TransportHandler = {
    agentName: 'test',
    getInitTimeout: () => 1_000,
    getToolPatterns: () => [],
    isInvestigationTool: () => true,
  };

  return createLegacyHandlerContextFixture({ transport });
}

describe('ACP tool call logging', () => {
  it('does not log investigation objectives verbatim', () => {
    const ctx = createHandlerContext();
    const update: SessionUpdate = {
      toolCallId: 't1',
      status: 'in_progress',
      kind: 'investigator',
      rawInput: { objective: 'SUPER_SECRET_OBJECTIVE' },
    } as any as SessionUpdate;

    handleToolCall({ ...update, sessionUpdate: 'tool_call', title: 'Investigation' }, ctx);

    expect(JSON.stringify((logger as any).debug.mock.calls)).not.toContain('SUPER_SECRET_OBJECTIVE');
  });
});
