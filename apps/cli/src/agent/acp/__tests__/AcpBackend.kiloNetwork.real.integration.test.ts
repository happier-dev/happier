import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { withTempDir } from '@/testkit/fs/tempDir';
import { buildKiloAcpEnv } from '../../../../../../packages/plugins/kilo/src/agent/acp/callbacks';
import { buildKiloNativeUpstreamConfig } from '../../../../../../packages/plugins/kilo/src/agent/providerBinding/adapter';

// Official Kilo v7.8.27: only its HTTP Provider boundary is replaced.
const executable = process.env.HAPPIER_TEST_KILO_EXECUTABLE?.trim();

describe.skipIf(!executable)('official Kilo ACP network failure', () => {
  it('fails a refused Provider connection and permits a later successful turn', async () => {
    await withTempDir('kilo-network-', async cwd => {
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) { /* drain the model request */ }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'RECOVERED' }, finish_reason: null }] })}\n\n`
          + `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const backend = new AcpBackend({ agentName: 'kilo', cwd, command: executable!, args: ['acp'], env: {
        HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'config'), XDG_DATA_HOME: join(cwd, 'data'),
        XDG_CACHE_HOME: join(cwd, 'cache'), XDG_STATE_HOME: join(cwd, 'state'),
        KILO_CONFIG_CONTENT: buildKiloNativeUpstreamConfig({ key: 'fixture', npm: '@ai-sdk/openai-compatible',
          model: { id: 'gpt-6-luna', name: 'Fixture' }, baseURL: `http://127.0.0.1:${address.port}/v1`, hasCredential: false }),
        ...buildKiloAcpEnv({ permissionIntent: 'default' }),
      } });
      const messages: AgentMessage[] = [];
      backend.onMessage(message => messages.push(message));
      try {
        const { sessionId } = await backend.startSession();
        let terminal: { success: boolean; error?: unknown } | undefined;
        const pending = backend.sendPrompt(sessionId, 'No tools. Reply OK.')
          .then(() => backend.waitForResponseComplete())
          .then(() => { terminal = { success: true }; }, error => { terminal = { success: false, error }; });
        await expect.poll(() => terminal, { timeout: 45_000 }).toMatchObject({ success: false });
        await pending;
        expect(terminal?.error).toMatchObject({ code: -32603, message: expect.stringMatching(/connection refused/i) });
        await new Promise<void>(resolve => server.listen(address.port, '127.0.0.1', resolve));
        await backend.sendPrompt(sessionId, 'No tools. Reply RECOVERED.');
        await backend.waitForResponseComplete();
        expect(messages.filter(message => message.type === 'model-output')
          .map(message => message.textDelta).join('')).toContain('RECOVERED');
      } finally {
        await backend.dispose();
        server.closeAllConnections();
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }, 60_000);
});
