import http from 'node:http';
import { reloadConfiguration } from '@/configuration';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { Readable, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { SSH_TUNNEL_SYSTEM_TASK_KINDS } from '@happier-dev/protocol/ssh/tunnels';
import { handleDaemonCliCommand } from './daemon';
// Load the real command graph before replacing process streams; Vite transforms are setup work.
import './daemonSystemTask';

async function runDesktopTask(kind: string, params: Record<string, unknown>) {
  // stdin/stdout are the process boundary. Keep the command and live task registry real.
  const input = Readable.from([JSON.stringify({ protocolVersion: 1, kind, params })]);
  const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as NodeJS.ReadStream);
  let output = '';
  const outputStream = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
  const stdout = vi.spyOn(process, 'stdout', 'get').mockReturnValue(outputStream as NodeJS.WriteStream);
  try {
    await handleDaemonCliCommand({ args: ['daemon', 'system-task', '--json'], rawArgv: [], terminalRuntime: null });
    return JSON.parse(output) as unknown;
  } finally { stdin.mockRestore(); stdout.mockRestore(); }
}

it('runs a desktop SSH task through the live registry and reports parameter failures', async () => {
  expect(await runDesktopTask(SSH_TUNNEL_SYSTEM_TASK_KINDS.ensure, {})).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
});

it('lists tunnels through the command, real registry and authenticated loopback transport', async () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  const home = await createTempDir('desktop-ssh-task-');
  const server = http.createServer((req, res) => {
    expect(req.url).toBe('/ssh-tunnels/list');
    expect(req.headers['x-happier-daemon-token']).toBe('test-token');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, tunnels: [] }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
    env.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'test-token' });
    expect(await runDesktopTask(SSH_TUNNEL_SYSTEM_TASK_KINDS.list, {})).toMatchObject({ ok: true, data: { ok: true, tunnels: [] } });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await clearDaemonStateForTestTeardown();
    env.restore();
    reloadConfiguration();
    await removeTempDir(home);
  }
});
