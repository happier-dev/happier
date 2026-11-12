import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const forwarder = fileURLToPath(new URL('../../../../../../apps/cli/scripts/permission_hook_forwarder.cjs', import.meta.url));

function startPromptForwarder(port: number) {
  const child = spawn(process.execPath, [forwarder, String(port), 'UserPromptSubmit', '--deny-on-unavailable'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const result = new Promise<unknown>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => { if (code !== 0) reject(new Error('Forwarder failed')); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
  });
  child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'native-session', prompt: 'hello' }));
  return { child, result };
}

describe('Claude brokered prompt publication forwarder', () => {
  it('stops generation when its admitted host publication endpoint is unavailable', async () => {
    const { result } = startPromptForwarder(0);
    await expect(result).resolves.toMatchObject({ continue: false });
  });

  it('withholds the native response until the host publishes the accepted Turn', async () => {
    let entered!: () => void;
    const request = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const acknowledgement = new Promise<void>(resolve => { release = resolve; });
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* Drain the genuine hook transport request. */ }
      entered(); await acknowledgement;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ continue: true }));
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address');
    const { child, result } = startPromptForwarder(address.port);
    let completed = false;
    void result.then(() => { completed = true; });
    try {
      await request;
      await new Promise<void>(resolve => { setImmediate(resolve); });
      expect(completed).toBe(false);
      release();
      await expect(result).resolves.toEqual({ continue: true });
    } finally {
      release();
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
  });
});
