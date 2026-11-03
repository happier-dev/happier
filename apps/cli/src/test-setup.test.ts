import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { withWorkspaceBundleLock } from '../../../packages/cli-common/workspaceBundleLock.mjs';
import { createEnvKeyScope } from '@/testkit/env/envScope';

async function importSetupModule() {
    return await import('./test-setup');
}

describe('CLI test global setup', () => {
    const originalSkipBuild = process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
    const fixtureRoots: string[] = [];

    async function createSetupFixture() {
        const repoRoot = await mkdtemp(join(tmpdir(), 'happier-cli-test-setup-'));
        fixtureRoots.push(repoRoot);
        const projectRoot = join(repoRoot, 'apps', 'cli');
        await mkdir(projectRoot, { recursive: true });
        await writeFile(join(repoRoot, 'package.json'), '{}');
        await writeFile(join(repoRoot, 'pnpm-lock.yaml'), '');
        await writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
        const executablePath = join(projectRoot, 'tools', 'unpacked',
            `happier-process-custody${process.platform === 'win32' ? '.exe' : ''}`);
        // The Go process is the system boundary; setup, staging and publication
        // coordination remain real and publish the requested executable.
        const runCommand = vi.fn(async (_command: string, args: string[]) => {
            const output = args[args.indexOf('-o') + 1];
            if (!output) throw new Error('Native custody compilation requires an output path');
            await writeFile(output, 'compiled native custody');
        });
        return { projectRoot, executablePath, runCommand };
    }

    afterEach(async () => {
        if (typeof originalSkipBuild === 'string') {
            process.env.HAPPIER_CLI_TEST_SKIP_BUILD = originalSkipBuild;
        } else {
            delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
        }
        vi.restoreAllMocks();
        vi.doUnmock('node:child_process');
        vi.resetModules();
        await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('consumes public-prepared native custody in source-only mode without a full CLI dist build', async () => {
        const { projectRoot, executablePath, runCommand } = await createSetupFixture();
        const sourcePluginRoot = join(projectRoot, '..', '..', 'packages', 'plugins', 'codex');
        await mkdir(join(sourcePluginRoot, 'src'), { recursive: true });
        await writeFile(join(sourcePluginRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-codex' }));
        await writeFile(join(sourcePluginRoot, 'src', 'manifest.ts'), 'export const manifest = {};');
        const { setup, prepareNativeCustody } = await importSetupModule();
        const ensureDistBuiltOnce = vi.fn(async () => undefined);
        await prepareNativeCustody(projectRoot, runCommand);

        await setup({
            buildMode: 'none',
            dependencies: {
                resolveProjectRoot: () => projectRoot,
                ensureDistBuiltOnce,
                runCommand,
            },
        });

        await expect(readFile(executablePath, 'utf8')).resolves.toBe('compiled native custody');
        await expect(stat(join(projectRoot, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
        if (process.platform !== 'win32') {
            expect((await stat(executablePath)).mode & 0o111).toBe(0o111);
        }
        expect(ensureDistBuiltOnce).not.toHaveBeenCalled();
    });

    it('runs the canonical dist build for full mode', async () => {
        const { projectRoot, runCommand } = await createSetupFixture();
        const { setup } = await importSetupModule();
        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => projectRoot,
                ensureDistBuiltOnce,
                runCommand,
            },
        });

        expect(ensureDistBuiltOnce).toHaveBeenCalledWith(projectRoot);
    });

    it('uses prepared native custody and skips bundled publication and dist with the skip-build override', async () => {
        const { projectRoot, executablePath, runCommand } = await createSetupFixture();
        const pluginRoot = join(projectRoot, '..', '..', 'packages', 'plugins', 'codex');
        await mkdir(join(pluginRoot, 'src'), { recursive: true });
        await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-codex' }));
        await writeFile(join(pluginRoot, 'src', 'manifest.ts'), 'export const manifest = {};');
        const { setup, prepareNativeCustody } = await importSetupModule();
        await prepareNativeCustody(projectRoot, runCommand);
        process.env.HAPPIER_CLI_TEST_SKIP_BUILD = 'true';

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => projectRoot,
                runCommand,
            },
        });

        await expect(readFile(executablePath, 'utf8')).resolves.toBe('compiled native custody');
        await expect(stat(join(projectRoot, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
        // A missing publisher in this source fixture must never be imported.
        await expect(stat(join(projectRoot, 'scripts', 'buildSharedDeps.mjs'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(runCommand).toHaveBeenCalledTimes(process.platform === 'win32' ? 2 : 1);
    });

    it.skipIf(process.platform === 'win32')('reuses prepared native custody on a later source setup', async () => {
        const { projectRoot, executablePath, runCommand } = await createSetupFixture();
        const { setup, prepareNativeCustody } = await importSetupModule();
        const options = {
            buildMode: 'none' as const,
            dependencies: { resolveProjectRoot: () => projectRoot, runCommand },
        };

        await prepareNativeCustody(projectRoot, runCommand);
        await setup(options);
        await setup(options);

        await expect(readFile(executablePath, 'utf8')).resolves.toBe('compiled native custody');
        expect(runCommand).toHaveBeenCalledTimes(1);
    });

    it('refreshes prepared native custody from current source at the preparation owner', async () => {
        const { projectRoot, executablePath } = await createSetupFixture();
        const nativeSource = join(projectRoot, 'native', 'processcustody', 'main.go');
        await mkdir(dirname(nativeSource), { recursive: true });
        await writeFile(nativeSource, 'native source one');
        const runCommand = async (_command: string, args: string[]) => {
            await writeFile(args[args.indexOf('-o') + 1]!, await readFile(nativeSource));
        };
        const { prepareNativeCustody } = await importSetupModule();
        await prepareNativeCustody(projectRoot, runCommand);
        await writeFile(nativeSource, 'native source two');

        await prepareNativeCustody(projectRoot, runCommand);

        await expect(readFile(executablePath, 'utf8')).resolves.toBe('native source two');
    });

    it.skipIf(process.platform === 'win32')('requires public native preparation before POSIX source collection', async () => {
        const { projectRoot, executablePath, runCommand } = await createSetupFixture();
        const { setup } = await importSetupModule();

        await expect(setup({ buildMode: 'none', dependencies: {
            resolveProjectRoot: () => projectRoot, runCommand,
        } })).rejects.toThrow(executablePath);

        expect(runCommand).not.toHaveBeenCalled();
    });

    it('retains native preparation in the Windows source global setup phase', async () => {
        const { projectRoot, executablePath, runCommand } = await createSetupFixture();
        const { setup } = await importSetupModule();

        await setup({ buildMode: 'none', dependencies: {
            platform: 'win32', resolveProjectRoot: () => projectRoot, runCommand,
        } });

        await expect(readFile(executablePath, 'utf8')).resolves.toBe('compiled native custody');
        expect(runCommand).toHaveBeenCalledTimes(1);
    });

    it('stages native fixtures from the prepared selected-checkout artifact without another compiler', async () => {
        const { projectRoot, executablePath, runCommand } = await createSetupFixture();
        const { setup, prepareNativeCustody } = await importSetupModule();
        await prepareNativeCustody(projectRoot, runCommand);
        await setup({ buildMode: 'none', dependencies: { resolveProjectRoot: () => projectRoot, runCommand } });
        await expect(stat(executablePath)).resolves.toBeDefined();
        const { createProcessCustodyFixture } = await import('./testkit/processCustodyFixture');
        const originalExecPath = process.execPath;
        const env = createEnvKeyScope(['PATH']);
        let disposeNative: (() => Promise<void>) | undefined;
        let payloadRoot: string | undefined;
        // The compiler is unavailable at the OS boundary; prepared readers
        // must not start a second Go process under a test's synthetic Home.
        env.patch({ PATH: '' });
        try {
            disposeNative = await createProcessCustodyFixture({ repoRoot: resolve(projectRoot, '..', '..') });
            payloadRoot = dirname(process.execPath);
            await expect(readFile(join(payloadRoot, 'tools', 'unpacked', basename(executablePath))))
                .resolves.toEqual(await readFile(executablePath));
        } finally {
            await disposeNative?.();
            env.restore();
        }
        expect(process.execPath).toBe(originalExecPath);
        await expect(stat(payloadRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a missing selected-checkout native fixture prerequisite instead of compiling inside the test', async () => {
        const { projectRoot, executablePath } = await createSetupFixture();
        await expect(stat(executablePath)).rejects.toMatchObject({ code: 'ENOENT' });
        const { createProcessCustodyFixture } = await import('./testkit/processCustodyFixture');
        const originalExecPath = process.execPath;
        const env = createEnvKeyScope(['PATH']);
        env.patch({ PATH: '' });
        try {
            await expect(createProcessCustodyFixture({ repoRoot: resolve(projectRoot, '..', '..') }))
                .rejects.toThrow(executablePath);
        } finally {
            env.restore();
        }
        expect(process.execPath).toBe(originalExecPath);
    });

    it.skipIf(process.platform === 'win32')('reads prepared native custody without retaining an unrelated CLI dist publication lease', async () => {
        const { projectRoot, executablePath, runCommand } = await createSetupFixture();
        const { setup, prepareNativeCustody } = await importSetupModule();
        const options = {
            buildMode: 'none' as const,
            dependencies: { resolveProjectRoot: () => projectRoot, runCommand },
        };
        await prepareNativeCustody(projectRoot, runCommand);

        await withWorkspaceBundleLock(async () => {
            await setup(options);
            await expect(readFile(executablePath, 'utf8')).resolves.toBe('compiled native custody');
        }, { lockPath: join(resolve(projectRoot, '..', '..'), '.project/tmp/cli-dist-build.lock') });

        expect(runCommand).toHaveBeenCalledTimes(1);
    });

    it('fails full setup when native custody cannot be prepared', async () => {
        const { projectRoot, executablePath } = await createSetupFixture();
        const { setup } = await importSetupModule();
        const unavailable = Object.assign(new Error('Go toolchain is unavailable'), { code: 'ENOENT' });

        await expect(setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => projectRoot,
                runCommand: async () => { throw unavailable; },
            },
        })).rejects.toBe(unavailable);
        await expect(stat(executablePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('publishes dist under the canonical repo lock and forwards its live lease to the build process', async () => {
        delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
        const { projectRoot, runCommand } = await createSetupFixture();
        const distEntrypoint = join(projectRoot, 'dist', 'index.mjs');
        const lockPath = join(resolve(projectRoot, '..', '..'), '.project/tmp/cli-dist-build.lock');
        const spawnSync = vi.fn((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
            const lease: unknown = JSON.parse(options.env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD ?? 'null');
            expect(lease).toEqual(expect.objectContaining({ v: 1, path: lockPath, token: expect.any(String) }));
            mkdirSync(dirname(distEntrypoint), { recursive: true });
            writeFileSync(distEntrypoint, 'built dist');
            return { status: 0, stdout: '', stderr: '' };
        });
        // Only the package-manager process is replaced; the publication owner,
        // lock acquisition, live lease and output readiness remain real.
        vi.doMock('node:child_process', async (importOriginal) => ({
            ...await importOriginal<typeof import('node:child_process')>(), spawnSync,
        }));

        const { setup } = await importSetupModule();
        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => projectRoot,
                runCommand,
            },
        });

        expect(spawnSync).toHaveBeenCalledTimes(1);
        await expect(readFile(distEntrypoint, 'utf8')).resolves.toBe('built dist');
        await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
