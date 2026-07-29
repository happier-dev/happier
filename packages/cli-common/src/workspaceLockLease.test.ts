import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    createWorkspaceLockLeaseValue,
    workspaceLockLeaseMatchesOwner,
} from '../workspaceLockLease.mjs';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-lock-lease-'));
    tempDirs.push(dir);
    return dir;
}

describe('workspace lock lease filesystem identity', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('authenticates the same owner through filesystem path aliases while keeping token and path mismatches fail-closed', async () => {
        const root = await createTempDir();
        const physicalDir = join(root, 'physical');
        const aliasDir = join(root, 'alias');
        const otherDir = join(root, 'other');
        await mkdir(physicalDir);
        await mkdir(otherDir);
        await symlink(physicalDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');

        const physicalLockPath = join(physicalDir, 'cli-dist-build.lock');
        const aliasLockPath = join(aliasDir, 'cli-dist-build.lock');
        const otherLockPath = join(otherDir, 'cli-dist-build.lock');
        await writeFile(physicalLockPath, '{}\n');
        await writeFile(otherLockPath, '{}\n');

        const leaseValue = createWorkspaceLockLeaseValue({
            lockPath: aliasLockPath,
            ownerToken: 'current-owner',
        });

        expect(workspaceLockLeaseMatchesOwner({
            lockPath: physicalLockPath,
            leaseValue,
            owner: { token: 'current-owner' },
        })).toBe(true);
        expect(workspaceLockLeaseMatchesOwner({
            lockPath: physicalLockPath,
            leaseValue,
            owner: { token: 'successor-owner' },
        })).toBe(false);
        expect(workspaceLockLeaseMatchesOwner({
            lockPath: otherLockPath,
            leaseValue,
            owner: { token: 'current-owner' },
        })).toBe(false);
    });
});
