import { describe, expect, it } from 'vitest';

import type { AgentState } from '@/api/types';
import { FakePermissionSession } from '@/testkit/backends/permissionHandler';
import { GeminiPermissionHandler } from './permissionHandler';

describe('GeminiPermissionHandler', () => {
  it('denies write-like tools in read-only mode', async () => {
    const session = new FakePermissionSession();
    const handler = new GeminiPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('denied');
    expect(session.snapshot().requests?.['tool-1']).toBeUndefined();
    expect(session.snapshot().completedRequests?.['tool-1']).toEqual(
      expect.objectContaining({ tool: 'Write', status: 'denied', decision: 'denied' }),
    );
  });

  it('prompts for write-like tools in safe-yolo mode', async () => {
    const session = new FakePermissionSession();
    const handler = new GeminiPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('safe-yolo');

    const permissionResultPromise = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    expect(session.snapshot().requests?.['tool-1']).toEqual(
      expect.objectContaining({ tool: 'Write' }),
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
      expect.objectContaining({ tool: 'Write', status: 'approved', decision: 'approved' }),
    );
  });

  it('surfaces denied decisions from permission response in safe-yolo mode', async () => {
    const session = new FakePermissionSession();
    const handler = new GeminiPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('safe-yolo');

    const permissionResultPromise = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    await session.rpcHandlerManager.dispatchPermission({
      id: 'tool-1',
      approved: false,
      decision: 'denied',
    });

    const result = await permissionResultPromise;
    expect(result.decision).toBe('denied');
    expect(session.snapshot().completedRequests?.['tool-1']).toEqual(
      expect.objectContaining({ tool: 'Write', status: 'denied', decision: 'denied' }),
    );
  });

  it('auto-approves in yolo mode', async () => {
    const session = new FakePermissionSession();
    const handler = new GeminiPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('approved_for_session');
    expect(session.snapshot().requests?.['tool-1']).toBeUndefined();
    expect(session.snapshot().completedRequests?.['tool-1']).toEqual(
      expect.objectContaining({ tool: 'Write', status: 'approved', decision: 'approved_for_session' }),
    );
  });

  it('always auto-approves internal change-title tools regardless of mode', async () => {
    const session = new FakePermissionSession();
    const handler = new GeminiPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-change_title-1', 'mcp__happier__change_title', { title: 'new title' });
    expect(result.decision).toBe('approved');
    expect(session.snapshot().requests?.['tool-change_title-1']).toBeUndefined();
    expect(session.snapshot().completedRequests?.['tool-change_title-1']).toEqual(
      expect.objectContaining({ tool: 'mcp__happier__change_title', status: 'approved', decision: 'approved' }),
    );
  });

  it('refuses claimed IDs before Gemini-specific always-auto approval', async () => {
    const session = new FakePermissionSession();
    const opaqueClaim = { malformed: { future: true } };
    const claimedRequest: NonNullable<AgentState['requests']>[string] & Record<'permissionResponseClaimV1', unknown> = {
      tool: 'change_title',
      arguments: { title: 'reserved' },
      createdAt: 1,
      permissionResponseClaimV1: opaqueClaim,
    };
    session.updateAgentState((current) => ({
      ...current,
      requests: {
        ...current.requests,
        claimed: claimedRequest,
      },
    }));
    const handler = new GeminiPermissionHandler(session.asApiSessionClient());

    await expect(handler.handleToolCall('claimed', 'change_title', { title: 'reserved' })).rejects.toThrow(/reserved/i);

    const retained = session.snapshot().requests?.claimed as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(retained, 'permissionResponseClaimV1')).toBe(true);
    expect(retained.permissionResponseClaimV1).toBe(opaqueClaim);
    expect(session.snapshot().completedRequests?.claimed).toBeUndefined();
  });

  it('auto-approves canonical change_title even when toolCallId is generic', async () => {
    const session = new FakePermissionSession();
    const handler = new GeminiPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-1', 'change_title', { title: 'new title' });
    expect(result.decision).toBe('approved');
    expect(session.snapshot().requests?.['tool-1']).toBeUndefined();
    expect(session.snapshot().completedRequests?.['tool-1']).toEqual(
      expect.objectContaining({ tool: 'change_title', status: 'approved', decision: 'approved' }),
    );
  });
});
