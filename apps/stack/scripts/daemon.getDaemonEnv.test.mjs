import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDaemonEnv } from './daemon.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { applyCliRuntimeLaunchProvenanceEnv, resolveCliRuntimeLaunchSpec } from './runtime/launch/resolveCliRuntimeLaunchSpec.mjs';

test('getDaemonEnv exposes the selected source-runtime CLI to a child shell and follows a source reload', async t => {
  const fixture = await createTempFixture(t, { prefix: "hstack-source 'cli' & 100%-" });
  const cliHomeDir = fixture.path('stack', 'cli');
  const pathName = process.platform === 'win32' ? 'Path' : 'PATH';
  const baseEnv = { [pathName]: fixture.path('empty-bin'), ...(process.platform === 'win32'
    ? { SystemRoot: process.env.SystemRoot, PathExt: '.EXE;.CMD' } : {}) };
  let previousEnv;
  for (const generation of ['first', 'second']) {
    const entrypoint = fixture.path(`${generation}.mjs`);
    await writeFile(entrypoint, 'process.stdout.write(JSON.stringify({ entry: import.meta.url, args: process.argv.slice(2) })); process.exitCode = process.argv.includes("fail") ? 23 : 0;\n');
    const cliLaunchSpec = await resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: { cliDir: fixture.root, entrypoint } });
    const env = await getDaemonEnv({
      baseEnv: applyCliRuntimeLaunchProvenanceEnv({ env: previousEnv ?? baseEnv, cliLaunchSpec }),
      cliHomeDir, stackName: 'source-path', cliIdentity: 'default', cliLaunchSpec,
    });
    const child = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'happier project script run "script with spaces"'], { env, encoding: 'utf8' })
      : spawnSync('/bin/sh', ['-c', 'happier project script run "script with spaces"'], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { entry: pathToFileURL(entrypoint).href,
      args: ['project', 'script', 'run', 'script with spaces'] });
    assert.deepEqual(env[pathName].split(delimiter), [join(cliHomeDir, 'source-runtime', 'bin'), baseEnv[pathName]]);
    assert.equal(baseEnv[pathName], fixture.path('empty-bin'), 'the parent environment is not mutated');
    const failed = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'happier fail'], { env, encoding: 'utf8' })
      : spawnSync('/bin/sh', ['-c', 'happier fail'], { env, encoding: 'utf8' });
    assert.equal(failed.status, 23, 'the source command preserves CLI failure status');
    previousEnv = env;
  }
});

test('getDaemonEnv leaves installed launch PATH and command publication unchanged', async t => {
  const fixture = await createTempFixture(t);
  const env = await getDaemonEnv({ baseEnv: { PATH: '/installed/bin' }, cliHomeDir: fixture.path('cli'),
    cliLaunchSpec: { sourceSnapshot: false } });
  assert.equal(env.PATH, '/installed/bin');
  await assert.rejects(access(fixture.path('cli', 'source-runtime', 'bin')), { code: 'ENOENT' });
});

test('getDaemonEnv publishes a Windows source command and preserves case-insensitive PATH/PATHEXT identity', async t => {
  const fixture = await createTempFixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try {
    const cliHomeDir = fixture.path('cli');
    const cliLaunchSpec = { sourceSnapshot: true, command: 'C:\\Program Files\\Runtime\\node.exe',
      args: ['C:\\Source & 100%\\entry.mjs'] };
    const baseEnv = { Path: 'C:\\Tools', PATH: 'C:\\Shadowed', PathExt: '.EXE;.BAT' };
    const env = await getDaemonEnv({ baseEnv, cliHomeDir, cliLaunchSpec });
    assert.equal(env.Path, `${join(cliHomeDir, 'source-runtime', 'bin')};C:\\Tools`);
    assert.equal(env.PATH, undefined);
    assert.equal(env.PathExt, '.EXE;.BAT;.CMD');
    assert.equal(env.PATHEXT, undefined);
    const script = await readFile(join(cliHomeDir, 'source-runtime', 'bin', 'happier.cmd'), 'utf8');
    assert.ok(script.includes('"C:\\Program Files\\Runtime\\node.exe" "C:\\Source & 100%%\\entry.mjs" %*'));
    assert.ok(script.includes('setlocal DisableDelayedExpansion'));
    const repeated = await getDaemonEnv({ baseEnv: env, cliHomeDir, cliLaunchSpec });
    assert.equal(repeated.Path, env.Path);
    assert.equal(repeated.PathExt, env.PathExt);
    assert.equal(baseEnv.PathExt, '.EXE;.BAT');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('getDaemonEnv keeps machine identity and lifecycle state on the stable stack scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const canonicalServerId = 'stack-qa-server';

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

  const stableScopeId = buildStackStableScopeId({ stackName: 'main', cliIdentity: 'default' });
  assert.notEqual(stableScopeId, canonicalServerId);

  const env = await getDaemonEnv({
    baseEnv: {},
    cliHomeDir: dir,
    internalServerUrl: serverUrl,
    publicServerUrl: serverUrl,
    stackName: 'main',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, stableScopeId);
  assert.equal(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID, stableScopeId);
  assert.equal(env.HAPPIER_DAEMON_STARTUP_SOURCE, 'manual');
});

test('getDaemonEnv seeds stack ownership env from the resolved stack name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-stack-'));

  const env = await getDaemonEnv({
    baseEnv: {
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
    cliHomeDir: dir,
    internalServerUrl: 'http://127.0.0.1:3009',
    publicServerUrl: 'http://127.0.0.1:3009',
    stackName: 'dev',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_STACK_STACK, 'dev');
  assert.equal(env.HAPPIER_STACK_PROCESS_KIND, 'daemon');
});

test('getDaemonEnv preserves explicit active server id when its saved profile matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-explicit-server-'));
  const serverUrl = 'http://127.0.0.1:3009';

  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: 'manual-profile',
        servers: {
          'manual-profile': {
            id: 'manual-profile',
            name: 'manual-profile',
            serverUrl,
            webappUrl: 'http://localhost:3009',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
          'stack_main__id_default': {
            id: 'stack_main__id_default',
            name: 'stack_main__id_default',
            serverUrl,
            webappUrl: 'http://localhost:3009',
            createdAt: 2,
            updatedAt: 2,
            lastUsedAt: 2,
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  const env = await getDaemonEnv({
    baseEnv: {},
    cliHomeDir: dir,
    internalServerUrl: serverUrl,
    publicServerUrl: serverUrl,
    stackName: 'main',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, 'stack_main__id_default');
});

test('getDaemonEnv marks service-mode starts as background-service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-service-'));

  const env = await getDaemonEnv({
    baseEnv: {
      HAPPIER_STACK_SERVICE_MODE: '1',
    },
    cliHomeDir: dir,
    internalServerUrl: 'http://127.0.0.1:3009',
    publicServerUrl: 'http://127.0.0.1:3009',
    stackName: 'main',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_DAEMON_STARTUP_SOURCE, 'background-service');
  assert.equal(env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS, '120000');
});

test('getDaemonEnv aligns self-restart confirmation with configured stack readiness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-readiness-'));
  const options = {
    cliHomeDir: dir,
    internalServerUrl: 'http://127.0.0.1:3009',
    publicServerUrl: 'http://127.0.0.1:3009',
    stackName: 'dev',
  };
  const inherited = await getDaemonEnv({
    ...options,
    baseEnv: { HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '90000' },
  });
  assert.equal(inherited.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS, '90000');

  const explicit = await getDaemonEnv({
    ...options,
    baseEnv: {
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '90000',
      HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS: '45000',
    },
  });
  assert.equal(explicit.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS, '45000');
});

test('getDaemonEnv preserves an explicit startup source over service mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-explicit-'));

  const env = await getDaemonEnv({
    baseEnv: {
      HAPPIER_STACK_SERVICE_MODE: '1',
      HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
    },
    cliHomeDir: dir,
    internalServerUrl: 'http://127.0.0.1:3009',
    publicServerUrl: 'http://127.0.0.1:3009',
    stackName: 'main',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_DAEMON_STARTUP_SOURCE, 'self-restart');
});

test('getDaemonEnv preserves an explicit daemon service label', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-service-label-'));

  const env = await getDaemonEnv({
    baseEnv: {
      HAPPIER_DAEMON_SERVICE_LABEL: 'happier-daemon.preview.example.service',
    },
    cliHomeDir: dir,
    internalServerUrl: 'http://127.0.0.1:3009',
    publicServerUrl: 'http://127.0.0.1:3009',
    stackName: 'main',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_DAEMON_SERVICE_LABEL, 'happier-daemon.preview.example.service');
});

test('getDaemonEnv keeps the stack webapp origin aligned with the server process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-webapp-'));

  const env = await getDaemonEnv({
    baseEnv: { HAPPIER_WEBAPP_URL: 'http://happier-qa.localhost:19364' },
    cliHomeDir: dir,
    internalServerUrl: 'http://127.0.0.1:3009',
    publicServerUrl: 'http://happier-qa.localhost:3009',
    stackName: 'qa',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_WEBAPP_URL, 'http://happier-qa.localhost:19364');
});
