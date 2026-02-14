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

function bashToolUseMessage(): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm --version' } }],
    },
  };
}

const defaultMode = { permissionMode: 'default' } as EnhancedMode;

describe('permission RPC routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_DIR;
  });

  it('does not break remote approvals when the local permission bridge activates later', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    handler.onMessage(bashToolUseMessage());

    const permissionPromise = handler.handleToolCall('Bash', { command: 'npm --version' }, defaultMode, {
      signal: new AbortController().signal,
    });

    // This mirrors the production ordering risk: a later activation overwrites the `permission` handler.
    const { ClaudeLocalPermissionBridge } = await import('../localPermissions/localPermissionBridge');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();
    await permissionRpc?.({ id: 'toolu_1', approved: true });

    const result = await Promise.race([
      permissionPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('permission routing timed out')), 50)),
    ]);

    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'npm --version' } });
  });
});

