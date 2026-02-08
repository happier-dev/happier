import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SDKAssistantMessage } from '../sdk';
import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testHelpers';

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

describe('PermissionHandler (ExitPlanMode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_DIR;
  });

  it('allows ExitPlanMode when approved', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(exitPlanToolUseMessage());

    const resultPromise = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, planMode, {
      signal: new AbortController().signal,
    });

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({ id: 'toolu_1', approved: true });
    await expect(resultPromise).resolves.toEqual({ behavior: 'allow', updatedInput: { plan: 'p1' } });
  });

  it('denies ExitPlanMode with the provided reason, and does not abort the remote loop', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(exitPlanToolUseMessage());

    const resultPromise = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, planMode, {
      signal: new AbortController().signal,
    });

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({ id: 'toolu_1', approved: false, reason: 'Please change step 2' });
    await expect(resultPromise).resolves.toMatchObject({ behavior: 'deny', message: 'Please change step 2' });

    expect(handler.isAborted('toolu_1')).toBe(false);
  });
});
