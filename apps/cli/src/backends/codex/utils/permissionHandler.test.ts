import { describe, expect, it } from 'vitest';

import { FakePermissionSession } from '@/testkit/backends/permissionHandler';
import { CodexPermissionHandler } from './permissionHandler';

describe('CodexPermissionHandler', () => {
  it('denies write-like tools in read-only mode', async () => {
    const session = new FakePermissionSession();
    const handler = new CodexPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-1', 'CodexPatch', { message: 'diff' });
    expect(result.decision).toBe('denied');
    expect(session.snapshot().requests?.['tool-1']).toBeUndefined();
    expect(session.snapshot().completedRequests?.['tool-1']).toEqual(
      expect.objectContaining({ tool: 'CodexPatch', status: 'denied', decision: 'denied' }),
    );
  });

  it('prompts for write-like tools in safe-yolo mode', async () => {
    const session = new FakePermissionSession();
    const handler = new CodexPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('safe-yolo');

    const permissionResultPromise = handler.handleToolCall('tool-1', 'CodexPatch', { message: 'diff' });
    expect(session.snapshot().requests?.['tool-1']).toEqual(
      expect.objectContaining({ tool: 'CodexPatch' }),
    );

    await session.rpcHandlerManager.dispatchPermission({
      id: 'tool-1',
      approved: true,
      decision: 'approved',
    });

    const result = await permissionResultPromise;
    expect(result.decision).toBe('approved');
    expect(session.snapshot().requests?.['tool-1']).toBeUndefined();
    expect(session.snapshot().completedRequests?.['tool-1']).toEqual(
      expect.objectContaining({ tool: 'CodexPatch', status: 'approved', decision: 'approved' }),
    );
  });

  it('auto-approves in yolo mode', async () => {
    const session = new FakePermissionSession();
    const handler = new CodexPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('tool-1', 'CodexPatch', { message: 'diff' });
    expect(result.decision).toBe('approved_for_session');
    expect(session.snapshot().requests?.['tool-1']).toBeUndefined();
    expect(session.snapshot().completedRequests?.['tool-1']).toEqual(
      expect.objectContaining({ tool: 'CodexPatch', status: 'approved', decision: 'approved_for_session' }),
    );
  });
});
