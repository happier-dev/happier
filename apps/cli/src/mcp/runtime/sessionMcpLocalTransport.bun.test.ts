import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';
import { resolveProcessCustodyPeerIdentityExecutable } from '@/subprocess/supervision/processCustody';
import { supportsSessionMcpLocalTransport } from './sessionMcpLocalTransport';

function resolveBunExecutable(): string | null {
  const explicit = String(process.env.HAPPIER_TEST_BUN_EXECUTABLE ?? '').trim();
  if (explicit) return explicit;
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

const bunExecutable = resolveBunExecutable();
const runtimeIt = bunExecutable && supportsSessionMcpLocalTransport() && resolveProcessCustodyPeerIdentityExecutable() ? it : it.skip;

// Shipped hosts run on Bun. The Session MCP endpoint admits an Agent relay only by the kernel peer
// of its connection, so every connection its transport accepts must reach the peer-identity helper.
describe('Session MCP socket transport under Bun', () => {
  runtimeIt('accepts connections whose kernel peer can be proven', async () => {
    const tempDir = await createTempDir('happier-session-mcp-bun-');
    try {
      const fixturePath = join(tempDir, 'session-mcp-peer.ts');
      const transportUrl = pathToFileURL(join(process.cwd(), 'src/mcp/runtime/sessionMcpLocalTransport.ts')).href;
      const custodyUrl = pathToFileURL(join(process.cwd(), 'src/subprocess/supervision/processCustody.ts')).href;
      await writeFile(fixturePath, [
        `import { createServer, request } from 'node:http';`,
        `import { prepareSessionMcpLocalTransport } from ${JSON.stringify(transportUrl)};`,
        `import { observeLocalIpcPeerIdentity, resolveProcessCustodyPeerIdentityExecutable } from ${JSON.stringify(custodyUrl)};`,
        `const executablePath = resolveProcessCustodyPeerIdentityExecutable(process.platform);`,
        `const transport = await prepareSessionMcpLocalTransport({ agentUid: process.getuid() });`,
        `const peers = [];`,
        `const server = createServer(async (req, res) => {`,
        `  peers.push((await observeLocalIpcPeerIdentity({ socket: req.socket, executablePath }))?.pid ?? null);`,
        `  res.end();`,
        `});`,
        `server.on('upgrade', async (req, socket) => {`,
        `  peers.push((await observeLocalIpcPeerIdentity({ socket, executablePath }))?.pid ?? null);`,
        `  socket.end('HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n');`,
        `});`,
        `await transport.listen(server);`,
        `const send = (headers) => new Promise((resolve, reject) => {`,
        `  const r = request({ socketPath: transport.localContext.socketPath, path: '/mcp', headers }, res => { res.resume(); res.on('end', resolve); });`,
        `  r.once('upgrade', (_res, socket) => { socket.destroy(); resolve(); });`,
        `  r.once('error', reject); r.end();`,
        `});`,
        `await send({});`,
        `await send({ connection: 'Upgrade', upgrade: 'happier-mcp-relay' });`,
        `process.stdout.write(JSON.stringify({ selfPid: process.pid, peers }) + '\\n');`,
        `await new Promise(resolve => server.close(() => resolve()));`,
        `await transport.retire();`,
        `process.exit(0);`,
        '',
      ].join('\n'), 'utf8');

      const child = spawnTestProcess(bunExecutable!, [fixturePath], { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code));
      });
      expect(exit, Buffer.concat(stderr).toString('utf8')).toBe(0);
      const result = JSON.parse(Buffer.concat(stdout).toString('utf8')) as { selfPid: number; peers: Array<number | null> };
      // One plain request and one relay upgrade, both proven to come from this very process.
      expect(result.peers).toEqual([result.selfPid, result.selfPid]);
    } finally {
      await removeTempDir(tempDir);
    }
  }, 60_000);
});
