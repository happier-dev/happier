import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

test('happys <stack> <cmd> ... rewrites to happys stack <cmd> <stack> ... when stack exists', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-shorthand-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp-test';

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(envPath, 'FOO=bar\n', 'utf-8');

  const baseEnv = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
    HAPPY_STACKS_CLI_ROOT_DISABLE: '1',
  };

  const res = await runNode([join(rootDir, 'bin', 'happys.mjs'), stackName, 'env', 'path', '--json'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout || '{}');
  assert.equal(out.ok, true);
  assert.ok(
    typeof out.envPath === 'string' && out.envPath.endsWith(`/${stackName}/env`),
    `expected envPath to end with /${stackName}/env, got: ${out.envPath}`
  );
});

