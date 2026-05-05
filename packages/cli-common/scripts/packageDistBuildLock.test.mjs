import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { deleteLockIfOwnerMatches, withPackageDistBuildLock } from './packageDistBuildLock.mjs';

function writeLockOwner(lockPath, owner) {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(owner), 'utf8');
}

describe('withPackageDistBuildLock', () => {
    it('only deletes a lock file when the owner token still matches', () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-package-dist-lock-'));
        const lockPath = join(repoRoot, '.project', 'tmp', 'package-dist-build.lock');
        try {
            writeLockOwner(lockPath, {
                pid: 99999999,
                createdAtMs: 1,
                updatedAtMs: 1,
                token: 'replacement-owner',
            });

            expect(deleteLockIfOwnerMatches(lockPath, { token: 'stale-owner' })).toBe(false);
            expect(existsSync(lockPath)).toBe(true);
            expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
                token: 'replacement-owner',
            });
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('only removes the lock in finally when the caller still owns it', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-package-dist-lock-'));
        const lockPath = join(repoRoot, '.project', 'tmp', 'package-dist-build.lock');
        try {
            const replacementOwner = {
                pid: 123456,
                createdAtMs: 200,
                updatedAtMs: 200,
                token: 'replacement-owner',
            };

            await withPackageDistBuildLock(
                async () => {
                    writeLockOwner(lockPath, replacementOwner);
                },
                {
                    lockPath,
                    timeoutMs: 1_000,
                    pollIntervalMs: 10,
                    staleAfterMs: 1_000,
                    now: vi.fn().mockImplementation(() => 100),
                },
            );

            expect(existsSync(lockPath)).toBe(true);
            expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacementOwner);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
