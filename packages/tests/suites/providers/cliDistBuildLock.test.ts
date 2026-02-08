import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { withCliDistBuildLock } from '../../src/testkit/process/cliDist';

describe('providers: CLI dist build lock', () => {
  it('reclaims stale lock files from dead owners', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-lock-'));
    const lockPath = join(workDir, 'cli-dist-build.lock');
    writeFileSync(lockPath, JSON.stringify({ createdAtMs: 1 }), 'utf8');

    const result = await withCliDistBuildLock(
      async () => {
        expect(existsSync(lockPath)).toBe(true);
        return 'ok';
      },
      { lockPath, timeoutMs: 500, pollIntervalMs: 20, staleAfterMs: 0 },
    );

    expect(result).toBe('ok');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not reclaim fresh locks from live owners', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-lock-'));
    const lockPath = join(workDir, 'cli-dist-build.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), 'utf8');

    await expect(
      withCliDistBuildLock(async () => 'ok', {
        lockPath,
        timeoutMs: 120,
        pollIntervalMs: 20,
        staleAfterMs: 120_000,
      }),
    ).rejects.toThrow(/ownerPid=/);

    expect(existsSync(lockPath)).toBe(true);
  });
});
