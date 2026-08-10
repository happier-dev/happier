import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { shouldReuseCliDistSnapshot } from './shouldReuseCliDistSnapshot.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'cli-dist-reuse-'));
    tempDirs.push(dir);
    return dir;
}

async function writeTimedFile(path: string, content: string, timestamp: Date): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
    await utimes(path, timestamp, timestamp);
}

describe('shouldReuseCliDistSnapshot', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map(async (dir) => {
            await rm(dir, { recursive: true, force: true });
        }));
    });

    it('returns false when a bundled workspace dist is newer than the cli dist entrypoint', async () => {
        const rootDir = await createTempDir();
        const older = new Date('2026-04-13T18:00:00.000Z');
        const newer = new Date('2026-04-13T18:05:00.000Z');
        const distEntrypointPath = join(rootDir, 'apps', 'cli', 'dist', 'index.mjs');
        const workspaceDistFile = join(rootDir, 'packages', 'cli-common', 'dist', 'firstPartyRuntime', 'index.js');

        await writeTimedFile(distEntrypointPath, 'export default "cli";\n', older);
        await writeTimedFile(workspaceDistFile, 'export default "workspace";\n', newer);

        await expect(shouldReuseCliDistSnapshot({
            distEntrypointPath,
            inputPaths: [join(rootDir, 'packages', 'cli-common', 'dist')],
        })).resolves.toBe(false);
    });

    it('returns true when the cli dist entrypoint is at least as new as every tracked input', async () => {
        const rootDir = await createTempDir();
        const older = new Date('2026-04-13T18:00:00.000Z');
        const newer = new Date('2026-04-13T18:05:00.000Z');
        const distEntrypointPath = join(rootDir, 'apps', 'cli', 'dist', 'index.mjs');
        const cliSourceFile = join(rootDir, 'apps', 'cli', 'src', 'index.ts');
        const workspaceDistFile = join(rootDir, 'packages', 'cli-common', 'dist', 'firstPartyRuntime', 'index.js');

        await writeTimedFile(cliSourceFile, 'export default "src";\n', older);
        await writeTimedFile(workspaceDistFile, 'export default "workspace";\n', older);
        await writeTimedFile(distEntrypointPath, 'export default "cli";\n', newer);

        await expect(shouldReuseCliDistSnapshot({
            distEntrypointPath,
            inputPaths: [
                join(rootDir, 'apps', 'cli', 'src'),
                join(rootDir, 'packages', 'cli-common', 'dist'),
            ],
        })).resolves.toBe(true);
    });

    it('requires an exact recorded build version when release packaging requests one', async () => {
        const rootDir = await createTempDir();
        const timestamp = new Date('2026-04-13T18:05:00.000Z');
        const distDir = join(rootDir, 'apps', 'cli', 'dist');
        const distEntrypointPath = join(distDir, 'index.mjs');
        await writeTimedFile(distEntrypointPath, 'export default "cli";\n', timestamp);
        await writeFile(
            join(distDir, '.build-manifest.json'),
            JSON.stringify({ buildVersion: '0.2.10' }),
            'utf8',
        );

        await expect(shouldReuseCliDistSnapshot({
            distEntrypointPath,
            inputPaths: [],
            expectedBuildVersion: '0.2.10-dev.61',
        })).resolves.toBe(false);
        await writeFile(
            join(distDir, '.build-manifest.json'),
            JSON.stringify({ buildVersion: '0.2.10-dev.61' }),
            'utf8',
        );
        await expect(shouldReuseCliDistSnapshot({
            distEntrypointPath,
            inputPaths: [],
            expectedBuildVersion: '0.2.10-dev.61',
        })).resolves.toBe(true);
    });
});
