import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

import {
  prepareGhopsBrokerDirectory,
  startGhopsCredentialBroker,
} from './ghops_credential_broker.mjs';

function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('error', reject);
    socket.once('close', () => resolve(JSON.parse(response.trim())));
  });
}

test('serves only the fixed ghops credential over a user-only ephemeral socket', async () => {
  const calls = [];
  const broker = await startGhopsCredentialBroker({
    readCredential() {
      calls.push('read');
      return { HAPPIER_GITHUB_BOT_TOKEN: calls.length === 1 ? 'broker-test-token' : 'rotated-test-token' };
    },
  });
  try {
    const socketInfo = await stat(broker.socketPath);
    assert.equal(socketInfo.mode & 0o777, 0o600);
    const directoryInfo = await stat(dirname(broker.socketPath));
    assert.equal(directoryInfo.mode & 0o777, 0o700);

    const response = await request(broker.socketPath, {
      version: 1,
      operation: 'read-ghops-credential',
    });
    assert.deepEqual(response, {
      version: 1,
      ok: true,
      credential: { HAPPIER_GITHUB_BOT_TOKEN: 'broker-test-token' },
    });
    assert.deepEqual(calls, ['read']);

    const rotated = await request(broker.socketPath, { version: 1, operation: 'read-ghops-credential' });
    assert.equal(rotated.credential.HAPPIER_GITHUB_BOT_TOKEN, 'rotated-test-token');
    assert.deepEqual(calls, ['read', 'read']);

    const rejected = await request(broker.socketPath, {
      version: 1,
      operation: 'read-other-credential',
    });
    assert.deepEqual(rejected, { version: 1, ok: false, error: 'unsupported request' });
    assert.deepEqual(calls, ['read', 'read']);
  } finally {
    await broker.close();
  }

  await assert.rejects(stat(broker.socketPath), { code: 'ENOENT' });
});

test('startup prunes refused sockets but preserves live sockets, regular files and symlinks', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'g-p-', parentDir: '/tmp' });
  const rootDirectory = fixture.root;
  const uid = process.getuid();
  const directory = await prepareGhopsBrokerDirectory({ rootDirectory, uid });
  const stalePath = join(directory, 'broker-dead.sock');
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import { createServer } from "node:net"; createServer().listen(process.argv[1], () => process.stdout.write("ready\\n"));', stalePath],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  await once(child, 'close');
  assert.equal((await stat(stalePath)).isSocket(), true);
  const live = await startGhopsCredentialBroker({ rootDirectory, uid, readCredential: () => ({}) });
  t.after(() => live.close());
  const file = join(directory, 'broker-file.sock');
  const link = join(directory, 'broker-link.sock');
  await writeFile(file, 'preserve');
  await symlink(live.socketPath, link);
  const next = await startGhopsCredentialBroker({ rootDirectory, uid, readCredential: () => ({}) });
  t.after(() => next.close());
  await assert.rejects(stat(stalePath), { code: 'ENOENT' });
  assert.equal((await stat(file)).isFile(), true);
  assert.equal((await stat(link)).isSocket(), true);
  assert.deepEqual(await request(live.socketPath, { version: 1, operation: 'read-other-credential' }),
    { version: 1, ok: false, error: 'unsupported request' });
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`login-session entrypoint removes its socket on ${signal}`, async (t) => {
    const child = spawn(process.execPath, [new URL('../../ghops_credential_broker.mjs', import.meta.url).pathname],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    const [output] = await once(child.stdout, 'data');
    const socketPath = String(output).trim().split('ready: ')[1];
    assert.equal((await stat(socketPath)).isSocket(), true);
    child.kill(signal);
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    await assert.rejects(stat(socketPath), { code: 'ENOENT' });
  });
}

test('does not expose Keychain failure details through the broker protocol', async () => {
  const broker = await startGhopsCredentialBroker({
    readCredential() {
      throw new Error('sensitive Keychain diagnostic');
    },
  });
  try {
    const response = await request(broker.socketPath, {
      version: 1,
      operation: 'read-ghops-credential',
    });
    assert.deepEqual(response, { version: 1, ok: false, error: 'credential unavailable' });
    assert.doesNotMatch(JSON.stringify(response), /sensitive/);
  } finally {
    await broker.close();
  }
});

test('rejects a symlink at the predictable per-user broker directory', async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'happier-ghops-broker-root-'));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const target = join(rootDirectory, 'attacker-controlled-target');
  await mkdir(target);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  await symlink(target, join(rootDirectory, `happier-ghops-brokers-${uid}`));

  await assert.rejects(
    prepareGhopsBrokerDirectory({ rootDirectory, uid }),
    /real directory owned by the execution-host user/,
  );
});
