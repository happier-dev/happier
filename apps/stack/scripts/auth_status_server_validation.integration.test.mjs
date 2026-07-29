import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { authScriptPath, runNodeCapture } from './testkit/auth_testkit.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';

function credentialsWithToken(token) {
  return JSON.stringify({
    token,
    secret: Buffer.from('test-secret').toString('base64'),
  });
}

async function writeAuthStackEnv({ envPath, port, cliHomeDir }) {
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_SERVER_PORT=${port}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function startStubAuthServer({ profileStatusCode, profileBody, expectedToken }) {
  const server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 500;
      res.end('missing url');
      return;
    }
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    if (req.url === '/v1/account/profile') {
      const auth = String(req.headers.authorization ?? '');
      const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (expectedToken && token !== expectedToken) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: `unexpected token: ${token}` }));
        return;
      }
      res.statusCode = profileStatusCode;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(profileBody));
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not-found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to resolve stub server address');
  }
  return {
    server,
    port: address.port,
    close: async () => {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

test('hstack stack auth status marks credentials invalid when server rejects token with reason code', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-status-server-invalid-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const cliHomeDir = join(tmp, 'cli');
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), credentialsWithToken('bad-token'), 'utf-8');

  const stub = await startStubAuthServer({
    profileStatusCode: 401,
    profileBody: { error: 'Invalid token', code: 'account-not-found' },
    expectedToken: 'bad-token',
  });
  t.after(async () => {
    await stub.close();
  });
  const envPath = join(tmp, 'stack.env');
  await writeAuthStackEnv({ envPath, port: stub.port, cliHomeDir });

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'dev',
    HAPPIER_STACK_ENV_FILE: envPath,
  };

  const res = await runNodeCapture([authScriptPath(rootDir), 'status', '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.auth.hasAccessKey, true);
  assert.equal(payload.auth.serverValidation.checked, true);
  assert.equal(payload.auth.serverValidation.valid, false);
  assert.equal(payload.auth.serverValidation.status, 401);
  assert.equal(payload.auth.serverValidation.code, 'account-not-found');
});

test('hstack stack auth status marks credentials valid when profile endpoint accepts token', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-status-server-valid-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const cliHomeDir = join(tmp, 'cli');
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), credentialsWithToken('good-token'), 'utf-8');

  const stub = await startStubAuthServer({
    profileStatusCode: 200,
    profileBody: { id: 'acc-1' },
    expectedToken: 'good-token',
  });
  t.after(async () => {
    await stub.close();
  });
  const envPath = join(tmp, 'stack.env');
  await writeAuthStackEnv({ envPath, port: stub.port, cliHomeDir });

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'dev',
    HAPPIER_STACK_ENV_FILE: envPath,
  };

  const res = await runNodeCapture([authScriptPath(rootDir), 'status', '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.auth.hasAccessKey, true);
  assert.equal(payload.auth.serverValidation.checked, true);
  assert.equal(payload.auth.serverValidation.valid, true);
  assert.equal(payload.auth.serverValidation.status, 200);
  assert.equal(payload.auth.serverValidation.code, 'ok');
});

test('fresh stack auth status reads credentials written under the guided-login stable server identity', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-status-guided-login-identity-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const stackName = 'voice-current';
  const cliHomeDir = join(tmp, 'cli');
  const activeServerId = buildStackStableScopeId({ stackName, cliIdentity: 'default' });
  const credentialPath = join(cliHomeDir, 'servers', activeServerId, 'access.key');
  await mkdir(dirname(credentialPath), { recursive: true });
  await writeFile(credentialPath, credentialsWithToken('guided-login-token'), 'utf-8');

  const stub = await startStubAuthServer({
    profileStatusCode: 200,
    profileBody: { id: 'acc-guided' },
    expectedToken: 'guided-login-token',
  });
  t.after(async () => {
    await stub.close();
  });

  const envPath = join(tmp, 'stack.env');
  await writeAuthStackEnv({ envPath, port: stub.port, cliHomeDir });
  const res = await runNodeCapture([authScriptPath(rootDir), 'status', '--json'], {
    cwd: rootDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
    },
  });

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.auth.hasAccessKey, true);
  assert.equal(payload.auth.accessKeyPath, credentialPath);
  assert.equal(payload.auth.serverValidation.valid, true);
});

test('fresh stack auth status with --identity reads that identity stable server credentials', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-status-guided-login-named-identity-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const stackName = 'voice-current';
  const identity = 'account-b';
  const defaultCliHomeDir = join(tmp, 'cli');
  const identityCliHomeDir = join(tmp, 'cli-identities', identity);
  const activeServerId = buildStackStableScopeId({ stackName, cliIdentity: identity });
  const credentialPath = join(identityCliHomeDir, 'servers', activeServerId, 'access.key');
  await mkdir(dirname(credentialPath), { recursive: true });
  await writeFile(credentialPath, credentialsWithToken('named-identity-token'), 'utf-8');

  const stub = await startStubAuthServer({
    profileStatusCode: 200,
    profileBody: { id: 'acc-named' },
    expectedToken: 'named-identity-token',
  });
  t.after(async () => {
    await stub.close();
  });

  const envPath = join(tmp, 'stack.env');
  await writeAuthStackEnv({ envPath, port: stub.port, cliHomeDir: defaultCliHomeDir });
  const res = await runNodeCapture(
    [authScriptPath(rootDir), 'status', `--identity=${identity}`, '--json'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
      },
    },
  );

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.cliIdentity, identity);
  assert.equal(payload.auth.hasAccessKey, true);
  assert.equal(payload.auth.accessKeyPath, credentialPath);
  assert.equal(payload.auth.serverValidation.valid, true);
});
