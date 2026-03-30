import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { run, runCapture } from '../utils/proc/proc.mjs';
import { sanitizeDefinedEnv } from '../utils/test/test_env.mjs';
import { ensureMinimalMonorepoLayout } from './core/minimal_monorepo_layout.mjs';
import { buildGitIdentityEnv } from './core/env_scope.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';

export async function withTempRoot(t) {
  return (await createTempFixture(t, { prefix: 'happy-stacks-monorepo-port-' })).root;
}

export function gitEnv() {
  return buildGitIdentityEnv();
}

export async function initMonorepoStub({ dir, env, seed = {}, layout = 'packages' }) {
  await mkdir(dir, { recursive: true });
  await run('git', ['init', '-q'], { cwd: dir, env });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: dir, env });

  void layout;
  await ensureMinimalMonorepoLayout(dir);
  for (const [rel, content] of Object.entries(seed)) {
    // eslint-disable-next-line no-await-in-loop
    await mkdir(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await writeFile(join(dir, rel), content, 'utf-8');
  }
  await run('git', ['add', '.'], { cwd: dir, env });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: dir, env });
}

export async function initSplitRepoStub({ dir, env, name, seed = {} }) {
  await mkdir(dir, { recursive: true });
  await run('git', ['init', '-q'], { cwd: dir, env });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: dir, env });
  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  for (const [rel, content] of Object.entries(seed)) {
    // eslint-disable-next-line no-await-in-loop
    await mkdir(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await writeFile(join(dir, rel), content, 'utf-8');
  }
  await run('git', ['add', '.'], { cwd: dir, env });
  await run('git', ['commit', '-q', '-m', `chore: init ${name}`], { cwd: dir, env });
  return (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: dir, env })).trim();
}

function withTimeout(task, { timeoutMs, message }) {
  return Promise.race([
    task,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error(message));
      }, timeoutMs);
    }),
  ]);
}

export function spawnNodeWithCapture(command, args, { cwd, env, stdio = ['pipe', 'pipe', 'pipe'] } = {}) {
  const child = spawn(command, args, { cwd, env: sanitizeDefinedEnv(env), stdio });
  let stdout = '';
  let stderr = '';
  const outputWaiters = new Set();

  const notify = () => {
    for (const waiter of outputWaiters) waiter();
  };

  child.stdout?.on('data', (d) => {
    stdout += d.toString();
    notify();
  });
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
    notify();
  });

  const getOutput = () => ({ stdout, stderr, combined: `${stdout}\n${stderr}` });

  const waitForText = async (needle, timeoutMs = 10_000) => {
    if (getOutput().combined.includes(needle)) return;
    await withTimeout(
      new Promise((resolve) => {
        const check = () => {
          if (getOutput().combined.includes(needle)) {
            outputWaiters.delete(check);
            resolve();
          }
        };
        outputWaiters.add(check);
      }),
      {
        timeoutMs,
        message: `timeout waiting for text: ${needle}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      }
    );
  };

  const waitForExit = async (timeoutMs = 20_000) => {
    if (child.exitCode != null) {
      return { code: child.exitCode, signal: child.signalCode, ...getOutput() };
    }
    await withTimeout(
      new Promise((resolve) => {
        child.once('exit', resolve);
      }),
      {
        timeoutMs,
        message: `timeout waiting for process exit\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      }
    );
    return { code: child.exitCode, signal: child.signalCode, ...getOutput() };
  };

  const sendLine = (line = '') => {
    child.stdin?.write(String(line) + '\n');
  };

  const kill = (signal = 'SIGKILL') => {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  };

  return {
    child,
    waitForText,
    waitForExit,
    sendLine,
    kill,
    getOutput,
  };
}
