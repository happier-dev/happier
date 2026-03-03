import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnhancedMode } from '../loop';
import type { SDKAssistantMessage } from '../sdk';
import { createPermissionHandlerSessionStubWithMetadata } from './permissionHandler.testkit';

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
      content: [{ type: 'tool_use', id: 'toolu_exit_1', name: 'ExitPlanMode', input: { plan: 'p1' } }],
    },
  };
}

describe('PermissionHandler (ExitPlanMode transition)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_DIR;
  });

  it('allows non-interactive tools after ExitPlanMode approval for the same user-message localId', async () => {
    const { session, client } = createPermissionHandlerSessionStubWithMetadata({
      sessionId: 's1',
      metadata: { acpSessionModeOverrideV1: { v: 1, updatedAt: 1, modeId: 'plan' } },
    });

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const controller = new AbortController();
    const mode = { permissionMode: 'yolo', agentModeId: 'plan', localId: 'm1' } as EnhancedMode;

    await expect(handler.handleToolCall('Bash', { command: 'pwd' }, mode, { signal: controller.signal })).resolves.toMatchObject({
      behavior: 'deny',
    });

    handler.onMessage(exitPlanToolUseMessage());

    const exitPromise = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, mode, { signal: controller.signal });
    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({ id: 'toolu_exit_1', approved: true } as any);
    await expect(exitPromise).resolves.toEqual({ behavior: 'allow', updatedInput: { plan: 'p1' } });

    await expect(handler.handleToolCall('Bash', { command: 'pwd' }, mode, { signal: controller.signal })).resolves.toMatchObject({
      behavior: 'allow',
    });

    expect((client.metadata as any).acpSessionModeOverrideV1?.modeId).toBeNull();
  });

  it('does not keep ExitPlanMode latch state across reset (prevents plan-mode bypass leakage)', async () => {
    const { session, client } = createPermissionHandlerSessionStubWithMetadata({
      sessionId: 's1',
      metadata: { acpSessionModeOverrideV1: { v: 1, updatedAt: 1, modeId: 'plan' } },
    });

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const controller = new AbortController();
    const mode = { permissionMode: 'yolo', agentModeId: 'plan', localId: 'm1' } as EnhancedMode;

    handler.onMessage(exitPlanToolUseMessage());
    const exitPromise = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, mode, { signal: controller.signal });
    await client.rpcHandlerManager.getHandler('permission')?.({ id: 'toolu_exit_1', approved: true } as any);
    await expect(exitPromise).resolves.toEqual({ behavior: 'allow', updatedInput: { plan: 'p1' } });

    await expect(handler.handleToolCall('Bash', { command: 'pwd' }, mode, { signal: controller.signal })).resolves.toMatchObject({
      behavior: 'allow',
    });

    handler.reset();

    await expect(handler.handleToolCall('Bash', { command: 'pwd' }, mode, { signal: controller.signal })).resolves.toMatchObject({
      behavior: 'deny',
    });
  });
});
