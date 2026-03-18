import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isStateProcessRunning } from './expo.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('isStateProcessRunning does not treat occupied port as running when /status is not Metro', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-state-running-'));
  const srv = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not-metro');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  try {
    await listen(srv);
    const addr = srv.address();
    assert.ok(addr && typeof addr === 'object' && typeof addr.port === 'number', 'expected server to be listening');
    const port = addr.port;

    const statePath = join(tmp, 'expo.state.json');
    await writeFile(statePath, JSON.stringify({ pid: 999999, port }, null, 2) + '\n', 'utf-8');

    const res = await isStateProcessRunning(statePath);
    assert.equal(res.running, false);
  } finally {
    await close(srv).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});

async function spawnMetroLikeServer({ includeNeedle = '' } = {}) {
  const needle = String(includeNeedle ?? '').trim();
  const script = `
    const http = require('http');
    const needle = process.argv[2] || '';
    const srv = http.createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('packager-status:running');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      console.log(JSON.stringify({ port, pid: process.pid, needle }));
    });
    setInterval(() => {}, 1000);
  `.trim();
  const args = ['-e', script, ...(needle ? [needle] : [])];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const line = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const idx = buf.indexOf('\n');
      if (idx >= 0) resolve(buf.slice(0, idx));
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`[test] metro-like child exited unexpectedly (code=${code ?? 'unknown'})`)));
  });
  const meta = JSON.parse(String(line ?? '').trim());
  return {
    child,
    port: Number(meta.port),
    async kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    },
  };
}

test('isStateProcessRunning does not treat an unrelated Metro on the same port as running when projectDir mismatches', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-state-running-'));
  const metro = await spawnMetroLikeServer();
  try {
    assert.ok(Number.isFinite(metro.port) && metro.port > 0, 'expected metro-like child to report a port');
    const statePath = join(tmp, 'expo.state.json');
    await writeFile(
      statePath,
      JSON.stringify({ pid: 999999, port: metro.port, projectDir: '/tmp/definitely-not-the-metro-project' }, null, 2) + '\n',
      'utf-8'
    );

    const res = await isStateProcessRunning(statePath);
    assert.equal(res.running, false);
  } finally {
    await metro.kill().catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});
