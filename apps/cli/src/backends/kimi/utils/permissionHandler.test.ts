import { describe, expect, it } from 'vitest';

import { FakePermissionSession } from '@/testkit/backends/permissionHandler';
import { KimiPermissionHandler } from './permissionHandler';

describe('KimiPermissionHandler', () => {
  it('denies write-like tools in read-only mode', async () => {
    const session = new FakePermissionSession();
    const handler = new KimiPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('denied');
    expect(session.getAgentStateSnapshot().requests?.['tool-1']).toBeUndefined();
    expect(session.getAgentStateSnapshot().completedRequests?.['tool-1']).toEqual(expect.objectContaining({ tool: 'Write', status: 'denied' }));
  });

  it('auto-approves in yolo mode', async () => {
    const session = new FakePermissionSession();
    const handler = new KimiPermissionHandler(session.asApiSessionClient());
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('approved_for_session');
    expect(session.getAgentStateSnapshot().requests?.['tool-1']).toBeUndefined();
    expect(session.getAgentStateSnapshot().completedRequests?.['tool-1']).toEqual(expect.objectContaining({ tool: 'Write', status: 'approved' }));
  });
});
