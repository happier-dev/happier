import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNativeComposeIncumbentBindReader } from './nativeComposeSharedData';

function foreignWriter(source: string) {
    const id = 'a'.repeat(64);
    return createNativeComposeIncumbentBindReader({ projectName: 'selected-project',
        // Docker discovery is the boundary; filesystem identity and overlap stay real.
        async run(args) {
            if (args[0] === 'ps') return { exitCode: 0, stdout: id };
            if (args[0] === 'inspect') return { exitCode: 0, stdout: JSON.stringify([{
                Id: id, Config: { Labels: { 'com.docker.compose.project': 'foreign-project',
                    'com.docker.compose.service': 'foreign-service' } },
                State: { Status: 'running' },
                Mounts: [{ Type: 'bind', Source: source, Destination: '/data', RW: true }],
            }]) };
            throw new Error(`Unexpected Docker command: ${args[0]}`);
        } });
}

async function withPaths(run: (paths: Readonly<{ selected: string; foreign: string }>) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'happier-shared-writers-'));
    const selected = join(root, 'selected', 'data');
    const foreign = join(root, 'foreign');
    await mkdir(selected, { recursive: true });
    await mkdir(foreign);
    try { await run({ selected, foreign }); }
    finally {
        await chmod(foreign, 0o700);
        await rm(root, { recursive: true, force: true });
    }
}

describe('native Compose shared-data writer discovery', () => {
    const permissionTest = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);

    permissionTest('allows seeding when an unrelated container bind has an inaccessible parent', async () => {
        await withPaths(async ({ selected, foreign }) => {
            const source = join(foreign, 'proxy');
            await mkdir(source);
            await chmod(foreign, 0o000);
            await expect(realpath(source)).rejects.toMatchObject({ code: 'EACCES' });
            await expect(foreignWriter(source).writers([selected])).resolves.toEqual([]);
        });
    });

    it.skipIf(process.platform === 'win32')('refuses a foreign writer through a symlink alias of selected data', async () => {
        await withPaths(async ({ selected, foreign }) => {
            const source = join(foreign, 'alias');
            await symlink(selected, source, 'dir');
            await expect(foreignWriter(source).writers([selected]))
                .rejects.toMatchObject({ code: 'deployment_source_unavailable' });
        });
    });

    permissionTest('uses the declared source for an inaccessible foreign alias', async () => {
        await withPaths(async ({ selected, foreign }) => {
            const source = join(foreign, 'alias');
            await symlink(selected, source, 'dir');
            await chmod(foreign, 0o000);
            await expect(realpath(source)).rejects.toMatchObject({ code: 'EACCES' });
            // Owner-approved compromise: an inaccessible alias may hide an overlap.
            await expect(foreignWriter(source).writers([selected])).resolves.toEqual([]);
        });
    });

    permissionTest('refuses a declared foreign writer below selected data despite its inaccessible parent', async () => {
        await withPaths(async ({ selected }) => {
            const privateDirectory = join(selected, 'private');
            const source = join(privateDirectory, 'data');
            await mkdir(source, { recursive: true });
            await chmod(privateDirectory, 0o000);
            try {
                await expect(realpath(source)).rejects.toMatchObject({ code: 'EACCES' });
                await expect(foreignWriter(source).writers([selected]))
                    .rejects.toMatchObject({ code: 'deployment_source_unavailable' });
            } finally { await chmod(privateDirectory, 0o700); }
        });
    });

    permissionTest('still refuses when selected data cannot be resolved physically', async () => {
        await withPaths(async ({ foreign }) => {
            const selected = join(foreign, 'data');
            await mkdir(selected);
            await chmod(foreign, 0o000);
            await expect(foreignWriter(selected).writers([selected]))
                .rejects.toMatchObject({ code: 'EACCES' });
        });
    });
});
