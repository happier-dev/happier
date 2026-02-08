import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStackCredentialPaths } from './utils/auth/credentials_paths.mjs';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr }));
  });
}

test('hstack stack new copies server-scoped credentials from source stack', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-copy-auth-server-scoped-'));

  const workspaceDir = join(tmp, 'workspace');
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');
  const sourceStack = 'seed-auth';
  const targetStack = 'exp-copy-auth';
  const serverPort = 4101;
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  const monoRoot = join(workspaceDir, 'tmp', 'leeroy-wip');
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server', 'prisma', 'sqlite'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'prisma', 'sqlite', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

  const sourceCliHome = join(storageDir, sourceStack, 'cli');
  const sourceCred = resolveStackCredentialPaths({ cliHomeDir: sourceCliHome, serverUrl });
  await mkdir(dirname(sourceCred.serverScopedPath), { recursive: true });
  await writeFile(sourceCred.serverScopedPath, 'seed-credential\n', 'utf-8');
  await writeFile(join(sourceCliHome, 'settings.json'), JSON.stringify({ machineId: 'seed-machine' }) + '\n', 'utf-8');
  await writeFile(
    join(storageDir, sourceStack, 'env'),
    [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${sourceCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=${serverPort}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_SANDBOX_DIR: sandboxDir,
  };

  const res = await runNode(
    [
      join(rootDir, 'scripts', 'stack.mjs'),
      'new',
      targetStack,
      `--repo=${monoRoot}`,
      '--server=happier-server-light',
      `--copy-auth-from=${sourceStack}`,
      `--port=${serverPort}`,
      '--force-port',
      '--json',
    ],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const targetCliHome = join(storageDir, targetStack, 'cli');
  const targetStableEnv = { HAPPIER_ACTIVE_SERVER_ID: `stack_${targetStack}__id_default` };
  const targetCred = resolveStackCredentialPaths({ cliHomeDir: targetCliHome, serverUrl, env: targetStableEnv });
  const targetCredRaw = await readFile(targetCred.serverScopedPath, 'utf-8');
  assert.equal(targetCredRaw.trim(), 'seed-credential');

  await rm(tmp, { recursive: true, force: true });
});

test('hstack stack new copy-auth prefers source server-scoped credentials over unrelated legacy access.key', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-copy-auth-prefer-server-scoped-'));

  const workspaceDir = join(tmp, 'workspace');
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');
  const sourceStack = 'seed-auth';
  const targetStack = 'exp-copy-auth';
  const serverPort = 4101;
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  const monoRoot = join(workspaceDir, 'tmp', 'leeroy-wip');
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server', 'prisma', 'sqlite'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'prisma', 'sqlite', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

  const sourceCliHome = join(storageDir, sourceStack, 'cli');
  const sourceCred = resolveStackCredentialPaths({ cliHomeDir: sourceCliHome, serverUrl });
  await mkdir(dirname(sourceCred.serverScopedPath), { recursive: true });
  await writeFile(join(sourceCliHome, 'access.key'), 'legacy-wrong\n', 'utf-8');
  await writeFile(sourceCred.serverScopedPath, 'server-scoped-correct\n', 'utf-8');
  await writeFile(join(sourceCliHome, 'settings.json'), JSON.stringify({ machineId: 'seed-machine' }) + '\n', 'utf-8');
  await writeFile(
    join(storageDir, sourceStack, 'env'),
    [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${sourceCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=${serverPort}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_SANDBOX_DIR: sandboxDir,
  };

  const res = await runNode(
    [
      join(rootDir, 'scripts', 'stack.mjs'),
      'new',
      targetStack,
      `--repo=${monoRoot}`,
      '--server=happier-server-light',
      `--copy-auth-from=${sourceStack}`,
      `--port=${serverPort}`,
      '--force-port',
      '--json',
    ],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const targetCliHome = join(storageDir, targetStack, 'cli');
  const targetStableEnv = { HAPPIER_ACTIVE_SERVER_ID: `stack_${targetStack}__id_default` };
  const targetCred = resolveStackCredentialPaths({ cliHomeDir: targetCliHome, serverUrl, env: targetStableEnv });
  const targetCredRaw = await readFile(targetCred.serverScopedPath, 'utf-8');
  assert.equal(targetCredRaw.trim(), 'server-scoped-correct');

  await rm(tmp, { recursive: true, force: true });
});

test('hstack stack new copy-auth copies stable-scope credentials from source stack', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-copy-auth-stable-scope-'));

  const workspaceDir = join(tmp, 'workspace');
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');
  const sourceStack = 'seed-auth';
  const targetStack = 'exp-copy-auth';
  const serverPort = 4101;
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  const monoRoot = join(workspaceDir, 'tmp', 'leeroy-wip');
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server', 'prisma', 'sqlite'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'prisma', 'schema.prisma'), 'datasource db { provider = \"postgresql\" }\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'prisma', 'sqlite', 'schema.prisma'), 'datasource db { provider = \"sqlite\" }\n', 'utf-8');

  const sourceCliHome = join(storageDir, sourceStack, 'cli');
  const sourceStableEnv = { HAPPIER_ACTIVE_SERVER_ID: `stack_${sourceStack}__id_default` };
  const sourceCredStable = resolveStackCredentialPaths({ cliHomeDir: sourceCliHome, serverUrl, env: sourceStableEnv });
  await mkdir(dirname(sourceCredStable.serverScopedPath), { recursive: true });
  await writeFile(join(sourceCliHome, 'access.key'), 'legacy-wrong\n', 'utf-8');
  await writeFile(sourceCredStable.serverScopedPath, 'stable-correct\n', 'utf-8');
  await writeFile(join(sourceCliHome, 'settings.json'), JSON.stringify({ machineId: 'seed-machine' }) + '\n', 'utf-8');
  await writeFile(
    join(storageDir, sourceStack, 'env'),
    [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${sourceCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=${serverPort}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_SANDBOX_DIR: sandboxDir,
  };

  const res = await runNode(
    [
      join(rootDir, 'scripts', 'stack.mjs'),
      'new',
      targetStack,
      `--repo=${monoRoot}`,
      '--server=happier-server-light',
      `--copy-auth-from=${sourceStack}`,
      `--port=${serverPort}`,
      '--force-port',
      '--json',
    ],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const targetCliHome = join(storageDir, targetStack, 'cli');
  const targetStableEnv = { HAPPIER_ACTIVE_SERVER_ID: `stack_${targetStack}__id_default` };
  const targetCredStable = resolveStackCredentialPaths({ cliHomeDir: targetCliHome, serverUrl, env: targetStableEnv });
  const targetCredRaw = await readFile(targetCredStable.serverScopedPath, 'utf-8');
  assert.equal(targetCredRaw.trim(), 'stable-correct');

  await rm(tmp, { recursive: true, force: true });
});
