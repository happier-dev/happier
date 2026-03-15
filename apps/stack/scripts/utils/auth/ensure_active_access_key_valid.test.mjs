import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import http from 'node:http';
import { resolveStackCredentialPaths } from './credentials_paths.mjs';
import { ensureActiveAccessKeyValid } from './ensure_active_access_key_valid.mjs';

function writeAccessKeyFile(path, token) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        encryption: { publicKey: 'AA==', machineKey: 'AA==' },
        token,
      },
      null,
      2,
    ),
  );
}

function readTokenFromAccessKeyFile(path) {
  const raw = readFileSync(path, 'utf8').trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string') return parsed.token.trim();
  } catch {
    // fall through
  }
  return raw;
}

function createTestJwt({ sub, jti }) {
  const headerJson = JSON.stringify({ alg: 'none', typ: 'JWT' });
  const payloadJson = JSON.stringify({ sub, ...(jti ? { jti } : {}) });
  const toB64Url = (s) =>
    Buffer.from(s, 'utf8')
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  // Signature is irrelevant for decodeJwtPayloadUnsafe (and our local test server only does string equality).
  return `${toB64Url(headerJson)}.${toB64Url(payloadJson)}.`;
}

async function withAuthServer({ goodToken }, fn) {
  const server = http.createServer((req, res) => {
    if (!req.url || !req.method) {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (req.method !== 'GET' || req.url !== '/v1/account/profile') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const auth = String(req.headers.authorization ?? '').trim();
    if (auth === `Bearer ${goodToken}`) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn({ serverUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('ensureActiveAccessKeyValid repairs server-scoped access key from url-hash key when active key is unauthorized', async () => {
  const home = mkdtempSync(join(tmpdir(), 'happier-stack-cred-repair-'));
  try {
    await withAuthServer({ goodToken: 'good-token' }, async ({ serverUrl }) => {
      const env = { HAPPIER_ACTIVE_SERVER_ID: 'stack_test__id_default' };
      const resolved = resolveStackCredentialPaths({ cliHomeDir: home, serverUrl, env });
      assert.ok(resolved.urlHashServerScopedPath, 'expected url-hash server scoped path');
      assert.ok(resolved.hostPortServerScopedPath, 'expected host-port server scoped path');

      writeAccessKeyFile(resolved.serverScopedPath, 'bad-token');
      writeAccessKeyFile(resolved.urlHashServerScopedPath, 'good-token');

      const result = await ensureActiveAccessKeyValid({ cliHomeDir: home, serverUrl, env, timeoutMs: 2_500 });
      assert.equal(result.kind, 'repaired');
      assert.equal(result.sourcePath, resolved.urlHashServerScopedPath);
      assert.equal(readTokenFromAccessKeyFile(resolved.serverScopedPath), 'good-token');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureActiveAccessKeyValid repairs server-scoped access key from host-port key when active key is unauthorized', async () => {
  const home = mkdtempSync(join(tmpdir(), 'happier-stack-cred-repair-hostport-'));
  try {
    await withAuthServer({ goodToken: 'good-token' }, async ({ serverUrl }) => {
      const env = { HAPPIER_ACTIVE_SERVER_ID: 'stack_test__id_default' };
      const resolved = resolveStackCredentialPaths({ cliHomeDir: home, serverUrl, env });
      assert.ok(resolved.hostPortServerScopedPath, 'expected host-port server scoped path');

      writeAccessKeyFile(resolved.serverScopedPath, 'bad-token');
      writeAccessKeyFile(resolved.hostPortServerScopedPath, 'good-token');

      const result = await ensureActiveAccessKeyValid({ cliHomeDir: home, serverUrl, env, timeoutMs: 2_500 });
      assert.equal(result.kind, 'repaired');
      assert.equal(result.sourcePath, resolved.hostPortServerScopedPath);
      assert.equal(readTokenFromAccessKeyFile(resolved.serverScopedPath), 'good-token');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureActiveAccessKeyValid does not overwrite an already-valid server-scoped access key', async () => {
  const home = mkdtempSync(join(tmpdir(), 'happier-stack-cred-keep-'));
  try {
    await withAuthServer({ goodToken: 'good-token' }, async ({ serverUrl }) => {
      const env = { HAPPIER_ACTIVE_SERVER_ID: 'stack_test__id_default' };
      const resolved = resolveStackCredentialPaths({ cliHomeDir: home, serverUrl, env });
      assert.ok(resolved.urlHashServerScopedPath, 'expected url-hash server scoped path');

      writeAccessKeyFile(resolved.serverScopedPath, 'good-token');
      writeAccessKeyFile(resolved.urlHashServerScopedPath, 'other-token');

      const result = await ensureActiveAccessKeyValid({ cliHomeDir: home, serverUrl, env, timeoutMs: 2_500 });
      assert.equal(result.kind, 'ok');
      assert.equal(readTokenFromAccessKeyFile(resolved.serverScopedPath), 'good-token');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureActiveAccessKeyValid seeds missing server-scoped access key from legacy access.key when legacy token is valid', async () => {
  const home = mkdtempSync(join(tmpdir(), 'happier-stack-cred-legacy-'));
  try {
    await withAuthServer({ goodToken: 'good-token' }, async ({ serverUrl }) => {
      const env = { HAPPIER_ACTIVE_SERVER_ID: 'stack_test__id_default' };
      const resolved = resolveStackCredentialPaths({ cliHomeDir: home, serverUrl, env });

      assert.equal(existsSync(resolved.serverScopedPath), false);
      writeAccessKeyFile(resolved.legacyPath, 'good-token');

      const result = await ensureActiveAccessKeyValid({ cliHomeDir: home, serverUrl, env, timeoutMs: 2_500 });
      assert.equal(result.kind, 'repaired');
      assert.equal(result.sourcePath, resolved.legacyPath);
      assert.equal(readTokenFromAccessKeyFile(resolved.serverScopedPath), 'good-token');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureActiveAccessKeyValid does not switch accounts when the active key is a JWT for a different sub', async () => {
  const home = mkdtempSync(join(tmpdir(), 'happier-stack-cred-repair-sub-guard-'));
  try {
    const goodToken = createTestJwt({ sub: 'account-b' });
    await withAuthServer({ goodToken }, async ({ serverUrl }) => {
      const env = { HAPPIER_ACTIVE_SERVER_ID: 'stack_test__id_default' };
      const resolved = resolveStackCredentialPaths({ cliHomeDir: home, serverUrl, env });
      assert.ok(resolved.urlHashServerScopedPath, 'expected url-hash server scoped path');

      const activeToken = createTestJwt({ sub: 'account-a' });
      writeAccessKeyFile(resolved.serverScopedPath, activeToken);
      writeAccessKeyFile(resolved.urlHashServerScopedPath, goodToken);

      const result = await ensureActiveAccessKeyValid({ cliHomeDir: home, serverUrl, env, timeoutMs: 2_500 });
      assert.equal(result.kind, 'unresolved');
      assert.equal(readTokenFromAccessKeyFile(resolved.serverScopedPath), activeToken);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureActiveAccessKeyValid repairs server-scoped key when both active and fallback keys share the same JWT sub', async () => {
  const home = mkdtempSync(join(tmpdir(), 'happier-stack-cred-repair-sub-match-'));
  try {
    const goodToken = createTestJwt({ sub: 'account-a', jti: 'good' });
    await withAuthServer({ goodToken }, async ({ serverUrl }) => {
      const env = { HAPPIER_ACTIVE_SERVER_ID: 'stack_test__id_default' };
      const resolved = resolveStackCredentialPaths({ cliHomeDir: home, serverUrl, env });
      assert.ok(resolved.urlHashServerScopedPath, 'expected url-hash server scoped path');

      const activeToken = createTestJwt({ sub: 'account-a', jti: 'active' });
      writeAccessKeyFile(resolved.serverScopedPath, activeToken);
      writeAccessKeyFile(resolved.urlHashServerScopedPath, goodToken);

      const result = await ensureActiveAccessKeyValid({ cliHomeDir: home, serverUrl, env, timeoutMs: 2_500 });
      assert.equal(result.kind, 'repaired');
      assert.equal(readTokenFromAccessKeyFile(resolved.serverScopedPath), goodToken);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
