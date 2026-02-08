import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveRunnerLogPathFromRuntime,
  startDaemonPostAuth,
} from './utils/auth/orchestrated_stack_auth_flow.mjs';

function restoreEnvVar(key, prev) {
  if (typeof prev === 'undefined') {
    delete process.env[key];
  } else {
    process.env[key] = prev;
  }
}

test('resolveRunnerLogPathFromRuntime returns runtime logs.runner path', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-flow-'));
  try {
    const storageDir = join(tmp, 'storage');
    const stackName = 's1';
    const baseDir = join(storageDir, stackName);
    await mkdir(baseDir, { recursive: true });

    const runnerLogPath = join(tmp, 'runner.log');
    await writeFile(runnerLogPath, 'hello\n', 'utf-8');

    await writeFile(
      join(baseDir, 'stack.runtime.json'),
      JSON.stringify(
        {
          version: 1,
          stackName,
          ownerPid: process.pid,
          logs: { runner: runnerLogPath },
        },
        null,
        2
      ),
      'utf-8'
    );

    const envKey = 'HAPPIER_STACK_STORAGE_DIR';
    const prev = process.env[envKey];
    process.env[envKey] = storageDir;
    try {
      const got = await resolveRunnerLogPathFromRuntime({ stackName, waitMs: 50 });
      assert.equal(got, runnerLogPath);
    } finally {
      restoreEnvVar(envKey, prev);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startDaemonPostAuth throws a clear error when runtime server port is missing', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-flow-'));
  try {
    const storageDir = join(tmp, 'storage');
    const stackName = 's2';
    const baseDir = join(storageDir, stackName);
    await mkdir(baseDir, { recursive: true });

    await writeFile(
      join(baseDir, 'stack.runtime.json'),
      JSON.stringify(
        {
          version: 1,
          stackName,
          ownerPid: process.pid,
          ports: {},
        },
        null,
        2
      ),
      'utf-8'
    );

    const envKey = 'HAPPIER_STACK_STORAGE_DIR';
    const prev = process.env[envKey];
    process.env[envKey] = storageDir;
    try {
      await assert.rejects(
        () => startDaemonPostAuth({ rootDir: tmp, stackName, env: process.env, forceRestart: true }),
        /could not resolve server port/i
      );
    } finally {
      restoreEnvVar(envKey, prev);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveRunnerLogPathFromRuntime returns empty string when runtime owner pid is dead', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-flow-owner-dead-'));
  try {
    const storageDir = join(tmp, 'storage');
    const stackName = 's3';
    const baseDir = join(storageDir, stackName);
    await mkdir(baseDir, { recursive: true });

    await writeFile(
      join(baseDir, 'stack.runtime.json'),
      JSON.stringify(
        {
          version: 1,
          stackName,
          ownerPid: 999_999_999,
          logs: {},
        },
        null,
        2
      ),
      'utf-8'
    );

    const envKey = 'HAPPIER_STACK_STORAGE_DIR';
    const prev = process.env[envKey];
    process.env[envKey] = storageDir;
    try {
      const got = await resolveRunnerLogPathFromRuntime({ stackName, waitMs: 50, pollMs: 10 });
      assert.equal(got, '');
    } finally {
      restoreEnvVar(envKey, prev);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
