import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveVerifiedStackServerEndpoint,
  resolveVerifiedStackUiEndpoint,
} from './verified_endpoints.mjs';

async function spawnMetroLikeServer({ projectDir }) {
  const script = `
    const http = require('http');
    const projectDir = process.argv[2] || '';
    const srv = http.createServer((req, res) => {
      if (req.url === '/status') {
        res.statusCode = 200;
        res.setHeader('x-react-native-project-root', projectDir);
        res.end('packager-status:running');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><body><div id="root"></div></body></html>');
    });
    srv.listen(0, '127.0.0.1', () => {
      console.log(JSON.stringify({ port: srv.address().port, pid: process.pid }));
    });
    setInterval(() => {}, 1000);
  `.trim();
  const child = spawn(process.execPath, ['-e', script, projectDir], { stdio: ['ignore', 'pipe', 'ignore'] });
  const line = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline >= 0) resolve(buffer.slice(0, newline));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`metro-like test server exited before ready (code=${code ?? 'unknown'})`)));
  });
  const meta = JSON.parse(String(line ?? '').trim());
  return {
    pid: Number(meta.pid),
    port: Number(meta.port),
    async close() {
      try {
        child.kill('SIGKILL');
      } catch {
        // best effort
      }
    },
  };
}

test('resolveVerifiedStackServerEndpoint does not verify an arbitrary listener as a Happier server', async () => {
  const endpoint = await resolveVerifiedStackServerEndpoint(
    { port: 53288, host: '127.0.0.1' },
    {
      isTcpPortListeningImpl: async () => true,
      fetchHappierHealthImpl: async () => null,
    },
  );

  assert.equal(endpoint.running, false);
  assert.equal(endpoint.port, 53288);
  assert.equal(endpoint.url, 'http://127.0.0.1:53288');
  assert.equal(endpoint.health, null);
  assert.equal(endpoint.portListening, true);
});

test('resolveVerifiedStackUiEndpoint does not surface a web UI when UI serving is disabled', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'hstack-verified-ui-disabled-'));
  const baseDir = join(temp, 'stack');
  const projectDir = join(temp, 'ui-project');
  const metro = await spawnMetroLikeServer({ projectDir });

  try {
    await mkdir(join(baseDir, 'expo-dev', 'abc123'), { recursive: true });
    await writeFile(
      join(baseDir, 'expo-dev', 'abc123', 'expo.state.json'),
      JSON.stringify({
        pid: metro.pid,
        port: metro.port,
        projectDir,
        webEnabled: true,
      }) + '\n',
      'utf8',
    );

    const endpoint = await resolveVerifiedStackUiEndpoint({
      stackName: 'test-stack',
      baseDir,
      runtimeState: { expo: { webPort: metro.port, webEnabled: true } },
      expectedProjectDir: projectDir,
      serveUiWanted: false,
    });

    assert.equal(endpoint.expected, false);
    assert.equal(endpoint.running, false);
    assert.equal(endpoint.port, null);
    assert.equal(endpoint.url, null);
    assert.equal(endpoint.source, 'disabled');
  } finally {
    await metro.close();
    await rm(temp, { recursive: true, force: true });
  }
});
