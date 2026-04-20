import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveDaemonContinuityExecution,
  runDaemonContinuityValidation,
} from '../pipeline/release-validation/executors/daemon-continuity.mjs';
import {
  resolveSessionContinuityExecution,
  runSessionContinuityValidation,
} from '../pipeline/release-validation/executors/session-continuity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const testsWorkspaceRoot = resolve(repoRoot, 'packages', 'tests');
const vitestRunner = resolve(testsWorkspaceRoot, 'scripts', 'run-vitest-with-heartbeat.mjs');
const vitestConfig = resolve(testsWorkspaceRoot, 'vitest.core.slow.config.ts');

test('daemon-continuity plans the daemon continuity core e2e lane through the shared test runner', () => {
  const execution = resolveDaemonContinuityExecution({
    repoRoot,
    source: { kind: 'local-build', ref: 'HEAD' },
  });

  assert.deepEqual(execution, {
    type: 'command',
    command: process.execPath,
    args: [
      vitestRunner,
      '--config',
      vitestConfig,
      resolve(
        testsWorkspaceRoot,
        'suites',
        'core-e2e',
        'daemon.continuity.fakeClaude.reattach.slow.e2e.test.ts',
      ),
    ],
    cwd: testsWorkspaceRoot,
  });
});

test('session-continuity plans the server-restart continuity core e2e lane through the shared test runner', () => {
  const execution = resolveSessionContinuityExecution({
    repoRoot,
    source: { kind: 'local-build', ref: 'HEAD' },
  });

  assert.deepEqual(execution, {
    type: 'command',
    command: process.execPath,
    args: [
      vitestRunner,
      '--config',
      vitestConfig,
      resolve(
        testsWorkspaceRoot,
        'suites',
        'core-e2e',
        'session.continuity.fakeClaude.serverRestart.slow.e2e.test.ts',
      ),
    ],
    cwd: testsWorkspaceRoot,
  });
});

test('continuity executors reject unsupported source kinds', () => {
  assert.throws(
    () =>
      resolveDaemonContinuityExecution({
        repoRoot,
        source: { kind: 'published-channel', ref: 'preview' },
      }),
    /local-build/i,
  );
  assert.throws(
    () =>
      resolveSessionContinuityExecution({
        repoRoot,
        source: { kind: 'published-tag', ref: 'cli-preview' },
      }),
    /local-build/i,
  );
});

test('continuity validation dispatch executes the planned command', () => {
  /** @type {Array<{ command: string; args: string[]; options?: unknown }>} */
  const calls = [];

  runDaemonContinuityValidation({
    repoRoot,
    source: { kind: 'local-build', ref: 'HEAD' },
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return '';
    },
  });

  runSessionContinuityValidation({
    repoRoot,
    source: { kind: 'local-build', ref: 'HEAD' },
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return '';
    },
  });

  assert.deepEqual(calls, [
    {
      command: process.execPath,
      args: [
        vitestRunner,
        '--config',
        vitestConfig,
        resolve(
          testsWorkspaceRoot,
          'suites',
          'core-e2e',
          'daemon.continuity.fakeClaude.reattach.slow.e2e.test.ts',
        ),
      ],
      options: {
        cwd: testsWorkspaceRoot,
        stdio: 'inherit',
      },
    },
    {
      command: process.execPath,
      args: [
        vitestRunner,
        '--config',
        vitestConfig,
        resolve(
          testsWorkspaceRoot,
          'suites',
          'core-e2e',
          'session.continuity.fakeClaude.serverRestart.slow.e2e.test.ts',
        ),
      ],
      options: {
        cwd: testsWorkspaceRoot,
        stdio: 'inherit',
      },
    },
  ]);
});
