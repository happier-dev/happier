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

test('hstack stack new defaults to happy-server-light with a single monorepo repo dir', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-server-flavors-'));

  const workspaceDir = join(tmp, 'workspace');
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');
  const stackName = 'exp-flavors';

  const monoRoot = join(workspaceDir, 'main');
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server', 'prisma', 'sqlite'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'prisma', 'sqlite', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

  const env = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_SANDBOX_DIR: sandboxDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'new', stackName, '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const envPath = join(storageDir, stackName, 'env');
  const contents = await readFile(envPath, 'utf-8');
  assert.ok(contents.includes(`HAPPIER_STACK_REPO_DIR=${monoRoot}\n`), contents);
  assert.ok(contents.includes('HAPPIER_STACK_SERVER_COMPONENT=happy-server-light\n'), contents);
  assert.ok(!contents.includes('HAPPIER_STACK_COMPONENT_DIR_'), contents);

  await rm(tmp, { recursive: true, force: true });
});
