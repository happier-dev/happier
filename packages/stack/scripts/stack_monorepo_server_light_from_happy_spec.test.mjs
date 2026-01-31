import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

test('hapsta stack new derives monorepo server-light dirs from --happy spec', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-monorepo-spec-'));

  const workspaceDir = join(tmp, 'workspace');
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');
  const stackName = 'exp-mono-spec';

  // Create a monorepo worktree somewhere other than components/happy to simulate a new stack
  // created from a --happy spec when the default checkout isn't a monorepo.
  const monoRoot = join(workspaceDir, 'components', '.worktrees', 'happy', 'slopus', 'tmp', 'leeroy-wip');
  await mkdir(join(monoRoot, 'packages', 'app'), { recursive: true });
  await mkdir(join(monoRoot, 'packages', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'packages', 'server', 'prisma', 'sqlite'), { recursive: true });
  await writeFile(join(monoRoot, 'packages', 'app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'packages', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'packages', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(
    join(monoRoot, 'packages', 'server', 'prisma', 'schema.prisma'),
    'datasource db { provider = "postgresql" }\n',
    'utf-8'
  );
  await writeFile(
    join(monoRoot, 'packages', 'server', 'prisma', 'sqlite', 'schema.prisma'),
    'datasource db { provider = "sqlite" }\n',
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
    [join(rootDir, 'scripts', 'stack.mjs'), 'new', stackName, `--happy=${monoRoot}`, '--server=happy-server-light', '--no-copy-auth', '--json'],
    { cwd: rootDir, env },
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const envPath = join(storageDir, stackName, 'env');
  const contents = await readFile(envPath, 'utf-8');
  assert.ok(contents.includes(`HAPPIER_STACK_COMPONENT_DIR_HAPPY=${join(monoRoot, 'packages', 'app')}\n`), contents);
  assert.ok(contents.includes(`HAPPIER_STACK_COMPONENT_DIR_HAPPY_CLI=${join(monoRoot, 'packages', 'cli')}\n`), contents);
  assert.ok(contents.includes(`HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER=${join(monoRoot, 'packages', 'server')}\n`), contents);
  assert.ok(contents.includes(`HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER_LIGHT=${join(monoRoot, 'packages', 'server')}\n`), contents);

  await rm(tmp, { recursive: true, force: true });
});
