import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStackCredentialPaths } from './utils/auth/credentials_paths.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';
import { authScriptPath, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack stack auth copy-from does not hit ReferenceError: runCapture is not defined', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-copy-from-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  // Stub yarn to keep this test fast/deterministic. This is an external boundary.
  const binDir = join(tmp, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, '#!/bin/bash\nexit 0\n', 'utf-8');
  await chmod(yarnPath, 0o755);

  const repoRoot = dirname(rootDir); // .../apps/stack -> .../ (monorepo root)

  const mkStackEnv = async (name) => {
    const baseDir = join(storageDir, name);
    const dataDir = join(baseDir, 'server-light');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(baseDir, 'env'),
      [
        `HAPPIER_STACK_STACK=${name}`,
        `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
        `HAPPIER_STACK_REPO_DIR=${repoRoot}`,
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(dataDir, 'files')}`,
        `HAPPIER_SERVER_LIGHT_DB_DIR=${join(dataDir, 'pglite')}`,
        '',
      ].join('\n'),
      'utf-8'
    );
  };

  await mkStackEnv('dev-auth');
  await mkStackEnv('dev');

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STACK: 'dev',
    HAPPIER_STACK_ENV_FILE: join(storageDir, 'dev', 'env'),
  };

  const res = await runNodeCapture([authScriptPath(rootDir), 'copy-from', 'dev-auth'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(
    !res.stdout.includes('runCapture is not defined') && !res.stderr.includes('runCapture is not defined'),
    `expected no ReferenceError about runCapture\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );
  assert.ok(
    !res.stdout.includes('spawn yarn ENOENT') && !res.stderr.includes('spawn yarn ENOENT'),
    `expected yarn to be resolvable in light migrations step\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );
});

test('hstack stack auth copy-from prefers source server-scoped credential over unrelated legacy key', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-copy-from-prefer-server-scoped-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const binDir = join(tmp, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, '#!/bin/bash\nexit 0\n', 'utf-8');
  await chmod(yarnPath, 0o755);

  const repoRoot = dirname(rootDir);
  const sourceStack = 'dev-auth';
  const targetStack = 'dev';
  const serverPort = 4201;
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const sourceCliHome = join(storageDir, sourceStack, 'cli');
  const targetCliHome = join(storageDir, targetStack, 'cli');

  const mkStackEnv = async (name, cliHomeDir) => {
    const baseDir = join(storageDir, name);
    const dataDir = join(baseDir, 'server-light');
    await mkdir(dataDir, { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(
      join(baseDir, 'env'),
      [
        `HAPPIER_STACK_STACK=${name}`,
        `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
        `HAPPIER_STACK_REPO_DIR=${repoRoot}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
        `HAPPIER_STACK_SERVER_PORT=${serverPort}`,
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(dataDir, 'files')}`,
        `HAPPIER_SERVER_LIGHT_DB_DIR=${join(dataDir, 'pglite')}`,
        '',
      ].join('\n'),
      'utf-8'
    );
  };

  await mkStackEnv(sourceStack, sourceCliHome);
  await mkStackEnv(targetStack, targetCliHome);

  const sourceCred = resolveStackCredentialPaths({ cliHomeDir: sourceCliHome, serverUrl });
  await mkdir(dirname(sourceCred.serverScopedPath), { recursive: true });
  await writeFile(join(sourceCliHome, 'access.key'), 'legacy-wrong\n', 'utf-8');
  await writeFile(sourceCred.serverScopedPath, 'server-scoped-correct\n', 'utf-8');

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STACK: targetStack,
    HAPPIER_STACK_ENV_FILE: join(storageDir, targetStack, 'env'),
  };

  const res = await runNodeCapture([authScriptPath(rootDir), 'copy-from', sourceStack], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const expectedTargetId = buildStackStableScopeId({ stackName: targetStack, cliIdentity: 'default' });
  const copied = (await readFile(join(targetCliHome, 'servers', expectedTargetId, 'access.key'), 'utf-8')).trim();
  assert.equal(copied, 'server-scoped-correct');
});

test('hstack stack auth copy-from prefers source stable-scope credential when source stack env has no pinned port (even if stable scope env is disabled)', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-copy-from-stable-scope-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const binDir = join(tmp, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, '#!/bin/bash\nexit 0\n', 'utf-8');
  await chmod(yarnPath, 0o755);

  const repoRoot = dirname(rootDir);
  const sourceStack = 'dev-auth';
  const targetStack = 'dev';
  const sourceCliHome = join(storageDir, sourceStack, 'cli');
  const targetCliHome = join(storageDir, targetStack, 'cli');

  const mkStackEnv = async (name, cliHomeDir) => {
    const baseDir = join(storageDir, name);
    const dataDir = join(baseDir, 'server-light');
    await mkdir(dataDir, { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(
      join(baseDir, 'env'),
      [
        `HAPPIER_STACK_STACK=${name}`,
        `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
        `HAPPIER_STACK_REPO_DIR=${repoRoot}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
        // IMPORTANT: no HAPPIER_STACK_SERVER_PORT here (ephemeral stack behavior)
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(dataDir, 'files')}`,
        `HAPPIER_SERVER_LIGHT_DB_DIR=${join(dataDir, 'pglite')}`,
        '',
      ].join('\n'),
      'utf-8'
    );
  };

  await mkStackEnv(sourceStack, sourceCliHome);
  await mkStackEnv(targetStack, targetCliHome);

  const stableId = buildStackStableScopeId({ stackName: sourceStack, cliIdentity: 'default' });
  const stableCredPath = join(sourceCliHome, 'servers', stableId, 'access.key');
  await mkdir(dirname(stableCredPath), { recursive: true });

  // Legacy key contains a JWT-like payload with a subject; this would normally trigger stale-check failure
  // (source DB is empty in this test). We expect copy-from to pick the stable-scope credential instead.
  const makeToken = (sub) => {
    const b64 = (v) =>
      Buffer.from(v, 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    return `${b64(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64(JSON.stringify({ sub }))}.sig`;
  };
  await writeFile(
    join(sourceCliHome, 'access.key'),
    JSON.stringify({ token: makeToken('stale-account-id') }) + '\n',
    'utf-8'
  );
  await writeFile(stableCredPath, 'server-scoped-stable\n', 'utf-8');

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    // Simulate leaked rollback env in caller shell; copy-from should still prefer source stack stable credential.
    HAPPIER_STACK_DISABLE_STABLE_SCOPE: '1',
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STACK: targetStack,
    HAPPIER_STACK_ENV_FILE: join(storageDir, targetStack, 'env'),
  };

  const res = await runNodeCapture([authScriptPath(rootDir), 'copy-from', sourceStack], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const expectedTargetId = buildStackStableScopeId({ stackName: targetStack, cliIdentity: 'default' });
  const copied = await readFile(join(targetCliHome, 'servers', expectedTargetId, 'access.key'), 'utf-8');
  assert.equal(copied.trim(), 'server-scoped-stable');

  // Ensure we did not fail due to stale legacy token subject.
  assert.ok(
    !`${res.stdout}\n${res.stderr}`.includes('source auth appears stale'),
    `expected stable-scope source to bypass legacy stale check\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );
});

test('hstack stack auth copy-from fails closed when source token subject is missing in source Account rows', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-copy-from-stale-source-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const binDir = join(tmp, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, '#!/bin/bash\nexit 0\n', 'utf-8');
  await chmod(yarnPath, 0o755);

  const repoRoot = dirname(rootDir);
  const sourceStack = 'dev-auth';
  const targetStack = 'dev';
  const sourceCliHome = join(storageDir, sourceStack, 'cli');
  const targetCliHome = join(storageDir, targetStack, 'cli');
  const makeToken = (sub) => {
    const b64 = (v) => Buffer.from(v, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `${b64(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64(JSON.stringify({ sub }))}.sig`;
  };

  const mkStackEnv = async (name, cliHomeDir) => {
    const baseDir = join(storageDir, name);
    const dataDir = join(baseDir, 'server-light');
    await mkdir(dataDir, { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(
      join(baseDir, 'env'),
      [
        `HAPPIER_STACK_STACK=${name}`,
        `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
        `HAPPIER_STACK_REPO_DIR=${repoRoot}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(dataDir, 'files')}`,
        `HAPPIER_SERVER_LIGHT_DB_DIR=${join(dataDir, 'pglite')}`,
        '',
      ].join('\n'),
      'utf-8'
    );
  };

  await mkStackEnv(sourceStack, sourceCliHome);
  await mkStackEnv(targetStack, targetCliHome);

  // Source token subject has no matching Account row in source DB (source DB starts empty).
  await writeFile(
    join(sourceCliHome, 'access.key'),
    JSON.stringify({
      token: makeToken('stale-account-id'),
      secret: Buffer.from('secret', 'utf-8').toString('base64'),
    }) + '\n',
    'utf-8'
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STACK: targetStack,
    HAPPIER_STACK_ENV_FILE: join(storageDir, targetStack, 'env'),
  };

  const res = await runNodeCapture([authScriptPath(rootDir), 'copy-from', sourceStack], { cwd: rootDir, env });
  assert.notEqual(res.code, 0, `expected non-zero exit for stale source auth\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(
    `${res.stdout}\n${res.stderr}`,
    /source auth appears stale|token subject .* is not present in source Account rows/i,
    `expected stale source auth guidance\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );
});

test('hstack stack auth copy-from accepts source auth when source server validates token', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-copy-from-server-validated-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const binDir = join(tmp, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, '#!/bin/bash\nexit 0\n', 'utf-8');
  await chmod(yarnPath, 0o755);

  const repoRoot = dirname(rootDir);
  const sourceStack = 'dev-auth';
  const targetStack = 'dev';
  const sourceCliHome = join(storageDir, sourceStack, 'cli');
  const targetCliHome = join(storageDir, targetStack, 'cli');
  const makeToken = (sub) => {
    const b64 = (v) => Buffer.from(v, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `${b64(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64(JSON.stringify({ sub }))}.sig`;
  };

  const mkStackEnv = async (name, cliHomeDir) => {
    const baseDir = join(storageDir, name);
    const dataDir = join(baseDir, 'server-light');
    await mkdir(dataDir, { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(
      join(baseDir, 'env'),
      [
        `HAPPIER_STACK_STACK=${name}`,
        `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
        `HAPPIER_STACK_REPO_DIR=${repoRoot}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(dataDir, 'files')}`,
        `HAPPIER_SERVER_LIGHT_DB_DIR=${join(dataDir, 'pglite')}`,
        '',
      ].join('\n'),
      'utf-8'
    );
  };

  await mkStackEnv(sourceStack, sourceCliHome);
  await mkStackEnv(targetStack, targetCliHome);

  const sourceToken = makeToken('subject-not-present-in-db');
  await writeFile(
    join(sourceCliHome, 'access.key'),
    JSON.stringify({ token: sourceToken, secret: Buffer.from('secret', 'utf-8').toString('base64') }) + '\n',
    'utf-8'
  );

  const sourceServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/account/profile') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'any-account' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => sourceServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => sourceServer.close(resolve));
  });
  const sourceAddress = sourceServer.address();
  const sourcePort =
    sourceAddress && typeof sourceAddress === 'object' && Number.isFinite(sourceAddress.port) ? Number(sourceAddress.port) : 0;
  assert.ok(sourcePort > 0, `expected source server port, got ${JSON.stringify(sourceAddress)}`);

  await writeFile(
    join(storageDir, sourceStack, 'stack.runtime.json'),
    JSON.stringify({ version: 1, stackName: sourceStack, ownerPid: process.pid, ports: { server: sourcePort } }) + '\n',
    'utf-8'
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STACK: targetStack,
    HAPPIER_STACK_ENV_FILE: join(storageDir, targetStack, 'env'),
  };

  const res = await runNodeCapture([authScriptPath(rootDir), 'copy-from', sourceStack], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(
    !`${res.stdout}\n${res.stderr}`.includes('source auth appears stale'),
    `expected live source server validation to bypass stale subject guard\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );

  const targetStableId = buildStackStableScopeId({ stackName: targetStack, cliIdentity: 'default' });
  const copied = await readFile(join(targetCliHome, 'servers', targetStableId, 'access.key'), 'utf-8');
  assert.ok(copied.includes(sourceToken), `expected copied credential to include source token\ncopied:\n${copied}`);
});
