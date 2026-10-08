import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FeaturesResponseSchema, getActionSpec } from '@happier-dev/protocol';
import { SessionFollowActionOutputSchemasV1 } from '@happier-dev/protocol/sessions/follow/actions';

const boundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('axios', () => ({ default: { request: boundary.request } }));

import { createExternalMcpServer } from './createExternalMcpServer';

describe('createExternalMcpServer Session Follow dependencies', () => {
  beforeEach(() => {
    boundary.request.mockReset();
  });

  it('refuses a client-placed request without falling back when its exact Home has no daemon', async () => {
    const { mcp, toolNames } = createExternalMcpServer({
      credentials: { token: 'token', encryption: null },
      defaultSessionId: 'session-1',
      // A known absent daemon must not fall back to an ambient Home or execute
      // the client Action locally. The MCP, Action and approval owners stay real.
      daemonControlTarget: null,
      serverFeaturesSnapshot: {
        status: 'ready',
        provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }),
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'requestable-action-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      expect(toolNames).toContain('action_execute');
      const textResult = z.object({
        isError: z.boolean(),
        content: z.array(z.object({ type: z.literal('text'), text: z.string() })).nonempty(),
      });
      const result = await client.callTool({
        name: 'action_execute',
        arguments: { actionId: 'session.target.primary.set',
          input: getActionSpec('session.target.primary.set').inputSchema.parse({ sessionId: null }) },
      });
      const refused = textResult.parse(result);
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.content[0]!.text)).toMatchObject({
        errorCode: 'unavailable', error: 'noClient',
      });
      expect(boundary.request).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it('composes the canonical Account Follow dependency for an external MCP Action', async () => {
    const follow = SessionFollowActionOutputSchemasV1['session.follow.get'].parse({
      follow: null,
      isSessionOwner: false,
      capabilities: { manageFollow: true },
      voiceInitialSnapshotPending: false,
    });
    boundary.request.mockResolvedValueOnce({
      status: 200,
      data: follow,
    });
    const { mcp, toolNames } = createExternalMcpServer({
      credentials: {
        token: 'token',
        encryption: null,
      },
      defaultSessionId: 'session-1',
      serverFeaturesSnapshot: {
        status: 'ready',
        provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({
          features: { sessions: { enabled: true, following: { enabled: true } } },
          capabilities: {},
        }),
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'follow-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      expect(toolNames).toContain('action_execute');
      const result = await client.callTool({
        name: 'action_execute',
        arguments: { actionId: 'session.follow.get', input: { sessionId: 'session-1' } },
      });
      const response = CallToolResultSchema.parse(result);
      expect(response.isError).toBe(false);
      const text = response.content.find((entry) => entry.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Missing Follow text result');
      const followResult = SessionFollowActionOutputSchemasV1['session.follow.get'].parse(JSON.parse(text.text));
      expect(followResult).toMatchObject({
        follow: null,
        isSessionOwner: false,
        capabilities: { manageFollow: true },
        voiceInitialSnapshotPending: false,
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
