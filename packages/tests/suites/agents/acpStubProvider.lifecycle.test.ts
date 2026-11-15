import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd(), '..', '..');
const stubPath = resolve(repoRoot, 'packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs');

async function loadAcpSdk() {
  const entry = createRequire(import.meta.url).resolve('@agentclientprotocol/sdk', { paths: [resolve(repoRoot, 'apps', 'cli')] });
  return await import(pathToFileURL(entry).href) as typeof import('@agentclientprotocol/sdk');
}

const children: Array<ReturnType<typeof spawn>> = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
});

async function connectToStub() {
  const acp = await loadAcpSdk();
  const child = spawn(process.execPath, [stubPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  const chunks: string[] = [];
  const connection = new acp.ClientSideConnection(() => ({
    async sessionUpdate(params) {
      const update = params.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') chunks.push(update.content.text ?? '');
    },
    async requestPermission() {
      return { outcome: { outcome: 'cancelled' } };
    },
  }), acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
  await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  return { connection, chunks };
}

describe('ACP stub provider as a healthy custom ACP agent', () => {
  it('answers session/cancel by settling the running prompt with stopReason cancelled', async () => {
    const { connection, chunks } = await connectToStub();
    const { sessionId } = await connection.newSession({ cwd: repoRoot, mcpServers: [] });

    const running = connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'ACP_STUB_PRIMARY=stop-cell' }] });
    while (!chunks.some((text) => text.startsWith('ACP_STUB_RUNNING'))) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    await connection.cancel({ sessionId });

    await expect(running).resolves.toEqual(expect.objectContaining({ stopReason: 'cancelled' }));
    // The Session stays usable after the stop.
    await expect(connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'ACP_STUB_USAGE_UPDATE=after-stop' }] }))
      .resolves.toEqual(expect.objectContaining({ stopReason: 'end_turn' }));
  });

  it('reloads a Session id in a new process and replies there', async () => {
    const first = await connectToStub();
    const { sessionId } = await first.connection.newSession({ cwd: repoRoot, mcpServers: [] });
    for (const child of children.splice(0)) child.kill();

    const second = await connectToStub();
    await second.connection.loadSession({ sessionId, cwd: repoRoot, mcpServers: [] });
    await expect(second.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'ACP_STUB_USAGE_UPDATE=resumed' }] }))
      .resolves.toEqual(expect.objectContaining({ stopReason: 'end_turn' }));
    expect(second.chunks).toContain('ACP_STUB_USAGE_UPDATE_DONE resumed');
  });
});
