import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveStackCredentialPaths,
  findExistingStackCredentialPath,
  findAnyCredentialPathInCliHome,
  resolveStackDaemonStatePaths,
  resolvePreferredStackDaemonStatePaths,
} from './credentials_paths.mjs';

test('resolveStackCredentialPaths returns legacy + server-scoped paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const out = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl });
  assert.equal(out.legacyPath, join(dir, 'access.key'));
  assert.ok(out.serverScopedPath.startsWith(join(dir, 'servers', 'env_')));
  assert.ok(out.serverScopedPath.endsWith('/access.key'));
  assert.deepEqual(out.paths, [out.serverScopedPath, out.legacyPath]);
});

test('findExistingStackCredentialPath prefers server-scoped credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const out = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl });

  await mkdir(join(dir, 'servers', out.activeServerId), { recursive: true });
  await writeFile(out.legacyPath, 'legacy\n', 'utf-8');
  await writeFile(out.serverScopedPath, 'server\n', 'utf-8');

  const found = findExistingStackCredentialPath({ cliHomeDir: dir, serverUrl });
  assert.equal(found, out.serverScopedPath);
});

test('findExistingStackCredentialPath falls back to legacy access.key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const out = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl });
  await writeFile(out.legacyPath, 'legacy\n', 'utf-8');

  const found = findExistingStackCredentialPath({ cliHomeDir: dir, serverUrl });
  assert.equal(found, out.legacyPath);
});

test('findExistingStackCredentialPath keeps server-url isolation and falls back to legacy when resolved scope paths are empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const out = resolveStackCredentialPaths({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default' },
  });

  const otherServerScoped = join(dir, 'servers', 'stack_dev-auth__id_default', 'access.key');
  await mkdir(join(dir, 'servers', 'stack_dev-auth__id_default'), { recursive: true });
  await writeFile(out.legacyPath, 'legacy\n', 'utf-8');
  await writeFile(otherServerScoped, 'server-scoped\n', 'utf-8');

  const found = findExistingStackCredentialPath({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default' },
  });
  assert.equal(found, out.legacyPath);
});

test('findAnyCredentialPathInCliHome prefers server-scoped credentials over legacy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-any-cred-paths-'));
  const legacyPath = join(dir, 'access.key');
  const serverScopedPath = join(dir, 'servers', 'stack_main__id_default', 'access.key');

  await mkdir(join(dir, 'servers', 'stack_main__id_default'), { recursive: true });
  await writeFile(legacyPath, 'legacy\n', 'utf-8');
  await writeFile(serverScopedPath, 'server\n', 'utf-8');

  const found = findAnyCredentialPathInCliHome({ cliHomeDir: dir });
  assert.equal(found, serverScopedPath);
});

test('resolveStackCredentialPaths uses HAPPIER_ACTIVE_SERVER_ID when provided', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const out = resolveStackCredentialPaths({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default' },
  });
  assert.equal(out.activeServerId, 'stack_main__id_default');
  assert.ok(out.serverScopedPath.endsWith('/servers/stack_main__id_default/access.key'));
  assert.ok(out.urlHashServerScopedPath.endsWith('/access.key'));
  assert.notEqual(out.serverScopedPath, out.urlHashServerScopedPath);
});

test('findExistingStackCredentialPath falls back to url-hash path when stable scope path is empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const out = resolveStackCredentialPaths({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default' },
  });

  await mkdir(join(dir, 'servers', out.urlHashServerId), { recursive: true });
  await writeFile(out.urlHashServerScopedPath, 'legacy-hash\n', 'utf-8');

  const found = findExistingStackCredentialPath({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default' },
  });
  assert.equal(found, out.urlHashServerScopedPath);
});

test('resolveStackDaemonStatePaths returns legacy + server-scoped state and lock paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-paths-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const out = resolveStackDaemonStatePaths({ cliHomeDir: dir, serverUrl });

  assert.equal(out.legacyStatePath, join(dir, 'daemon.state.json'));
  assert.equal(out.legacyLockPath, join(dir, 'daemon.state.json.lock'));
  assert.ok(out.serverScopedStatePath.startsWith(join(dir, 'servers', 'env_')));
  assert.ok(out.serverScopedStatePath.endsWith('/daemon.state.json'));
  assert.ok(out.serverScopedLockPath.endsWith('/daemon.state.json.lock'));
});

test('resolvePreferredStackDaemonStatePaths prefers server-scoped paths when present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-paths-'));
  const serverUrl = 'http://127.0.0.1:3010';
  const out = resolveStackDaemonStatePaths({ cliHomeDir: dir, serverUrl });

  await mkdir(join(dir, 'servers', out.activeServerId), { recursive: true });
  await writeFile(out.serverScopedLockPath, `${process.pid}\n`, 'utf-8');

  const preferred = resolvePreferredStackDaemonStatePaths({ cliHomeDir: dir, serverUrl });
  assert.equal(preferred.statePath, out.serverScopedStatePath);
  assert.equal(preferred.lockPath, out.serverScopedLockPath);
});

test('resolvePreferredStackDaemonStatePaths falls back to legacy paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-paths-'));
  const serverUrl = 'http://127.0.0.1:3011';
  const out = resolveStackDaemonStatePaths({ cliHomeDir: dir, serverUrl });

  await writeFile(out.legacyLockPath, `${process.pid}\n`, 'utf-8');

  const preferred = resolvePreferredStackDaemonStatePaths({ cliHomeDir: dir, serverUrl });
  assert.equal(preferred.statePath, out.legacyStatePath);
  assert.equal(preferred.lockPath, out.legacyLockPath);
});

test('resolvePreferredStackDaemonStatePaths falls back to url-hash server-scoped state when stable scope is empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-paths-'));
  const serverUrl = 'http://127.0.0.1:3011';
  const out = resolveStackDaemonStatePaths({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default' },
  });

  await mkdir(join(dir, 'servers', out.urlHashServerId), { recursive: true });
  await writeFile(out.urlHashServerScopedLockPath, `${process.pid}\n`, 'utf-8');

  const preferred = resolvePreferredStackDaemonStatePaths({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default' },
  });
  assert.equal(preferred.statePath, out.urlHashServerScopedStatePath);
  assert.equal(preferred.lockPath, out.urlHashServerScopedLockPath);
});

test('resolveStackCredentialPaths throws when cliHomeDir is empty', () => {
  assert.throws(
    () => resolveStackCredentialPaths({ cliHomeDir: '', serverUrl: 'http://127.0.0.1:3009' }),
    /cliHomeDir is required/i
  );
});

test('resolveStackDaemonStatePaths throws when cliHomeDir is empty', () => {
  assert.throws(
    () => resolveStackDaemonStatePaths({ cliHomeDir: '', serverUrl: 'http://127.0.0.1:3009' }),
    /cliHomeDir is required/i
  );
});
