import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertStackServerProfileReconciled,
  classifyStackServerProfileFailure,
  buildStackServerProfileSetArgs,
  readStackOwnServerIdentity,
  stackOwnsServerProfile,
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

test('an explicit --server naming a profile of the stack public URL is the stack endpoint, a foreign profile is not', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'hstack-profile-own-'));
  const profile = (id, serverUrl) => ({ id, serverUrl, localServerUrl: 'http://127.0.0.1:15836', webappUrl: serverUrl });
  await writeFile(join(homeDir, 'settings.json'), JSON.stringify({
    schemaVersion: 5,
    activeServerId: 'stack_qa__id_d',
    servers: {
      'qa.localhost-3039': profile('qa.localhost-3039', 'http://qa.localhost:3039'),
      cloud: profile('cloud', 'https://api.example.com'),
    },
  }));
  const publicServerUrl = 'http://qa.localhost:3039';

  assert.equal(stackOwnsServerProfile({ homeDir, serverId: 'qa.localhost-3039', publicServerUrl }), true);
  assert.equal(stackOwnsServerProfile({ homeDir, serverId: 'cloud', publicServerUrl }), false);
  assert.equal(stackOwnsServerProfile({ homeDir, serverId: 'missing', publicServerUrl }), false);
});

test('the stack reads its own server identity record with the server parser and refuses a malformed one', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'hstack-own-identity-'));
  const env = { HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'main', HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir };
  assert.equal(readStackOwnServerIdentity(env), null);
  await mkdir(join(dataDir, 'runtime'), { recursive: true });
  await writeFile(join(dataDir, 'runtime', 'server.identity'), 'srv_stack_own\n');
  assert.equal(readStackOwnServerIdentity(env), 'srv_stack_own');
  await writeFile(join(dataDir, 'runtime', 'server.identity'), 'not-a-home-identity\n');
  assert.throws(() => readStackOwnServerIdentity(env), /server\.identity/);
});
