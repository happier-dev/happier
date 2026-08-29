import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

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
      return { HAPPIER_GITHUB_BOT_TOKEN: 'broker-test-token' };
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

    const rejected = await request(broker.socketPath, {
      version: 1,
      operation: 'read-other-credential',
    });
    assert.deepEqual(rejected, { version: 1, ok: false, error: 'unsupported request' });
    assert.deepEqual(calls, ['read']);
  } finally {
    await broker.close();
  }

  await assert.rejects(stat(broker.socketPath), { code: 'ENOENT' });
});

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
