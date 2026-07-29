import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

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

  it('does not reclaim stale lock files when the recorded pid is still alive', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-lock-'));
    const lockPath = join(workDir, 'cli-dist-build.lock');
    const owner = { pid: process.pid, createdAtMs: 1 };
    let enteredCriticalSection = false;

    writeFileSync(lockPath, JSON.stringify(owner), 'utf8');

    await expect(
      withCliDistBuildLock(
        async () => {
          enteredCriticalSection = true;
          return 'ok';
        },
        { lockPath, timeoutMs: 120, pollIntervalMs: 20, staleAfterMs: 0 },
      ),
    ).rejects.toThrow(/ownerPid=/);

    expect(enteredCriticalSection).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(owner);
  });

  it('does not heartbeat over or unlink a successor owner', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-lock-successor-'));
    const lockPath = join(workDir, 'cli-dist-build.lock');
    const successorOwner = { pid: process.pid + 1_000_000, createdAtMs: Date.now() + 1 };

    await withCliDistBuildLock(
      async () => {
        writeFileSync(lockPath, JSON.stringify(successorOwner), 'utf8');
        await sleep(320);
        expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(successorOwner);
      },
      { lockPath, timeoutMs: 500, pollIntervalMs: 20, staleAfterMs: 20 },
    );

    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(successorOwner);
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
