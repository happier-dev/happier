import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createWorkspaceLockLeaseValue,
    parseWorkspaceLockLeaseValue,
} from '../../workspaceLockLease.mjs';
import { withCliDistBuildLock } from './withCliDistBuildLock.js';

function writeLockOwner(lockPath: string, owner: { pid: number; createdAtMs: number; updatedAtMs: number }): void {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(owner), 'utf8');
}

describe('withCliDistBuildLock', () => {
    it('inherits the exact current owner lease from the canonical child environment', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-dist-lock-reentry-'));
        const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
        try {
            const result = await withCliDistBuildLock(
                async ({ heldLockValue }) => {
                    const previousHeldLockValue = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
                    process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = heldLockValue;
                    try {
                        return await withCliDistBuildLock(
                            async ({ inherited, heldLockValue: nestedHeldLockValue }) => ({
                                inherited,
                                heldLockValue: nestedHeldLockValue,
                                outerHeldLockValue: heldLockValue,
                                value: 'nested',
                            }),
                            {
                                lockPath,
                                timeoutMs: 60,
                                pollIntervalMs: 10,
                                staleAfterMs: 1_000,
                            },
                        );
                    } finally {
                        if (previousHeldLockValue === undefined) {
                            delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
                        } else {
                            process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = previousHeldLockValue;
                        }
                    }
                },
                {
                    lockPath,
                    timeoutMs: 1_000,
                    pollIntervalMs: 10,
                    staleAfterMs: 1_000,
                },
            );

            expect(result).toMatchObject({ inherited: true, value: 'nested' });
            expect(result.heldLockValue).toBe(result.outerHeldLockValue);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('acquires its own lock when the inherited environment lease is missing', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-dist-lock-missing-env-'));
        const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
        const previousHeldLockValue = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
        delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
        try {
            await expect(
                withCliDistBuildLock(
                    async ({ inherited, heldLockValue }) => ({
                        inherited,
                        lease: parseWorkspaceLockLeaseValue(heldLockValue),
                    }),
                    {
                        lockPath,
                        timeoutMs: 1_000,
                        pollIntervalMs: 10,
                        staleAfterMs: 1_000,
                    },
                ),
            ).resolves.toMatchObject({
                inherited: false,
                lease: { token: expect.any(String) },
            });
        } finally {
            if (previousHeldLockValue === undefined) {
                delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
            } else {
                process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = previousHeldLockValue;
            }
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails closed for missing or unauthenticated inherited environment leases while an owner is live', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-dist-lock-env-rejection-'));
        const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
        try {
            await withCliDistBuildLock(
                async ({ heldLockValue }) => {
                    const currentLease = parseWorkspaceLockLeaseValue(heldLockValue);
                    expect(currentLease).not.toBeNull();
                    const wrongPathLease = createWorkspaceLockLeaseValue({
                        lockPath: join(repoRoot, '.project', 'tmp', 'different.lock'),
                        ownerToken: currentLease!.token,
                    });
                    const forgedTokenLease = createWorkspaceLockLeaseValue({
                        lockPath,
                        ownerToken: 'forged-owner-token',
                    });

                    for (const env of [
                        {},
                        { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: wrongPathLease },
                        { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: forgedTokenLease },
                        { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '{"v":1' },
                        { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: lockPath },
                    ]) {
                        await expect(
                            withCliDistBuildLock(async () => 'must-not-run', {
                                lockPath,
                                env,
                                timeoutMs: 30,
                                pollIntervalMs: 5,
                                staleAfterMs: 1_000,
                            }),
                        ).rejects.toThrow(/Timed out waiting for CLI dist build lock/);
                    }
                },
                {
                    lockPath,
                    timeoutMs: 1_000,
                    pollIntervalMs: 10,
                    staleAfterMs: 1_000,
                },
            );
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps an explicit inherited lease authoritative over the environment', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-dist-lock-explicit-precedence-'));
        const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
        try {
            await withCliDistBuildLock(
                async ({ heldLockValue }) => {
                    const forgedTokenLease = createWorkspaceLockLeaseValue({
                        lockPath,
                        ownerToken: 'forged-owner-token',
                    });

                    await expect(
                        withCliDistBuildLock(async () => 'must-not-run', {
                            lockPath,
                            heldLockValue: forgedTokenLease,
                            env: {
                                HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
                            },
                            timeoutMs: 30,
                            pollIntervalMs: 5,
                            staleAfterMs: 1_000,
                        }),
                    ).rejects.toThrow(/Timed out waiting for CLI dist build lock/);

                    await expect(
                        withCliDistBuildLock(
                            async ({ inherited }) => ({ inherited, value: 'nested' }),
                            {
                                lockPath,
                                heldLockValue,
                                env: {
                                    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: forgedTokenLease,
                                },
                                timeoutMs: 30,
                                pollIntervalMs: 5,
                                staleAfterMs: 1_000,
                            },
                        ),
                    ).resolves.toEqual({ inherited: true, value: 'nested' });
                },
                {
                    lockPath,
                    timeoutMs: 1_000,
                    pollIntervalMs: 10,
                    staleAfterMs: 1_000,
                },
            );
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
