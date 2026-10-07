import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH, parseBundledPluginPublicationFailures } from '../../../packages/cli-common/bundledPluginPublicationPolicy.mjs';
import { pluginPackageNameToPackageId, readBundledPluginPackageNames } from '../scripts/build-owned/bundledPluginMembership';

const cliProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
        await writeFile(join(repoRoot, 'yarn.lock'), '');
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
        vi.doUnmock('node:fs');
        vi.doUnmock('./testSetupBuildCoordinator');
        vi.resetModules();
        await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('prepares native custody in source-only mode without a full CLI dist build', async () => {
        const { projectRoot, executablePath, runCommand } = await createSetupFixture();
        const { setup } = await importSetupModule();
        const ensureDistBuiltOnce = vi.fn(async () => undefined);

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

    it('verifies the actual bundled publication prerequisite from source-unit global setup without a full CLI dist build', async () => {
        const repoRoot = resolve(cliProjectRoot, '..', '..');
        const packageNames = readBundledPluginPackageNames(repoRoot);
        const failurePath = join(cliProjectRoot, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH);
        const distEntrypoint = join(cliProjectRoot, 'dist', 'index.mjs');
        const outputPresent = async (path: string) => await stat(path).then(() => true).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
            throw error;
        });
        const manifestPaths = packageNames.map((packageName) => join(
            repoRoot, 'packages', 'plugins', pluginPackageNameToPackageId(packageName), '.happier-plugin', 'plugin.json',
        ));
        const [publicationMetadataPresent, cliDistPresent, packedManifestPresence] = await Promise.all([
            outputPresent(failurePath),
            outputPresent(distEntrypoint),
            Promise.all(manifestPaths.map(outputPresent)),
        ]);
        // The public Vitest configuration already awaited test-setup.unit.ts.
        // Verify its real source-only publication, without running preparation
        // twice or deleting outputs. Dist presence is an observation, not a
        // claim about bytes that may have existed before global setup.
        console.info('CLI source-unit global setup publication', {
            publicationMetadataPresent,
            cliDistPresent,
            bundledPackageCount: packageNames.length,
            packedManifestCount: packedManifestPresence.filter(Boolean).length,
        });
        expect(packageNames.length).toBeGreaterThan(0);

        const publication = parseBundledPluginPublicationFailures(await readFile(failurePath, 'utf8'));
        // Import the real consumer only inside the keeper, so a cold inventory cannot
        // prevent this keeper from collecting before its prerequisite assertion.
        const { readCurrentBundledPluginPublicationFailures } = await import('./plugins/projection/registry/builtIn/locators');
        expect(readCurrentBundledPluginPublicationFailures()).toEqual(publication);
        const failedPackageNames = new Set(publication.map((failure) => failure.packageName));
        for (const packageName of failedPackageNames) expect(packageNames).toContain(packageName);
        const { ingestPluginManifestV2 } = await import('@happier-dev/protocol/plugins/manifest/ingest');
        for (const packageName of packageNames) {
            if (failedPackageNames.has(packageName)) continue;
            const packageRoot = join(repoRoot, 'packages', 'plugins', pluginPackageNameToPackageId(packageName));
            const manifest: unknown = JSON.parse(await readFile(join(packageRoot, '.happier-plugin', 'plugin.json'), 'utf8'));
            const ingestion = ingestPluginManifestV2(manifest);
            expect(ingestion.ok, packageName).toBe(true);
            if (ingestion.ok && ingestion.manifest.entrypoints?.daemon) {
                expect((await stat(resolve(packageRoot, ingestion.manifest.entrypoints.daemon))).size, packageName).toBeGreaterThan(0);
            }
        }
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

    it('prepares native custody while respecting the full-dist skip-build override', async () => {
        const { projectRoot, executablePath, runCommand } = await createSetupFixture();
        const { setup } = await importSetupModule();
        process.env.HAPPIER_CLI_TEST_SKIP_BUILD = 'true';

        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => projectRoot,
                ensureDistBuiltOnce,
                runCommand,
            },
        });

        await expect(readFile(executablePath, 'utf8')).resolves.toBe('compiled native custody');
        expect(ensureDistBuiltOnce).not.toHaveBeenCalled();
    });

    it('reuses prepared native custody on a later source setup', async () => {
        const { projectRoot, executablePath, runCommand } = await createSetupFixture();
        const { setup } = await importSetupModule();
        const options = {
            buildMode: 'none' as const,
            dependencies: { resolveProjectRoot: () => projectRoot, runCommand },
        };

        await setup(options);
        await setup(options);

        await expect(readFile(executablePath, 'utf8')).resolves.toBe('compiled native custody');
        expect(runCommand).toHaveBeenCalledTimes(1);
    });

    it('fails setup when native custody cannot be prepared', async () => {
        const { projectRoot, executablePath } = await createSetupFixture();
        const { setup } = await importSetupModule();
        const unavailable = Object.assign(new Error('Go toolchain is unavailable'), { code: 'ENOENT' });

        await expect(setup({
            buildMode: 'none',
            dependencies: {
                resolveProjectRoot: () => projectRoot,
                runCommand: async () => { throw unavailable; },
            },
        })).rejects.toBe(unavailable);
        await expect(stat(executablePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('uses the canonical repo dist build lock for mutable CLI dist outputs', async () => {
        delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
        const { projectRoot } = await createSetupFixture();
        const ensureBuildArtifactsReadyOnce = vi.fn(async () => undefined);
        vi.doMock('./testSetupBuildCoordinator', () => ({
            ensureBuildArtifactsReadyOnce,
        }));

        const { setup } = await importSetupModule();

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => projectRoot,
            },
        });

        expect(ensureBuildArtifactsReadyOnce).toHaveBeenCalledWith(
            expect.objectContaining({
                lockPath: join(resolve(projectRoot, '..', '..'), '.project', 'tmp', 'cli-dist-build.lock'),
            }),
        );
    });

    it('forwards the canonical lock lease to the nested dist build process', async () => {
        delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
        const { projectRoot } = await createSetupFixture();
        const distEntrypoint = join(projectRoot, 'dist', 'index.mjs');
        vi.doMock('node:fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('node:fs')>();
            return {
                ...actual,
                existsSync: (path: Parameters<typeof actual.existsSync>[0]) => (
                    path === distEntrypoint || actual.existsSync(path)
                ),
            };
        });
        const spawnSync = vi.fn((
            _command: string,
            _args: readonly string[],
            _options: { env?: NodeJS.ProcessEnv },
        ) => ({ status: 0, stdout: '', stderr: '' }));
        vi.doMock('node:child_process', () => ({ spawnSync }));

        const heldLockValue = '{"v":1,"path":"/tmp/cli-dist-build.lock","token":"owner-token"}';
        const ensureBuildArtifactsReadyOnce = vi.fn(async (options: {
            lockLabel: string;
            runBuild: (context: { heldLockValue: string }) => Promise<void> | void;
        }) => {
            if (options.lockLabel === 'CLI dist build') {
                await options.runBuild({ heldLockValue });
            }
        });
        vi.doMock('./testSetupBuildCoordinator', () => ({ ensureBuildArtifactsReadyOnce }));

        const { setup } = await importSetupModule();
        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => projectRoot,
            },
        });

        expect(spawnSync).toHaveBeenCalledTimes(1);
        expect(spawnSync.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
            env: expect.objectContaining({
                HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
            }),
        }));
    });
});
