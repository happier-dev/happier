import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { renameMock, renameDelegate } = vi.hoisted(() => ({
    renameMock: vi.fn(),
    renameDelegate: { current: null as null | typeof import('node:fs/promises').rename },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    renameDelegate.current = actual.rename;
    return {
        ...actual,
        rename: renameMock,
    };
});

import { resolveCliDistSnapshotDir } from './resolveCliDistSnapshotDir.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'resolve-cli-dist-snapshot-dir-'));
    tempDirs.push(dir);
    return dir;
}

async function writeRepoFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
}

describe('resolveCliDistSnapshotDir Windows copy fallback', () => {
    afterEach(async () => {
        renameMock.mockReset();
        await Promise.all(
            tempDirs.splice(0).map(async (dir) => {
                await rm(dir, { recursive: true, force: true });
            }),
        );
    });

    it('copies the live dist into the snapshot when Windows blocks the snapshot rename with EPERM', async () => {
        const repoRoot = await createTempDir();
        const cliDir = join(repoRoot, 'apps', 'cli');
        const distDir = join(cliDir, 'dist');
        const distBackupDir = join(cliDir, '.dist.hstack-backup');
        const distEntrypointPath = join(distDir, 'index.mjs');

        if (!renameDelegate.current) {
            throw new Error('expected node:fs/promises.rename delegate to be initialized');
        }

        renameMock.mockImplementation(async (from, to) => {
            if (from === distDir && String(to).includes('.dist.hstack-snapshot-')) {
                const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
            }
            return renameDelegate.current!(from, to);
        });

        await writeRepoFile(distEntrypointPath, 'export const cli = "fresh";\n');

        const snapshotDir = await resolveCliDistSnapshotDir({
            cliDir,
            distDir,
            distBackupDir,
            distEntrypointPath,
            reuseExistingDistSnapshot: true,
            buildDist: async () => {
                throw new Error('resolveCliDistSnapshotDir should not rebuild when reusing an existing dist snapshot');
            },
        });

        expect(snapshotDir).toContain('.dist.hstack-snapshot-');
        await expect(readFile(join(snapshotDir, 'index.mjs'), 'utf8')).resolves.toBe('export const cli = "fresh";\n');
        await expect(readFile(distEntrypointPath, 'utf8')).resolves.toBe('export const cli = "fresh";\n');
        expect(existsSync(snapshotDir)).toBe(true);
        expect(existsSync(distEntrypointPath)).toBe(true);
    });

    it('reclaims only abandoned process-owned snapshots before creating the next snapshot', async () => {
        const repoRoot = await createTempDir();
        const cliDir = join(repoRoot, 'apps', 'cli');
        const distDir = join(cliDir, 'dist');
        const distBackupDir = join(cliDir, '.dist.hstack-backup');
        const distEntrypointPath = join(distDir, 'index.mjs');
        const abandonedSnapshotDir = join(cliDir, '.dist.hstack-snapshot-111-orphan');
        const liveSnapshotDir = join(cliDir, '.dist.hstack-snapshot-222-live');

        if (!renameDelegate.current) {
            throw new Error('expected node:fs/promises.rename delegate to be initialized');
        }
        renameMock.mockImplementation((from, to) => renameDelegate.current!(from, to));

        await writeRepoFile(distEntrypointPath, 'export const cli = "fresh";\n');
        await writeRepoFile(join(abandonedSnapshotDir, 'index.mjs'), 'abandoned\n');
        await writeRepoFile(join(liveSnapshotDir, 'index.mjs'), 'live\n');

        const snapshotDir = await resolveCliDistSnapshotDir({
            cliDir,
            distDir,
            distBackupDir,
            distEntrypointPath,
            reuseExistingDistSnapshot: true,
            isProcessAliveImpl: (pid) => pid === 222 || pid === process.pid,
            buildDist: async () => {
                throw new Error('resolveCliDistSnapshotDir should not rebuild when reusing an existing dist snapshot');
            },
        });

        expect(existsSync(abandonedSnapshotDir)).toBe(false);
        expect(existsSync(liveSnapshotDir)).toBe(true);
        expect(snapshotDir).toContain(`.dist.hstack-snapshot-${process.pid}-`);
    });
});
