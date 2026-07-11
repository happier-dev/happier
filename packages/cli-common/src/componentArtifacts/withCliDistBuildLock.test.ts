import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withCliDistBuildLock } from './withCliDistBuildLock.js';

function writeLockOwner(lockPath: string, owner: { pid: number; createdAtMs: number; updatedAtMs: number }): void {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(owner), 'utf8');
}

describe('withCliDistBuildLock', () => {
    it('permits reentry only with the current owner lease', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-dist-lock-reentry-'));
        const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
        try {
            const result = await withCliDistBuildLock(
                async ({ heldLockValue }) =>
                    await withCliDistBuildLock(
                        async () => 'nested',
                        {
                            lockPath,
                            heldLockValue,
                            timeoutMs: 60,
                            pollIntervalMs: 10,
                            staleAfterMs: 1_000,
                        },
                    ),
                {
                    lockPath,
                    timeoutMs: 1_000,
                    pollIntervalMs: 10,
                    staleAfterMs: 1_000,
                },
            );

            expect(result).toBe('nested');
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('reclaims a lock from a dead owner immediately', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-dist-lock-'));
        const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
        try {
            const nowMs = Date.now();
            writeLockOwner(lockPath, {
                pid: 99999999,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
            });

            const result = await withCliDistBuildLock(
                async ({ waited }) => {
                    expect(waited).toBe(false);
                    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
                    expect(owner.pid).toBe(process.pid);
                    return 'ok';
                },
                {
                    lockPath,
                    timeoutMs: 1_000,
                    pollIntervalMs: 10,
                    staleAfterMs: 120_000,
                },
            );

            expect(result).toBe('ok');
            expect(existsSync(lockPath)).toBe(false);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('waits for a live owner to release the lock before entering', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-dist-lock-'));
        const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
        try {
            const nowMs = Date.now();
            writeLockOwner(lockPath, {
                pid: process.pid,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
            });

            const promise = withCliDistBuildLock(
                async ({ waited }) => {
                    expect(waited).toBe(true);
                    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
                    expect(owner.pid).toBe(process.pid);
                    return 'ok';
                },
                {
                    lockPath,
                    timeoutMs: 1_000,
                    pollIntervalMs: 10,
                    staleAfterMs: 120_000,
                },
            );

            setTimeout(() => {
                unlinkSync(lockPath);
            }, 30);

            await expect(promise).resolves.toBe('ok');
            expect(existsSync(lockPath)).toBe(false);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('times out when a live owner keeps the lock active', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-dist-lock-'));
        const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
        try {
            const nowMs = Date.now();
            writeLockOwner(lockPath, {
                pid: process.pid,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
            });

            await expect(
                withCliDistBuildLock(async () => 'ok', {
                    lockPath,
                    timeoutMs: 50,
                    pollIntervalMs: 10,
                    staleAfterMs: 120_000,
                }),
            ).rejects.toThrow(/Timed out waiting for CLI dist build lock: .*pid=.*ageMs=/);

            expect(existsSync(lockPath)).toBe(true);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
