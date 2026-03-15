import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SDKAssistantMessage } from '../sdk';
import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

function exitPlanToolUseMessage(): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'ExitPlanMode', input: { plan: 'p1' } }],
    },
  };
}

const planMode = { permissionMode: 'plan' } as EnhancedMode;

describe('PermissionHandler (permission suggestions)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes suggestions to agentState requests when provided', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(exitPlanToolUseMessage());

    const controller = new AbortController();
    const suggestions = [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }];

    const resultPromise = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, planMode, {
      signal: controller.signal,
      suggestions,
    });

    expect((client.agentState as any).requests?.toolu_1?.permissionSuggestions).toEqual(suggestions);

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({ id: 'toolu_1', approved: true } as any);
    await expect(resultPromise).resolves.toEqual({ behavior: 'allow', updatedInput: { plan: 'p1' } });
  });
});
