import { describe, expect, it } from 'vitest';

import { FakePermissionSession } from '@/testkit/backends/permissionHandler';

import { CodexPermissionHandler } from './permissionHandler';

describe('CodexPermissionHandler - title changes', () => {
  it('auto-approves change_title tool calls in read-only mode without creating a permission request', async () => {
    const session = new FakePermissionSession();
    const handler = new CodexPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-change-title-1', 'mcp__happier__change_title', { title: 'New Title' });

    expect(result.decision).toBe('approved');
    expect(session.snapshot().requests?.['tool-change-title-1']).toBeUndefined();
    expect(session.snapshot().completedRequests?.['tool-change-title-1']).toEqual(
      expect.objectContaining({
        tool: 'mcp__happier__change_title',
        status: 'approved',
        decision: 'approved',
      }),
    );
  });
});

