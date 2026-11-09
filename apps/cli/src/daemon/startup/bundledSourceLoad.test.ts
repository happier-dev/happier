import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { createBundledActivationSourceResolver } from '@/plugins/runtime/bundledActivationSource';

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });

it('loads available bundled source without spawning a workspace build, including a second source plugin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-daemon-source-load-'));
    // The OS process boundary must not be reached: source exports are consumed
    // directly, so rebuilding a dist closure cannot make this read more current.
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        throw new Error('Unexpected workspace build before source plugin loading');
    });
    syncBuiltinESMExports();
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('VITEST_WORKER_ID', undefined);
    vi.stubEnv('NODE_ENV', 'development');
    try {
        for (const name of ['boot-first', 'boot-second']) {
            const directory = join(root, 'packages/plugins', name, 'src');
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'index.ts'), `export const loaded = ${JSON.stringify(name)};`);
        }
        const resolve = createBundledActivationSourceResolver({
            repoRoot: root,
            bundledPackageNames: ['@happier-dev/plugins-boot-first', '@happier-dev/plugins-boot-second'],
            canImportFirstPartyPluginSource: () => true,
        });
        for (const name of ['boot-first', 'boot-second']) {
            const source = resolve({ pluginId: `acme.${name}`, daemonEntryPath: `@happier-dev/plugins-${name}` });
            expect(source).not.toBeNull();
            const loaded = await source!.load();
            expect(loaded).toMatchObject({ loaded: name });
            expect(await source!.load()).toBe(loaded);
        }
        expect(spawn).not.toHaveBeenCalled();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
