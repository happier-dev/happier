import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getBuiltInBackendProfile } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { buildProfileEnvOverlay } from '@/settings/profiles/buildProfileEnvOverlay';
import { buildClaudeSubprocessEnv } from '@/backends/claude/spawn/buildClaudeSubprocessEnv';

// Exercise the installed Agent SDK and its real provider process, intercepting only HTTP.
// No production API key or remote inference is involved.
describe('MiniMax profile Agent SDK HTTP transport', () => {
  it.each([
    ['minimax', 'MINIMAX', undefined, 'MiniMax-M3.1-Flash'],
    ['minimax-cn', 'MINIMAX_CN', undefined, 'MiniMax-M3.1-Flash'],
    ['minimax', 'MINIMAX', 'MiniMax-M3', 'MiniMax-M3'],
    ['minimax-cn', 'MINIMAX_CN', 'MiniMax-M3', 'MiniMax-M3'],
    ['minimax', 'MINIMAX', 'MiniMax-M2.7', 'MiniMax-M2.7'],
    ['minimax-cn', 'MINIMAX_CN', 'custom-model-exact', 'custom-model-exact'],
  ])('serializes %s override %s / %s as %s', async (profileId, prefix, selectedModel, expectedModel) => {
    const requests: { path: string; authorization?: string; body: Record<string, unknown> }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
      if (!req.url?.startsWith('/anthropic/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'fixture route' } }));
        return;
      }
      if (req.url.startsWith('/anthropic/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 12 }));
        return;
      }
      requests.push({ path: req.url, authorization: req.headers.authorization, body });
      const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'fixture-ok' }], stop_reason: 'end_turn' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture-ok' } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      event('message_stop', {});
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    let session: ReturnType<typeof query> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      const artifacts = join(process.cwd(), '.project', 'minimax-sdk-tests');
      await mkdir(artifacts, { recursive: true });
      const home = await mkdtemp(join(artifacts, 'run-'));
      const baseEnv = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        [`${prefix}_AUTH_TOKEN`]: 'fixture-key', [`${prefix}_BASE_URL`]: `http://127.0.0.1:${address.port}/anthropic`,
        ...(selectedModel ? { [`${prefix}_MODEL`]: selectedModel } : {}) };
      const profile = getBuiltInBackendProfile(profileId);
      if (!profile) throw new Error(`Missing built-in profile ${profileId}`);
      const overlay = await buildProfileEnvOverlay({ profile, agentId: 'claude', processEnv: baseEnv,
        accountSettings: {}, credentials: { token: 'fixture-account', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } },
        promptSecretFn: null, startedBy: 'terminal' });
      const env = buildClaudeSubprocessEnv({ baseEnv, envOverlay: overlay.envOverlayExpanded });
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 45_000);
      const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
      async function* imagePrompt(): AsyncGenerator<SDKUserMessage> {
        yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [
          { type: 'text', text: 'Reply fixture-ok.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        ] } };
      }
      // Select the matching installed Linux package explicitly when both optional binaries exist.
      const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
      const glibc = process.platform === 'linux' && Boolean(report.header.glibcVersionRuntime);
      const pathToClaudeCodeExecutable = glibc
        ? createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`)
        : undefined;
      session = query({ prompt: selectedModel ? 'Reply fixture-ok.' : imagePrompt(), options: {
        pathToClaudeCodeExecutable,
        cwd: home, env, abortController: controller, settingSources: [], tools: [], mcpServers: {},
        persistSession: false, maxTurns: 1, systemPrompt: 'Reply briefly.', model: selectedModel,
      } });
      let succeeded = false;
      for await (const message of session) {
        if (message.type === 'result') {
          expect(message.is_error).toBe(false);
          succeeded = true;
        }
      }
      expect(succeeded).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      const request = requests.find(row => JSON.stringify(row.body.messages).includes('Reply fixture-ok.'));
      expect(request).toBeDefined();
      expect(request?.path).toMatch(/^\/anthropic\/v1\/messages(?:\?|$)/u);
      expect(request?.authorization).toBe('Bearer fixture-key');
      expect(request?.body.model).toBe(expectedModel);
      expect(request?.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user' })]));
      expect(JSON.stringify(request?.body)).not.toContain('image_url');
      if (!selectedModel) {
        expect(request?.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({
          role: 'user', content: expect.arrayContaining([expect.objectContaining({
            type: 'image', source: expect.objectContaining({ type: 'base64', media_type: 'image/png' }),
          })]),
        })]));
      }
    } finally {
      clearTimeout(timeout);
      session?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 60_000);
});
