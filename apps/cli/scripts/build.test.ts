import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../src/testkit/fs/tempDir';
import { buildCliDist } from './build.mjs';

describe('buildCliDist', () => {
  it('holds the CLI dist build lock across typecheck, bundle, finalize, and package sync', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-lock-section-');
    try {
      const lockPath = resolve(packageRoot, '.project', 'tmp', 'cli-dist-build.lock');
      const eventsPath = join(packageRoot, 'events.txt');
      const typecheckInvocations: unknown[][] = [];

      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        lockPath,
        lockTimeoutMs: 500,
        lockPollIntervalMs: 10,
        lockStaleAfterMs: 1_000,
        rmDistImpl: async () => {
          writeFileSync(eventsPath, 'rm\n', { flag: 'a' });
        },
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: (...args: unknown[]) => {
          typecheckInvocations.push(args);
          writeFileSync(eventsPath, 'typecheck\n', { flag: 'a' });
        },
        runPkgrollBuildImpl: () => {
          writeFileSync(eventsPath, 'bundle\n', { flag: 'a' });
        },
        finalizeDistImpl: () => {
          expect(existsSync(lockPath)).toBe(true);
          writeFileSync(eventsPath, 'finalize\n', { flag: 'a' });
        },
        syncPackageDistImpl: () => {
          writeFileSync(eventsPath, 'sync\n', { flag: 'a' });
        },
      });

      expect(readFileSync(eventsPath, 'utf8')).toBe('rm\ntypecheck\nbundle\nfinalize\nsync\n');
      expect(typecheckInvocations).toEqual([
        [
          '/canonical/runTypeScriptCli.mjs',
          ['--noEmit'],
          expect.objectContaining({ cwd: packageRoot }),
        ],
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
