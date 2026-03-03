import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

describe('PermissionHandler (plan mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_DIR;
  });

  it('does not auto-deny read-only tools in plan mode (it requests permission instead)', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const controller = new AbortController();
    const mode = { permissionMode: 'yolo', agentModeId: 'plan', localId: 'm1' } as EnhancedMode;

    const promise = handler.handleToolCall(
      'Read',
      { file_path: 'README.md' },
      mode,
      { signal: controller.signal, toolUseId: 'toolu_read_1' },
    );

    // Ensure we published a permission request (vs immediate deny).
    expect(client.getAgentStateSnapshot().requests).toHaveProperty('toolu_read_1');

    await client.rpcHandlerManager.getHandler('permission')?.({ id: 'toolu_read_1', approved: true } as any);
    await expect(promise).resolves.toEqual({ behavior: 'allow', updatedInput: { file_path: 'README.md' } });
  });
});

