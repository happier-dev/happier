// @happier-test-preparation source-condition
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createPrivateKey, createPublicKey, randomBytes, verify } from 'node:crypto';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, createKeyChallengeV2SigningInput, formatRecoveryKey } from '@happier-dev/protocol';

import {
  assertGuidedAuthWebappReadyOrThrow,
  buildStackAuthLoginInvocation,
  resolveServerPortForCoreAuth,
} from './utils/auth/stack_guided_login.mjs';
import { createAuthStackFixture, getStackRootFromMeta } from './testkit/auth_testkit.mjs';
import { writeRuntimeSnapshotLayout } from './testkit/core/runtime_snapshot_layout.mjs';
import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { buildAuthSafeStackStartSpec } from './utils/auth/buildAuthSafeStackStartSpec.mjs';
import { runCommandCapture } from './testkit/core/run_node_capture.mjs';

function sourceRuntimeEnv() {
  return {
    ...process.env,
    HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_RUNTIME_MODE: 'source',
    HAPPIER_STACK_RUNTIME_STATE_PATH: '',
  };
}

test('stack recovery redeems the existing Account through its listener while preserving canonical Home and native scope', async t => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const stackName = 'recovery-audience';
  const canonical = ['https:', '', 'recovery-home.invalid'].join('/');
  const fixture = await createAuthStackFixture({ t, prefix: 'hstack-recovery-audience-', stackName,
    stackEnvLines: [`HAPPIER_PUBLIC_SERVER_URL=${canonical}`] });
  const home = join(fixture.tmpDir, 'cli');
  const scope = `stack_${stackName}__id_default`;
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const account = { id: 'existing-recovery-account', publicKey };
  const challenge = { challengeId: 'recovery-audience-challenge', nonce: randomBytes(32).toString('base64'),
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
    audience: { origin: canonical, serverIdentityId: 'srv_recovery_audience' } };
  const features = { features: {}, capabilities: { serverIdentity: { serverIdentityId: challenge.audience.serverIdentityId },
    accountStoredContentCompatibility: { v: 1, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
      minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1' } } };
  let redeemed = false;
  let registered = false;
  let challengeIssued = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/v1/features' || req.url === '/v1/features/authenticated') return send(features);
    if (req.url === '/v1/auth/challenge') { challengeIssued = true; return send(challenge); }
    if (req.url === '/v1/auth') {
      redeemed = body.requireExistingAccount === true && body.challengeId === challenge.challengeId
        && Buffer.from(body.publicKey ?? '', 'base64').equals(account.publicKey)
        && verify(null, createKeyChallengeV2SigningInput({ ...challenge, requireExistingAccount: true }),
          createPublicKey(privateKey), Buffer.from(body.signature ?? '', 'base64'));
      if (!redeemed) return send({ error: 'authentication_failed' }, 401);
      const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: account.id, exp: 4_000_000_000,
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
      return send({ success: true, token });
    }
    if (req.url === '/v1/account/encryption') return send({ mode: 'e2ee', updatedAt: 1 });
    if (req.url === '/v1/machines') {
      registered = true;
      return send({ machine: { id: body.id, metadata: body.metadata, metadataVersion: 1, daemonState: null,
        daemonStateVersion: 0, dataEncryptionKey: body.dataEncryptionKey ?? null } });
    }
    return send({ error: 'fixture_route_missing' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const listener = ['http:', '', `127.0.0.1:${server.address().port}`].join('/');
  const invocation = await buildStackAuthLoginInvocation({ rootDir, stackName, webappUrl: canonical, recoveryKeyStdin: true,
    env: fixture.buildEnv({ HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_STACK_RUNTIME_STATE_PATH: '',
      HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: scope, HAPPIER_STACK_SERVER_PORT: String(server.address().port),
      HAPPIER_SERVER_URL: listener, HAPPIER_LOCAL_SERVER_URL: listener, HAPPIER_PUBLIC_SERVER_URL: canonical,
      HAPPIER_AUTH_AUTO_START_DAEMON: '0' }) });
  const input = JSON.stringify({ v: 1, secrets: { recoveryKey: formatRecoveryKey(seed) } });
  const result = await runCommandCapture(invocation.command, invocation.args, { cwd: rootDir, env: invocation.env, input });
  const envelope = result.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(value => value.kind === 'auth_recovery_key_login');
  if (envelope?.ok !== true) console.log(JSON.stringify({ recoveryFailure: { code: envelope?.error?.code, phase: envelope?.error?.phase, exitCode: result.code } }));
  assert.equal(challengeIssued, true, 'the real CLI must reach the Home challenge before the redemption assertion');
  assert.equal(redeemed, true, 'the existing Account must redeem a proof bound to its canonical Home through the private listener');
  assert.equal(registered, true, 'successful redemption must reach real machine registration');
  assert.equal(envelope?.ok, true, 'the real recovery command must accept the versioned stdin envelope');
  assert.equal(envelope?.data?.serverId, scope, 'auth and readiness must retain the same native scope');
  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes(input) || result.stderr.includes(input), false);
});

test('source recovery-key login uses the existing stdin contract without device approval', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const invocation = await buildStackAuthLoginInvocation({ rootDir, stackName: 'main',
    webappUrl: ['https:', '', 'app.happier.dev'].join('/'), recoveryKeyStdin: true, env: sourceRuntimeEnv() });
  assert.deepEqual(invocation.args.slice(-5), ['auth', 'recovery-key', 'login', '--secrets-json-stdin', '--json']);
  assert.ok(invocation.args.includes(join(rootDir, '..', 'cli', 'src', 'index.ts')));
  assert.ok(invocation.env.HAPPIER_LOCAL_SERVER_URL);
  assert.equal(invocation.args.includes('--key'), false, 'Stack must never put recovery material in process arguments');
});

test('guided stack auth login invokes core happier auth login directly', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const webappUrl = 'http://localhost:1234';
  const inv = await buildStackAuthLoginInvocation({ rootDir, stackName: 'main', webappUrl, env: sourceRuntimeEnv() });
  assert.ok(Array.isArray(inv?.args));
  assert.equal(inv.command, process.execPath);
  assert.ok(inv.args.includes('--conditions=happier-source'));
  assert.ok(inv.args.includes(join(rootDir, '..', 'cli', 'src', 'index.ts')));
  assert.deepEqual(inv.args.slice(-2), ['auth', 'login']);
  assert.equal(inv.env.TSX_TSCONFIG_PATH, join(rootDir, '..', 'cli', 'tsconfig.json'));
  assert.equal(inv?.env?.HAPPIER_WEBAPP_URL, webappUrl);
  assert.notEqual(inv?.env?.HAPPIER_STACK_AUTH_INNER, '1');
});

test('guided stack auth login defaults stack name to main and preserves invocation ordering', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const webappUrl = 'http://localhost:4321';
  const inv = await buildStackAuthLoginInvocation({ rootDir, stackName: '   ', webappUrl, env: sourceRuntimeEnv() });
  assert.deepEqual(inv.args.slice(-2), ['auth', 'login']);
  assert.equal(inv.env.HAPPIER_WEBAPP_URL, webappUrl);
});

test('guided stack auth login invocation merges caller env', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const inv = await buildStackAuthLoginInvocation({
    rootDir,
    stackName: 'feature-1',
    webappUrl: 'http://localhost:5555',
    env: { CUSTOM_FLAG: 'yes', HAPPIER_STACK_AUTH_INNER: '0' },
  });
  assert.equal(inv.env.CUSTOM_FLAG, 'yes');
  assert.equal(inv.env.HAPPIER_STACK_AUTH_INNER, '0');
});

test('guided stack core auth port resolver ignores runtime port backed only by an untrusted live pid', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-guided-auth-untrusted-runtime-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'guided-auth-untrusted';
  const stackDir = join(storageDir, stackName);
  await mkdir(stackDir, { recursive: true });
  await writeFile(
    join(stackDir, 'stack.runtime.json'),
    JSON.stringify({ version: 1, stackName, ownerPid: process.pid, ports: { server: 4555 } }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const port = await resolveServerPortForCoreAuth({
      stackName,
      env: {
        ...sourceRuntimeEnv(),
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_SERVER_PORT: '',
        HAPPIER_SERVER_URL: '',
        HAPPIER_PUBLIC_SERVER_URL: '',
      },
    });
    assert.equal(port, null);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('guided stack auth login invocation rejects empty webappUrl', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  await assert.rejects(
    () => buildStackAuthLoginInvocation({ rootDir, stackName: 'main', webappUrl: '   ' }),
    /requires a webappUrl/i
  );
});

test('guided stack auth login invocation uses the active runtime snapshot cli when runtime mode selects a snapshot', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const fixture = await createAuthStackFixture({
    prefix: 'stack-guided-login-runtime-',
    stackName: 'dev-built',
    stackEnvLines: [
      'HAPPIER_STACK_RUNTIME_MODE=prefer',
    ],
  });

  try {
    const { snapshotDir, daemonDistClosureFingerprint } = await writeRuntimeSnapshotLayout({
      stackDir: join(fixture.storageDir, 'dev-built'),
      snapshotId: 'snap-auth',
      sourceFingerprint: 'src-auth',
      web: {
        content: '<!doctype html><html><body>runtime ui</body></html>\n',
        artifactFingerprint: 'web-auth',
      },
      server: {
        content: '#!/bin/sh\nexit 0\n',
        artifactFingerprint: 'srv-auth',
      },
      daemon: {
        content: '#!/bin/sh\nexit 0\n',
        artifactFingerprint: 'cli-auth',
        nodeEntrypoint: 'cli/package-dist/index.mjs',
        nodeContent: 'export {};\n',
      },
    });

    const inv = await buildStackAuthLoginInvocation({
      rootDir,
      stackName: 'dev-built',
      webappUrl: 'http://localhost:5555',
      env: fixture.buildEnv({
        HAPPIER_STACK_RUNTIME_MODE: 'require',
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '0',
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '/other-checkout/dist/index.mjs',
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'ffffffffffffffff',
      }),
    });

    assert.equal(inv.command, join(snapshotDir, 'cli', 'happier'));
    assert.deepEqual(inv.args.slice(-2), ['auth', 'login']);
    assert.ok(inv.env.HAPPIER_LOCAL_SERVER_URL);
    assert.equal(inv.env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, '1');
    assert.equal(inv.env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, join(snapshotDir, 'cli', 'package-dist', 'index.mjs'));
    assert.equal(inv.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, daemonDistClosureFingerprint);
  } finally {
    await fixture.cleanup();
  }
});

test('guided source snapshot auth consumes the retained CLI and its child environment', async (t) => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const fixture = await createAuthStackFixture({ t, prefix: 'hstack-source-auth-', stackName: 'agent-qa-source' });
  const stackDir = join(fixture.storageDir, 'agent-qa-source');
  const cliDir = join(stackDir, 'source-runtime', 'bundle', 'cli');
  const entrypoint = join(cliDir, 'src', 'index.mjs');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(entrypoint, 'export {};\n');
  await writeFile(join(stackDir, 'stack.runtime.json'), JSON.stringify({
    version: 1, stackName: 'agent-qa-source',
    sourceRuntimeLaunch: { entrypoint, cliDir, env: { HAPPIER_STACK_CLI_ROOT_DIR: cliDir } },
  }));
  const invocation = await buildStackAuthLoginInvocation({ rootDir, stackName: 'agent-qa-source', webappUrl: 'https://cloud.happier.dev',
    env: fixture.buildEnv({ HAPPIER_STACK_RUNTIME_MODE: 'source-snapshot', HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
      HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '/moving/dist/index.mjs',
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'ffffffffffffffff',
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1', HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1' }),
  });
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[0], entrypoint);
  assert.deepEqual(invocation.args.slice(-2), ['auth', 'login']);
  assert.ok(invocation.env.HAPPIER_LOCAL_SERVER_URL);
  assert.equal(invocation.env.HAPPIER_CLI_ROOT_DIR, cliDir);
  assert.equal(invocation.env.HAPPIER_STACK_CLI_ROOT_DIR, cliDir);
  assert.equal(invocation.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT, entrypoint);
  assert.equal(invocation.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX, '0');
  assert.equal(invocation.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK, '0');
  assert.equal(invocation.env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, undefined);
  assert.equal(invocation.env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, undefined);
  assert.equal(invocation.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, undefined);
});

test('source snapshot auth recovery preserves source start even for Expo login', () => {
  const spec = buildAuthSafeStackStartSpec({ rootDir: '/stack', stackName: 'agent-qa', runtimeMode: 'source-snapshot',
    effectiveWebappMode: 'expo', shouldStartDevForAutoAuth: true, baseEnv: {} });
  assert.equal(spec.command, 'start');
  assert.equal(spec.startedStackForExpoAuth, false);
  assert.deepEqual(spec.args[1].slice(1), ['start', 'agent-qa', '--background', '--runtime=source', '--no-daemon', '--no-browser']);
  assert.equal(spec.env.HAPPIER_STACK_AUTH_FLOW, '1');
});

test('guided stack auth login rejects generic runtime-backed HTML without the Happier readiness marker', async (t) => {
  const timeoutMs = 20;
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  // Exercise the real readiness classifier without making its deadline depend on
  // localhost connection scheduling; transport and time are system boundaries.
  t.mock.method(globalThis, 'fetch', async () => {
    clock += timeoutMs;
    return new Response('<!doctype html><html><body>wrong origin</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  });

  await assert.rejects(
    () => assertGuidedAuthWebappReadyOrThrow({
      kind: 'server',
      webappUrl: 'http://guided-login.test',
      timeoutMs,
    }),
    /missing Happier UI readiness marker/i
  );
});
