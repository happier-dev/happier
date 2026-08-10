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
  findAnyDaemonStatePairInCliHome,
} from './credentials_paths.mjs';

function neutralStackEnv(overrides = {}) {
  const {
    HAPPIER_ACTIVE_SERVER_ID,
    HAPPY_ACTIVE_SERVER_ID,
    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID,
    ...baseEnv
  } = process.env;
  return { ...baseEnv, ...overrides };
}

test('resolveStackCredentialPaths returns legacy + server-scoped paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const out = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl, env: neutralStackEnv() });
  assert.equal(out.legacyPath, join(dir, 'access.key'));
  assert.ok(out.serverScopedPath.startsWith(join(dir, 'servers', 'env_')));
  assert.ok(out.serverScopedPath.endsWith('/access.key'));
  assert.equal(out.hostPortServerId, 'localhost-3009');
  assert.ok(out.hostPortServerScopedPath.endsWith('/servers/localhost-3009/access.key'));
  assert.deepEqual(out.paths, [out.serverScopedPath, out.hostPortServerScopedPath, out.legacyPath]);
});

test('resolveStackCredentialPaths hashes equivalent loopback server URLs to the same scoped id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const env = neutralStackEnv();
  const loopback = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl: 'http://127.0.0.1:3009/', env });
  const localhost = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl: 'http://localhost:3009', env });
  const localhostDefaultPort = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl: 'http://localhost:80/', env });
  const loopbackDefaultPort = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl: 'http://127.0.0.1', env });

  assert.equal(loopback.urlHashServerId, localhost.urlHashServerId);
  assert.equal(localhostDefaultPort.urlHashServerId, loopbackDefaultPort.urlHashServerId);
});

test('resolveStackCredentialPaths uses a neutral default server id when serverUrl is empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const out = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl: '', env: neutralStackEnv() });
  assert.equal(out.urlHashServerId, 'default');
  assert.equal(out.activeServerId, 'default');
  assert.ok(out.serverScopedPath.endsWith('/servers/default/access.key'));
});

test('findExistingStackCredentialPath prefers server-scoped credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const env = neutralStackEnv();
  const out = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl, env });

  await mkdir(join(dir, 'servers', out.activeServerId), { recursive: true });
  await writeFile(out.legacyPath, 'legacy\n', 'utf-8');
  await writeFile(out.serverScopedPath, 'server\n', 'utf-8');

  const found = findExistingStackCredentialPath({ cliHomeDir: dir, serverUrl, env });
  assert.equal(found, out.serverScopedPath);
});

test('findExistingStackCredentialPath falls back to legacy access.key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const env = neutralStackEnv();
  const out = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl, env });
  await writeFile(out.legacyPath, 'legacy\n', 'utf-8');

  const found = findExistingStackCredentialPath({ cliHomeDir: dir, serverUrl, env });
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

test('resolveStackCredentialPaths keeps the stable runtime scope and treats a matching settings profile as a credential source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-settings-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const canonicalServerId = 'stack-dev-profile';
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: canonicalServerId,
        servers: {
          [canonicalServerId]: {
            id: canonicalServerId,
            name: canonicalServerId,
            serverUrl,
            webappUrl: 'http://localhost:3009',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  const out = resolveStackCredentialPaths({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_dev__id_default' },
  });

  assert.equal(out.activeServerId, 'stack_dev__id_default');
  assert.equal(out.settingsServerId, canonicalServerId);
  assert.equal(out.serverScopedPath, join(dir, 'servers', 'stack_dev__id_default', 'access.key'));
  assert.ok(out.paths.includes(join(dir, 'servers', canonicalServerId, 'access.key')));
});

test('findExistingStackCredentialPath accepts the stable scope alias when settings select another matching profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-stable-alias-'));
  const serverUrl = 'http://127.0.0.1:52753';
  const settingsServerId = 'android-keyboard-qa';
  const stableServerId = 'stack_repo-remote-dev__id_default';
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({
      schemaVersion: 6,
      activeServerId: settingsServerId,
      servers: {
        [settingsServerId]: {
          id: settingsServerId,
          name: settingsServerId,
          serverUrl,
          localServerUrl: serverUrl,
          webappUrl: 'http://localhost:52753',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      },
    }),
    'utf-8',
  );
  const env = { HAPPIER_ACTIVE_SERVER_ID: stableServerId };
  const out = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl, env });
  const stableCredentialPath = join(dir, 'servers', stableServerId, 'access.key');
  await mkdir(join(dir, 'servers', stableServerId), { recursive: true });
  await writeFile(stableCredentialPath, 'stable-stack-credential\n', 'utf-8');

  assert.equal(out.serverScopedPath, stableCredentialPath);
  assert.ok(out.aliasServerScopedPaths.includes(join(dir, 'servers', settingsServerId, 'access.key')));
  assert.equal(
    findExistingStackCredentialPath({ cliHomeDir: dir, serverUrl, env }),
    stableCredentialPath,
  );
});

test('resolveStackCredentialPaths prefers a matching explicit active server id when settings profiles share the URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cred-paths-settings-explicit-'));
  const serverUrl = 'http://127.0.0.1:52753';
  const defaultServerId = 'stack_repo-remote-dev-d72117acdb__id_default';
  const explicitServerId = 'android-keyboard-qa';
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: defaultServerId,
        servers: {
          [defaultServerId]: {
            id: defaultServerId,
            name: 'Default',
            serverUrl,
            localServerUrl: serverUrl,
            webappUrl: 'http://localhost:52753',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
          [explicitServerId]: {
            id: explicitServerId,
            name: 'Android keyboard QA',
            serverUrl: 'http://10.0.2.2:52753',
            localServerUrl: serverUrl,
            webappUrl: 'http://10.0.2.2:52753',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  const out = resolveStackCredentialPaths({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: explicitServerId },
  });

  assert.equal(out.activeServerId, explicitServerId);
  assert.equal(out.settingsServerId, explicitServerId);
  assert.equal(out.serverScopedPath, join(dir, 'servers', explicitServerId, 'access.key'));
  assert.ok(out.paths.includes(join(dir, 'servers', defaultServerId, 'access.key')) === false);
});

test('resolveStackDaemonStatePaths ignores matching cli settings profiles and keeps the stable lifecycle scope canonical', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-paths-settings-'));
  const serverUrl = 'http://127.0.0.1:3012';
  const settingsServerId = 'stack-dev-profile';
  const lifecycleScopeId = 'stack_dev__id_default';
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: settingsServerId,
        servers: {
          [settingsServerId]: {
            id: settingsServerId,
            name: settingsServerId,
            serverUrl,
            webappUrl: 'http://localhost:3012',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  const out = resolveStackDaemonStatePaths({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: lifecycleScopeId },
  });

  assert.equal(out.activeServerId, lifecycleScopeId);
  assert.equal(out.serverScopedStatePath, join(dir, 'servers', lifecycleScopeId, 'daemon.state.json'));
  assert.equal(
    out.pairs.some((pair) => pair.statePath === join(dir, 'servers', settingsServerId, 'daemon.state.json')),
    false,
  );
});

test('resolveStackDaemonStatePaths uses the daemon lifecycle scope without changing credential profile selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-lifecycle-scope-'));
  const serverUrl = 'http://127.0.0.1:3012';
  const settingsServerId = 'android-keyboard-qa';
  const lifecycleScopeId = 'stack_repo-remote-dev-d72117acdb__id_default';
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({
      schemaVersion: 6,
      activeServerId: settingsServerId,
      servers: {
        [settingsServerId]: {
          id: settingsServerId,
          name: 'Android keyboard QA',
          serverUrl,
          webappUrl: 'http://localhost:3012',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      },
    }) + '\n',
    'utf-8',
  );
  const env = {
    HAPPIER_ACTIVE_SERVER_ID: settingsServerId,
    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: lifecycleScopeId,
  };

  const credentialPaths = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl, env });
  const daemonPaths = resolveStackDaemonStatePaths({ cliHomeDir: dir, serverUrl, env });

  assert.equal(credentialPaths.activeServerId, settingsServerId);
  assert.equal(credentialPaths.serverScopedPath, join(dir, 'servers', settingsServerId, 'access.key'));
  assert.ok(
    credentialPaths.aliasServerScopedPaths.includes(
      join(dir, 'servers', lifecycleScopeId, 'access.key'),
    ),
  );
  assert.equal(daemonPaths.activeServerId, lifecycleScopeId);
  assert.equal(daemonPaths.serverScopedStatePath, join(dir, 'servers', lifecycleScopeId, 'daemon.state.json'));
  assert.equal(daemonPaths.serverScopedLockPath, join(dir, 'servers', lifecycleScopeId, 'daemon.state.json.lock'));
});

test('resolveStackDaemonStatePaths rejects an unsafe daemon lifecycle scope instead of selecting a default directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-lifecycle-unsafe-'));
  const out = resolveStackDaemonStatePaths({
    cliHomeDir: dir,
    serverUrl: 'http://127.0.0.1:3014',
    env: {
      HAPPIER_ACTIVE_SERVER_ID: 'safe-profile',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: '../../escape',
    },
  });

  assert.equal(out.daemonLifecycleScopeId, '');
  assert.equal(out.activeServerId, 'safe-profile');
  assert.equal(out.serverScopedStatePath, join(dir, 'servers', 'safe-profile', 'daemon.state.json'));
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
  const out = resolveStackDaemonStatePaths({ cliHomeDir: dir, serverUrl, env: neutralStackEnv() });

  assert.equal(out.legacyStatePath, join(dir, 'daemon.state.json'));
  assert.equal(out.legacyLockPath, join(dir, 'daemon.state.json.lock'));
  assert.ok(out.serverScopedStatePath.startsWith(join(dir, 'servers', 'env_')));
  assert.ok(out.serverScopedStatePath.endsWith('/daemon.state.json'));
  assert.ok(out.serverScopedLockPath.endsWith('/daemon.state.json.lock'));
  assert.ok(out.hostPortServerScopedStatePath.endsWith('/servers/localhost-3009/daemon.state.json'));
  assert.ok(out.hostPortServerScopedLockPath.endsWith('/servers/localhost-3009/daemon.state.json.lock'));
});

test('resolvePreferredStackDaemonStatePaths prefers server-scoped paths when present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-paths-'));
  const serverUrl = 'http://127.0.0.1:3010';
  const env = neutralStackEnv();
  const out = resolveStackDaemonStatePaths({ cliHomeDir: dir, serverUrl, env });

  await mkdir(join(dir, 'servers', out.activeServerId), { recursive: true });
  await writeFile(out.serverScopedLockPath, `${process.pid}\n`, 'utf-8');

  const preferred = resolvePreferredStackDaemonStatePaths({ cliHomeDir: dir, serverUrl, env });
  assert.equal(preferred.statePath, out.serverScopedStatePath);
  assert.equal(preferred.lockPath, out.serverScopedLockPath);
});

test('resolvePreferredStackDaemonStatePaths falls back to legacy paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-paths-'));
  const serverUrl = 'http://127.0.0.1:3011';
  const env = neutralStackEnv();
  const out = resolveStackDaemonStatePaths({ cliHomeDir: dir, serverUrl, env });

  await writeFile(out.legacyLockPath, `${process.pid}\n`, 'utf-8');

  const preferred = resolvePreferredStackDaemonStatePaths({ cliHomeDir: dir, serverUrl, env });
  assert.equal(preferred.statePath, out.legacyStatePath);
  assert.equal(preferred.lockPath, out.legacyLockPath);
});

test('findAnyDaemonStatePairInCliHome prefers the newest server-scoped daemon state over legacy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-any-'));
  const legacyStatePath = join(dir, 'daemon.state.json');
  const newerServerDir = join(dir, 'servers', 'stack_dev-built__id_default');
  const olderServerDir = join(dir, 'servers', 'stack_main__id_default');
  await mkdir(newerServerDir, { recursive: true });
  await mkdir(olderServerDir, { recursive: true });

  await writeFile(legacyStatePath, '{"pid":1}\n', 'utf-8');
  await writeFile(join(olderServerDir, 'daemon.state.json'), '{"pid":2}\n', 'utf-8');
  await new Promise((resolve) => setTimeout(resolve, 15));
  await writeFile(join(newerServerDir, 'daemon.state.json'), '{"pid":3}\n', 'utf-8');

  const found = findAnyDaemonStatePairInCliHome({ cliHomeDir: dir });
  assert.deepEqual(found, {
    statePath: join(newerServerDir, 'daemon.state.json'),
    lockPath: join(newerServerDir, 'daemon.state.json.lock'),
  });
});

test('resolvePreferredStackDaemonStatePaths falls back to any existing server-scoped daemon state before legacy when no server context is requested', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-any-preferred-'));
  const legacyStatePath = join(dir, 'daemon.state.json');
  const serverDir = join(dir, 'servers', 'stack_dev-built__id_default');
  await mkdir(serverDir, { recursive: true });

  await writeFile(legacyStatePath, '{"pid":1}\n', 'utf-8');
  await new Promise((resolve) => setTimeout(resolve, 15));
  await writeFile(join(serverDir, 'daemon.state.json'), '{"pid":3}\n', 'utf-8');

  const preferred = resolvePreferredStackDaemonStatePaths({ cliHomeDir: dir, serverUrl: '', env: neutralStackEnv() });
  assert.equal(preferred.statePath, join(serverDir, 'daemon.state.json'));
  assert.equal(preferred.lockPath, join(serverDir, 'daemon.state.json.lock'));
});

test('resolvePreferredStackDaemonStatePaths does not fall back to another server-scoped daemon state for a requested server context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-isolated-preferred-'));
  const serverUrl = 'http://127.0.0.1:4311';
  const paths = resolveStackDaemonStatePaths({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_dev2__id_default' },
  });
  const otherServerDir = join(dir, 'servers', 'stack_dev__id_default');
  await mkdir(otherServerDir, { recursive: true });
  await writeFile(join(otherServerDir, 'daemon.state.json'), '{"pid":3}\n', 'utf-8');

  const preferred = resolvePreferredStackDaemonStatePaths({
    cliHomeDir: dir,
    serverUrl,
    env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_dev2__id_default' },
  });

  assert.equal(preferred.statePath, paths.serverScopedStatePath);
  assert.equal(preferred.lockPath, paths.serverScopedLockPath);
});

test('resolvePreferredStackDaemonStatePaths does not scan other server scopes when lifecycle scope is explicit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-explicit-lifecycle-isolated-'));
  const lifecycleScopeId = 'stack_current__id_account-b';
  const paths = resolveStackDaemonStatePaths({
    cliHomeDir: dir,
    serverUrl: '',
    env: { HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: lifecycleScopeId },
  });
  const otherServerDir = join(dir, 'servers', 'stack_other__id_account-a');
  await mkdir(otherServerDir, { recursive: true });
  await writeFile(join(otherServerDir, 'daemon.state.json'), '{"pid":3}\n', 'utf-8');

  const preferred = resolvePreferredStackDaemonStatePaths({
    cliHomeDir: dir,
    serverUrl: '',
    env: { HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: lifecycleScopeId },
  });

  assert.equal(preferred.statePath, paths.serverScopedStatePath);
  assert.equal(preferred.lockPath, paths.serverScopedLockPath);
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
