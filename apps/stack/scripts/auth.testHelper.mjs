import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function sanitizeEnv(env) {
  if (!env) return undefined;
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue;
    clean[key] = String(value);
  }
  return clean;
}

export function getStackRootFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

export function hstackBinPath(rootDir) {
  return join(rootDir, 'bin', 'hstack.mjs');
}

export function authScriptPath(rootDir) {
  return join(rootDir, 'scripts', 'auth.mjs');
}

export async function runNodeCapture(args, { cwd, env, input } = {}) {
  return await new Promise((resolve, reject) => {
    const usePipeInput = input != null;
    const proc = spawn(process.execPath, args, {
      cwd,
      env: sanitizeEnv(env),
      stdio: [usePipeInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      resolve({ code: code ?? (signal ? 128 : 0), signal, stdout, stderr });
    });

    if (usePipeInput) {
      proc.stdin.write(String(input));
      proc.stdin.end();
    }
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export async function terminateChildProcess(child, { signal = 'SIGTERM', timeoutMs = 800 } = {}) {
  if (!child) return true;
  if (child.exitCode != null) return true;
  const waitForExit = new Promise((resolve) => {
    child.once('exit', () => resolve());
  });

  try {
    child.kill(signal);
  } catch {}
  await Promise.race([waitForExit, wait(timeoutMs)]);
  if (child.exitCode == null) {
    try {
      child.kill('SIGKILL');
    } catch {}
    await Promise.race([waitForExit, wait(timeoutMs)]);
  }
  return !isPidAlive(child.pid);
}

export async function createAuthStackFixture({
  prefix,
  stackName = 'main',
  stackEnvLines = [],
}) {
  const tmpDir = await mkdtemp(join(tmpdir(), prefix));
  const storageDir = join(tmpDir, 'storage');
  await mkdir(join(storageDir, stackName), { recursive: true });
  const envPath = join(storageDir, stackName, 'env');
  await writeFile(envPath, [...stackEnvLines, ''].join('\n'), 'utf-8');

  return {
    tmpDir,
    storageDir,
    envPath,
    buildEnv(extra = {}) {
      return {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        ...extra,
      };
    },
    async cleanup() {
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}
