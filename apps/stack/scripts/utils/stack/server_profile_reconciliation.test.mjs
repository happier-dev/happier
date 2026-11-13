import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertStackServerProfileReconciled,
  classifyStackServerProfileFailure,
  buildStackServerProfileSetArgs,
} from './server_profile_reconciliation.mjs';

function readFlag(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

test('the stack-owned profile advertises the stack canonical URL and keeps loopback as the local URL', () => {
  // The CLI builds pairing links from the profile's canonical `serverUrl`, so writing the
  // loopback address there hands phones and browsers an address only this machine can reach.
  const args = buildStackServerProfileSetArgs({
    serverId: 'stack_repo-dev-a1cc5e0671__id_default',
    internalServerUrl: 'http://127.0.0.1:53288',
    publicServerUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
  });

  assert.equal(readFlag(args, '--server-url'), 'http://happier-repo-dev-a1cc5e0671.localhost:53288');
  assert.equal(readFlag(args, '--local-server-url'), 'http://127.0.0.1:53288');
  assert.equal(readFlag(args, '--webapp-url'), 'http://happier-repo-dev-a1cc5e0671.localhost:53288');
  assert.equal(readFlag(args, '--server-id'), 'stack_repo-dev-a1cc5e0671__id_default');
});

test('a stack without a distinct public URL keeps one loopback address on both URLs', () => {
  const args = buildStackServerProfileSetArgs({
    serverId: 'stack_local__id_default',
    internalServerUrl: 'http://127.0.0.1:41000',
    publicServerUrl: 'http://127.0.0.1:41000',
  });

  assert.equal(readFlag(args, '--server-url'), 'http://127.0.0.1:41000');
  assert.equal(readFlag(args, '--local-server-url'), 'http://127.0.0.1:41000');
});

test('reconciliation rejects a CLI that exits successfully without applying the profile', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-stack-profile-verification-'));
  const serverId = 'stack_repo-dev-a1cc5e0671__id_default';
  await writeFile(join(homeDir, 'settings.json'), JSON.stringify({
    schemaVersion: 6,
    activeServerId: serverId,
    servers: {
      [serverId]: {
        id: serverId,
        serverUrl: 'http://old.localhost:53288',
        localServerUrl: 'http://127.0.0.1:3012',
        webappUrl: 'http://old.localhost:3012',
      },
    },
  }), 'utf8');

  assert.throws(
    () => assertStackServerProfileReconciled({
      homeDir,
      serverId,
      internalServerUrl: 'http://127.0.0.1:53288',
      publicServerUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
    }),
    (error) => error?.code === 'ESTACKCLIPROFILERECONCILIATION',
  );
});

test('reconciliation accepts the canonical and local URLs persisted by the CLI', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-stack-profile-verification-'));
  const serverId = 'stack_local__id_default';
  await writeFile(join(homeDir, 'settings.json'), JSON.stringify({
    schemaVersion: 6,
    activeServerId: serverId,
    servers: {
      [serverId]: {
        id: serverId,
        serverUrl: 'http://localhost:41000',
        localServerUrl: 'http://127.0.0.1:41000',
        webappUrl: 'http://localhost:41000',
      },
    },
  }), 'utf8');

  assert.doesNotThrow(() => assertStackServerProfileReconciled({
    homeDir,
    serverId,
    internalServerUrl: 'http://127.0.0.1:41000',
    publicServerUrl: 'http://localhost:41000',
  }));
});

test('reconciliation accepts the CLI shape that omits a local URL equal to the canonical URL', async () => {
  // A stack without a distinct public URL sends one loopback address on both flags, and the CLI
  // profile writer collapses that split instead of persisting `localServerUrl`.
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-stack-profile-verification-'));
  const serverId = 'stack_local__id_default';
  await writeFile(join(homeDir, 'settings.json'), JSON.stringify({
    schemaVersion: 6,
    activeServerId: serverId,
    servers: {
      [serverId]: {
        id: serverId,
        serverUrl: 'http://127.0.0.1:41000',
        webappUrl: 'http://127.0.0.1:41000',
      },
    },
  }), 'utf8');

  assert.doesNotThrow(() => assertStackServerProfileReconciled({
    homeDir,
    serverId,
    internalServerUrl: 'http://127.0.0.1:41000',
    publicServerUrl: 'http://127.0.0.1:41000',
  }));
});

test('reconciliation refuses to write a profile without both URLs', () => {
  assert.throws(
    () => buildStackServerProfileSetArgs({ serverId: 'stack_x', internalServerUrl: '', publicServerUrl: 'http://localhost:1' }),
    /requires an id and both server URLs/,
  );
});

test('profile refusal preserves auth reason and stops worker retries without copying child payload', () => {
  const error = new Error('child failed\n[stdout] '+JSON.stringify({v:1,ok:false,kind:'server_set',error:{code:'not_authenticated',message:'private child payload'}}));
  error.exitCode = 1;
  const refusal = classifyStackServerProfileFailure(error);
  assert.equal(refusal.code, 'not_authenticated');
  assert.equal(refusal.retryable, false);
  assert.equal(refusal.phase, 'home-profile');
  assert.equal(refusal.entryGraph, 'cli');
  assert.ok(!refusal.message.includes('private child payload'));
  assert.equal(classifyStackServerProfileFailure(new Error('transport failed')), null);
  error.exitCode = 2;
  assert.equal(classifyStackServerProfileFailure(error), null);
});
