import { describe, expect, it } from 'vitest';

import type { PermissionResponse } from '@/agent/permissions/BasePermissionHandler';
import { FakePermissionSession } from '@/testkit/backends/permissionHandler';
import { KiloPermissionHandler } from './permissionHandler';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

describe('KiloPermissionHandler', () => {
  it('prompts for external_directory in safe-yolo mode', async () => {
    const session = new FakePermissionSession();
    const handler = new KiloPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('safe-yolo');

    const promise = handler.handleToolCall('tool-1', 'external_directory', { path: '/outside' });
    expect(session.getAgentStateSnapshot().requests?.['tool-1']).toEqual(expect.objectContaining({ tool: 'external_directory' }));

    const response: PermissionResponse = { id: 'tool-1', approved: true, decision: 'approved' };
    await session.rpcHandlerManager.dispatchPermission(response);

    const result = await withTimeout(promise, 50);
    expect(result.decision).toBe('approved');
  });

  it('denies external_directory in read-only mode', async () => {
    const session = new FakePermissionSession();
    const handler = new KiloPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-1', 'external_directory', { path: '/outside' });
    expect(result.decision).toBe('denied');
    expect(session.getAgentStateSnapshot().requests?.['tool-1']).toBeUndefined();
    expect(session.getAgentStateSnapshot().completedRequests?.['tool-1']).toEqual(expect.objectContaining({ tool: 'external_directory', status: 'denied' }));
  });

  it('auto-approves external_directory in yolo mode', async () => {
    const session = new FakePermissionSession();
    const handler = new KiloPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('tool-1', 'external_directory', { path: '/outside' });
    expect(result.decision).toBe('approved_for_session');
    expect(session.getAgentStateSnapshot().requests?.['tool-1']).toBeUndefined();
    expect(session.getAgentStateSnapshot().completedRequests?.['tool-1']).toEqual(expect.objectContaining({ tool: 'external_directory', status: 'approved' }));
  });
});
