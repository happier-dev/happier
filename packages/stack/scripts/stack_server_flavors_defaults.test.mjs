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

test('happys stack new pins happy-server-light dir to happy-server when unified schema exists', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-server-flavors-'));

  const workspaceDir = join(tmp, 'workspace');
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');
  const stackName = 'exp-flavors';

  const fullDir = join(workspaceDir, 'components', 'happy-server');
  await mkdir(join(fullDir, 'prisma'), { recursive: true });
  await writeFile(join(fullDir, 'prisma', 'schema.sqlite.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');
  await writeFile(join(fullDir, 'package.json'), '{}\n', 'utf-8');

  const env = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_WORKSPACE_DIR: workspaceDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
    HAPPY_STACKS_SANDBOX_DIR: sandboxDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'new', stackName, '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const envPath = join(storageDir, stackName, 'env');
  const contents = await readFile(envPath, 'utf-8');
  assert.ok(contents.includes(`HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER=${fullDir}\n`), contents);
  assert.ok(contents.includes(`HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT=${fullDir}\n`), contents);

  await rm(tmp, { recursive: true, force: true });
});

