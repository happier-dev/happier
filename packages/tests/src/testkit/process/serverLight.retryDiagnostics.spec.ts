import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repoRootDir } from '../paths';

let healthAttempt = 0;
let healthFailuresBeforeSuccess = 1;
let spawnAttempt = 0;
let sharedDepsBuildFailure: Error | undefined;
let isolatedLeasesDir: string;

vi.mock('node:net', () => ({
  createServer: () => ({
    once: () => {},
    listen: (_port: number, _host: string, onListening: () => void) => onListening(),
    close: (onClosed?: () => void) => onClosed?.(),
  }),
}));

vi.mock('./spawnProcess', () => ({
  runLoggedCommand: async (params: { args: string[] }) => {
    if (params.args.includes('build:shared') && sharedDepsBuildFailure) throw sharedDepsBuildFailure;
  },
  spawnLoggedProcess: (params: { stdoutPath: string; stderrPath: string }) => {
    spawnAttempt += 1;
    writeFileSync(params.stdoutPath, `stdout attempt ${spawnAttempt}\n`, 'utf8');
    writeFileSync(params.stderrPath, `stderr attempt ${spawnAttempt}\n`, 'utf8');

    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.exitCode = null;
    child.signalCode = null;

    return {
      child,
      stdoutPath: params.stdoutPath,
      stderrPath: params.stderrPath,
      stop: async () => {},
    };
  },
}));

vi.mock('../http', () => ({
  waitForOkHealth: async () => {
    healthAttempt += 1;
    if (healthAttempt <= healthFailuresBeforeSuccess) {
      const error = new Error('server-light lost the startup port') as Error & { code: string };
      error.code = 'EADDRINUSE';
      throw error;
    }
  },
}));

import { hasServerSharedDepsOutputs, startServerLight } from './serverLight';

beforeEach(async () => {
  healthAttempt = 0;
  healthFailuresBeforeSuccess = 1;
  spawnAttempt = 0;
  sharedDepsBuildFailure = undefined;
  isolatedLeasesDir = await mkdtemp(join(tmpdir(), 'happier-retry-diagnostic-leases-'));
  vi.stubEnv('HAPPIER_E2E_PROCESS_LEASES_DIR', isolatedLeasesDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(isolatedLeasesDir, { recursive: true, force: true });
});

afterAll(() => {
  vi.doUnmock('node:net');
  vi.doUnmock('./spawnProcess');
  vi.doUnmock('../http');
  vi.resetModules();
});

describe('startServerLight retry diagnostics', () => {
  it('refuses startup when canonical shared-dependency freshness validation fails even though outputs exist', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-server-dependency-freshness-'));
    let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
    try {
      // Existing output presence is the regression's precondition, not a freshness decision.
      expect(hasServerSharedDepsOutputs(repoRootDir())).toBe(true);
      const dataDir = join(testDir, 'server-light-data');
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'reuse.marker'), 'reuse');
      sharedDepsBuildFailure = new Error('BUILD_INPUTS_CHANGED');
      healthFailuresBeforeSuccess = 0;

      const startup = startServerLight({
        testDir, dbProvider: 'sqlite', dataDirMode: 'reuse-existing',
        extraEnv: {
          HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '0',
          HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
          HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '0',
        },
      }).then((started) => { server = started; return started; });
      await expect(startup).rejects.toThrow('BUILD_INPUTS_CHANGED');
      expect(spawnAttempt).toBe(0);
    } finally {
      await server?.stop();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('preserves each retry log while the current paths follow the successful attempt', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-server-light-retry-diagnostics-'));
    const dataDir = join(testDir, 'server-light-data');
    let server: Awaited<ReturnType<typeof startServerLight>> | null = null;
    const beforeSpawnAttempts: number[] = [];

    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'reuse.marker'), 'reuse', 'utf8');

      server = await startServerLight({
        testDir,
        dbProvider: 'sqlite',
        dataDirMode: 'reuse-existing',
        extraEnv: {
          HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
          HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
          HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '0',
        },
        __portAllocator: async () => 41_000 + healthAttempt,
        __beforeSpawnAttempt: async () => {
          beforeSpawnAttempts.push(spawnAttempt);
        },
      });

      expect(beforeSpawnAttempts).toEqual([0, 1]);

      await expect(readFile(join(testDir, 'server.attempt-1.stdout.log'), 'utf8')).resolves.toBe('stdout attempt 1\n');
      await expect(readFile(join(testDir, 'server.attempt-1.stderr.log'), 'utf8')).resolves.toBe('stderr attempt 1\n');
      await expect(readFile(join(testDir, 'server.attempt-2.stdout.log'), 'utf8')).resolves.toBe('stdout attempt 2\n');
      await expect(readFile(join(testDir, 'server.attempt-2.stderr.log'), 'utf8')).resolves.toBe('stderr attempt 2\n');
      await appendFile(join(testDir, 'server.attempt-2.stdout.log'), 'stdout after startup\n', 'utf8');
      await appendFile(join(testDir, 'server.attempt-2.stderr.log'), 'stderr after startup\n', 'utf8');
      await expect(readFile(join(testDir, 'server.stdout.log'), 'utf8')).resolves.toBe('stdout attempt 2\nstdout after startup\n');
      await expect(readFile(join(testDir, 'server.stderr.log'), 'utf8')).resolves.toBe('stderr attempt 2\nstderr after startup\n');
    } finally {
      await server?.stop();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('keeps the final failed attempt current after retry exhaustion', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-server-light-retry-exhausted-'));
    const dataDir = join(testDir, 'server-light-data');
    healthFailuresBeforeSuccess = Number.POSITIVE_INFINITY;

    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'reuse.marker'), 'reuse', 'utf8');

      await expect(startServerLight({
        testDir,
        dbProvider: 'sqlite',
        dataDirMode: 'reuse-existing',
        extraEnv: {
          HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
          HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
          HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '0',
        },
        __portAllocator: async () => 41_000 + healthAttempt,
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await expect(readFile(join(testDir, `server.attempt-${attempt}.stdout.log`), 'utf8')).resolves.toBe(`stdout attempt ${attempt}\n`);
        await expect(readFile(join(testDir, `server.attempt-${attempt}.stderr.log`), 'utf8')).resolves.toBe(`stderr attempt ${attempt}\n`);
      }
      await expect(readFile(join(testDir, 'server.stdout.log'), 'utf8')).resolves.toBe('stdout attempt 5\n');
      await expect(readFile(join(testDir, 'server.stderr.log'), 'utf8')).resolves.toBe('stderr attempt 5\n');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
