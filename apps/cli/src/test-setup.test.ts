import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function importSetupModule() {
    return await import('./test-setup');
}

describe('CLI test global setup', () => {
    const originalSkipBuild = process.env.HAPPIER_CLI_TEST_SKIP_BUILD;

    afterEach(() => {
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
    });

    it('does not publish build outputs in source-only mode', async () => {
        const { setup } = await importSetupModule();
        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'none',
            dependencies: {
                resolveProjectRoot: () => '/tmp/happier-cli-project',
                ensureDistBuiltOnce,
            },
        });

        expect(ensureDistBuiltOnce).not.toHaveBeenCalled();
    });

    it('runs the canonical dist build for full mode', async () => {
        const { setup } = await importSetupModule();
        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => '/tmp/happier-cli-project',
                ensureDistBuiltOnce,
            },
        });

        expect(ensureDistBuiltOnce).toHaveBeenCalledWith('/tmp/happier-cli-project');
    });

    it('respects the global skip-build override', async () => {
        const { setup } = await importSetupModule();
        process.env.HAPPIER_CLI_TEST_SKIP_BUILD = 'true';

        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => '/tmp/happier-cli-project',
                ensureDistBuiltOnce,
            },
        });

        expect(ensureDistBuiltOnce).not.toHaveBeenCalled();
    });

    it('uses the canonical repo dist build lock for mutable CLI dist outputs', async () => {
        delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
        const ensureBuildArtifactsReadyOnce = vi.fn(async () => undefined);
        vi.doMock('./testSetupBuildCoordinator', () => ({
            ensureBuildArtifactsReadyOnce,
        }));

        const { setup } = await importSetupModule();

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => cliProjectRoot,
            },
        });

        expect(ensureBuildArtifactsReadyOnce).toHaveBeenCalledTimes(1);
        expect(ensureBuildArtifactsReadyOnce).toHaveBeenCalledWith(
            expect.objectContaining({
                lockPath: join(resolve(cliProjectRoot, '..', '..'), '.project', 'tmp', 'cli-dist-build.lock'),
            }),
        );
    });

    it('forwards the canonical lock lease to the nested dist build process', async () => {
        delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
        const distEntrypoint = join(cliProjectRoot, 'dist', 'index.mjs');
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
                resolveProjectRoot: () => cliProjectRoot,
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
