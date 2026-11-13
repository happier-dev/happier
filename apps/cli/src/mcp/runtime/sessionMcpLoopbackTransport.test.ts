import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';

import { buildOutboundSessionMessagePayload } from '@/api/session/client/transport/outboundSessionMessagePayload';
import { prepareSessionMcpLoopbackTransport } from './sessionMcpLocalTransport';

// The Windows (127.0.0.1) Session MCP transport, exercised on any host: the context file the
// Agent's shell can read carries no bearer, and a transcript echoing the live bearer is redacted
// at the Session message writer.
describe('Session MCP loopback transport (Windows)', () => {
  it('keeps its bearer out of the Agent context and out of transcripts', async () => {
    const transport = await prepareSessionMcpLoopbackTransport();
    const server = createServer((_request, response) => {
      response.end();
    });
    await transport.listen(server);
    const context = transport.localContext;
    if (!context || !('url' in context) || !transport.contextFilePath)
      throw new Error('missing loopback context');
    try {
      const visible = await readFile(transport.contextFilePath, 'utf8');
      expect(JSON.parse(visible)).toEqual({ v: 1, url: context.url });
      expect(visible.includes(context.bearerToken)).toBe(false);

      const payload = buildOutboundSessionMessagePayload(
        { mode: 'plain', ctx: null },
        {
          role: 'agent',
          content: {
            type: 'tool-call',
            input: {
              command: `curl -H "Authorization: Bearer ${context.bearerToken}"`,
            },
          },
        },
      );
      expect(JSON.stringify(payload).includes(context.bearerToken)).toBe(false);
      expect(payload).toMatchObject({
        t: 'plain',
        v: { role: 'agent', content: { type: 'tool-call' } },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await transport.retire();
    }
  });
});
