import { afterEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { withWorkspaceBundleLock } from '../../../packages/cli-common/workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../scripts/workspaces/workspacePackageBuildLock.mjs';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';
import { readHappyCliRuntimeInputFreshness } from '../../stack/scripts/utils/proc/cli_runtime_inputs.mjs';
import { createEnvKeyScope } from '@/testkit/env/envScope';

async function importSetupModule() {
    return await import('./test-setup');
}

describe('CLI test global setup', () => {
    const originalSkipBuild = process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
    const fixtureRoots: string[] = [];

    async function createSetupFixture() {
        // Go toolchain discovery is an OS process boundary, like compilation.
        vi.spyOn(childProcess, 'execFileSync').mockReturnValue('fixture-go-env');
        syncBuiltinESMExports();
        const repoRoot = await mkdtemp(join(tmpdir(), 'happier-cli-test-setup-'));
        fixtureRoots.push(repoRoot);
        const projectRoot = join(repoRoot, 'apps', 'cli');
        await mkdir(projectRoot, { recursive: true });
        await writeFile(join(repoRoot, 'package.json'), '{}');
        await writeFile(join(repoRoot, 'pnpm-lock.yaml'), '');
        await writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
        await mkdir(join(projectRoot, 'native', 'processcustody'), { recursive: true });
        await writeFile(join(projectRoot, 'native', 'processcustody', 'go.mod'), 'module fixture\n\ngo 1.26.6\n');
        await writeFile(join(projectRoot, 'native', 'processcustody', 'main.go'), 'package main\n');
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
        syncBuiltinESMExports();
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

    it('consumes prepared full-test artifacts while another publisher holds the protocol lease', async () => {
        delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
        const { projectRoot, runCommand } = await createSetupFixture();
        const repoRoot = resolve(projectRoot, '..', '..');
        for (const name of ['ui', 'server']) {
            await mkdir(join(repoRoot, 'apps', name), { recursive: true });
            await writeFile(join(repoRoot, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
        }
        const protocolRoot = join(repoRoot, 'packages', 'protocol');
        const pluginRoot = join(repoRoot, 'packages', 'plugins', 'example');
        await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
        await writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n  - "packages/plugins/*"\n');
        await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
            name: '@happier-dev/cli', bundledDependencies: ['@happier-dev/protocol', '@happier-dev/plugins-example'],
            dependencies: { '@happier-dev/protocol': 'workspace:*', '@happier-dev/plugins-example': 'workspace:*' },
        }));
        await mkdir(join(protocolRoot, 'src'), { recursive: true });
        await writeFile(join(protocolRoot, 'package.json'), JSON.stringify({
            name: '@happier-dev/protocol', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
            scripts: { build: 'node compile.mjs' },
        }));
        await writeFile(join(protocolRoot, 'src/index.ts'), 'export const prepared = true;');
        await writeFile(join(protocolRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'dist' }, include: ['src'] }));
        await mkdir(join(pluginRoot, 'src'), { recursive: true });
        await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-example' }));
        await writeFile(join(pluginRoot, 'src/manifest.ts'), 'export const manifest = {};');
        await mkdir(join(projectRoot, 'scripts'), { recursive: true });
        await writeFile(join(projectRoot, 'scripts/buildSharedDeps.mjs'),
            `export * from ${JSON.stringify(new URL('../scripts/buildSharedDeps.mjs', import.meta.url).href)};`);
        await mkdir(join(protocolRoot, 'dist'), { recursive: true });
        await writeFile(join(protocolRoot, 'dist/index.js'), 'export const prepared = true;');
        await writeFile(join(protocolRoot, 'dist/index.d.ts'), 'export declare const prepared = true;');
        const distEntrypoint = join(projectRoot, 'dist/index.mjs');
        await mkdir(dirname(distEntrypoint), { recursive: true });
        await writeFile(distEntrypoint, 'export const prepared = true;');
        const { setup, prepareNativeCustody } = await importSetupModule();
        await prepareNativeCustody(projectRoot, runCommand);
        cliDistBuildManifest.writeCliDistBuildManifest(distEntrypoint, {
            inputFingerprint: (await readHappyCliRuntimeInputFreshness(projectRoot)).fingerprint,
        });
        const env = createEnvKeyScope(['HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED']);
        // No lease is handed to setup: this belongs to a separate publisher.
        await withWorkspaceBundleLock(async () => {
            env.patch({ HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' });
            try {
                await setup({ buildMode: 'full', dependencies: { resolveProjectRoot: () => projectRoot, runCommand } });
                await expect(readFile(distEntrypoint, 'utf8')).resolves.toBe('export const prepared = true;');
            } finally { env.restore(); }
        }, { lockPath: resolveWorkspacePackageBuildLockPath(protocolRoot, { name: '@happier-dev/protocol' }), wait: false });
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
            await prepareNativeCustody(projectRoot, runCommand);
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

    it.each(['absent', 'stale', 'current'] as const)('prepares %s dist from current inputs under the canonical publication lock', async (state) => {
        delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
        const { projectRoot, runCommand } = await createSetupFixture();
        await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
            name: '@happier-dev/test-setup-fixture', version: '0.0.0',
        }));
        const distEntrypoint = join(projectRoot, 'dist', 'index.mjs');
        const lockPath = join(resolve(projectRoot, '..', '..'), '.project/tmp/cli-dist-build.lock');
        const sourcePath = join(projectRoot, 'src', 'index.ts');
        await mkdir(dirname(sourcePath), { recursive: true });
        await writeFile(sourcePath, 'export const version = 1;');
        if (state !== 'absent') {
            await mkdir(dirname(distEntrypoint), { recursive: true });
            await writeFile(distEntrypoint, 'export const version = 1;');
            cliDistBuildManifest.writeCliDistBuildManifest(distEntrypoint, {
                inputFingerprint: (await readHappyCliRuntimeInputFreshness(projectRoot)).fingerprint,
            });
        }
        if (state === 'stale') await writeFile(sourcePath, 'export const version = 2;');
        const inputFingerprint = (await readHappyCliRuntimeInputFreshness(projectRoot)).fingerprint;
        const spawnSync = vi.fn((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
            expect(_args).toEqual(['run', 'build']);
            const lease: unknown = JSON.parse(options.env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD ?? 'null');
            expect(lease).toEqual(expect.objectContaining({ v: 1, path: lockPath, token: expect.any(String) }));
            mkdirSync(dirname(distEntrypoint), { recursive: true });
            writeFileSync(distEntrypoint, 'export const version = 2;');
            cliDistBuildManifest.writeCliDistBuildManifest(distEntrypoint, { inputFingerprint });
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

        expect(spawnSync).toHaveBeenCalledTimes(state === 'current' ? 0 : 1);
        await expect(readFile(distEntrypoint, 'utf8')).resolves.toBe(
            state === 'current' ? 'export const version = 1;' : 'export const version = 2;',
        );
        expect(cliDistBuildManifest.readCliDistBuildManifest(distEntrypoint)).toMatchObject({
            ok: true, manifest: { inputFingerprint },
        });
        await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
