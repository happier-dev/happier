import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const boundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('axios', () => ({ default: { request: boundary.request } }));

import { createExternalMcpServer } from './createExternalMcpServer';

describe('createExternalMcpServer Session Follow dependencies', () => {
  it('composes the canonical Account Follow dependency for an external MCP Action', async () => {
    boundary.request.mockResolvedValueOnce({
      status: 200,
      data: {
        follow: null,
        isSessionOwner: false,
        capabilities: { manageFollow: true },
        voiceInitialSnapshotPending: false,
      },
    });
    const { mcp, toolNames } = createExternalMcpServer({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      defaultSessionId: 'session-1',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'follow-test', version: '1.0.0' }, { capabilities: {} });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(toolNames).toContain('action_execute');
      const result = await client.callTool({
        name: 'action_execute',
        arguments: { actionId: 'session.follow.get', input: { sessionId: 'session-1' } },
      });
      expect(result).toMatchObject({
        isError: false,
        structuredContent: {
          follow: null,
          isSessionOwner: false,
          capabilities: { manageFollow: true },
          voiceInitialSnapshotPending: false,
        },
      });
      expect(boundary.request).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        url: expect.stringContaining('/v2/sessions/session-1/follow'),
        headers: { Authorization: 'Bearer token' },
      }));
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
