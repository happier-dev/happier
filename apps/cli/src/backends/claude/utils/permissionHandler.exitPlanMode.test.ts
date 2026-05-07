import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SDKAssistantMessage } from '../sdk';
import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';
import type { PermissionRpcPayload } from './permissionRpc';

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

async function expectResolvesWithin<T>(promise: Promise<T>, ms = 250): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

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

  it('resolves duplicate ExitPlanMode waiters for the same toolUseId from one approval', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const firstController = new AbortController();
    const secondController = new AbortController();
    const sharedToolUseId = 'toolu_exit_duplicate_1';

    const first = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, planMode, {
      signal: firstController.signal,
      toolUseId: sharedToolUseId,
    });
    const second = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, planMode, {
      signal: secondController.signal,
      toolUseId: sharedToolUseId,
    });

    expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual([sharedToolUseId]);

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: sharedToolUseId,
      approved: true,
    } satisfies PermissionRpcPayload);

    await expect(expectResolvesWithin(Promise.all([first, second]))).resolves.toEqual([
      { behavior: 'allow', updatedInput: { plan: 'p1' } },
      { behavior: 'allow', updatedInput: { plan: 'p1' } },
    ]);
    expect(client.getAgentStateSnapshot().requests[sharedToolUseId]).toBeUndefined();
    expect(client.getAgentStateSnapshot().completedRequests[sharedToolUseId]).toMatchObject({ status: 'approved' });
  });

  it('keeps a duplicate ExitPlanMode waiter live when another waiter for the same toolUseId aborts', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const firstController = new AbortController();
    const secondController = new AbortController();
    const sharedToolUseId = 'toolu_exit_duplicate_abort_1';

    const first = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, planMode, {
      signal: firstController.signal,
      toolUseId: sharedToolUseId,
    });
    const second = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, planMode, {
      signal: secondController.signal,
      toolUseId: sharedToolUseId,
    });

    firstController.abort();
    await expect(first).rejects.toThrow('Permission request aborted');

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: sharedToolUseId,
      approved: true,
    } satisfies PermissionRpcPayload);

    await expect(expectResolvesWithin(second)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { plan: 'p1' },
    });
    expect(client.getAgentStateSnapshot().requests[sharedToolUseId]).toBeUndefined();
    expect(client.getAgentStateSnapshot().completedRequests[sharedToolUseId]).toMatchObject({ status: 'approved' });
  });

  it('applies duplicate ExitPlanMode approval side effects once while resolving every live waiter', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const sharedToolUseId = 'toolu_exit_duplicate_side_effects_1';
    const first = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, planMode, {
      signal: new AbortController().signal,
      toolUseId: sharedToolUseId,
    });
    const second = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, planMode, {
      signal: new AbortController().signal,
      toolUseId: sharedToolUseId,
    });

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: sharedToolUseId,
      approved: true,
      mode: 'yolo',
    } satisfies PermissionRpcPayload);

    await expect(expectResolvesWithin(Promise.all([first, second]))).resolves.toHaveLength(2);
    expect(session.setLastPermissionMode).toHaveBeenCalledTimes(1);
    expect(session.setLastPermissionMode).toHaveBeenCalledWith('yolo');
  });
});
