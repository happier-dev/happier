/**
 * Tests for building Happier CLI subprocess invocations across runtimes (node/bun).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectPath } from '@/projectPath';

describe('happier-cli subprocess invocation', () => {
    // Do not mutate repo dist artifacts in tests.
    // The CLI test setup builds dist before suites run.
    function assertCliEntrypointExists(): void {
        const entrypoint = join(projectPath(), 'dist', 'index.mjs');
        if (existsSync(entrypoint)) return;
        throw new Error(
            `Expected built CLI entrypoint at ${entrypoint}. Run \"yarn --cwd apps/cli build\" before this test.`,
        );
    }

    const originalRuntimeOverride = process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
    const originalEntrypointOverride = process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
    const originalVariant = process.env.HAPPIER_VARIANT;
    const originalAllowTsxFallback = process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK;
    const originalPreferTsx = process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX;
    const originalStackRepoDir = process.env.HAPPIER_STACK_REPO_DIR;
    const originalStackCliRootDir = process.env.HAPPIER_STACK_CLI_ROOT_DIR;
    const originalStackName = process.env.HAPPIER_STACK_STACK;
    const originalExecArgv = [...process.execArgv];

    beforeEach(() => {
        vi.resetModules();
    });

    function resetToBuiltEntrypointContract(): void {
        assertCliEntrypointExists();
        process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = '0';
        process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = '0';
        delete process.env.HAPPIER_VARIANT;
        delete process.env.HAPPIER_STACK_REPO_DIR;
        delete process.env.HAPPIER_STACK_CLI_ROOT_DIR;
        delete process.env.HAPPIER_STACK_STACK;
    }

    afterEach(() => {
        vi.doUnmock('node:fs');
        vi.restoreAllMocks();
        if (originalRuntimeOverride === undefined) {
            delete process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
        } else {
            process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = originalRuntimeOverride;
        }
        if (originalEntrypointOverride === undefined) {
            delete process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
        } else {
            process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = originalEntrypointOverride;
        }
        if (originalVariant === undefined) {
            delete process.env.HAPPIER_VARIANT;
        } else {
            process.env.HAPPIER_VARIANT = originalVariant;
        }
        if (originalAllowTsxFallback === undefined) {
            delete process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK;
        } else {
            process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = originalAllowTsxFallback;
        }
        if (originalPreferTsx === undefined) {
            delete process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX;
        } else {
            process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = originalPreferTsx;
        }
        if (originalStackRepoDir === undefined) {
            delete process.env.HAPPIER_STACK_REPO_DIR;
        } else {
            process.env.HAPPIER_STACK_REPO_DIR = originalStackRepoDir;
        }
        if (originalStackCliRootDir === undefined) {
            delete process.env.HAPPIER_STACK_CLI_ROOT_DIR;
        } else {
            process.env.HAPPIER_STACK_CLI_ROOT_DIR = originalStackCliRootDir;
        }
        if (originalStackName === undefined) {
            delete process.env.HAPPIER_STACK_STACK;
        } else {
            process.env.HAPPIER_STACK_STACK = originalStackName;
        }
        process.execArgv = [...originalExecArgv];
    });

    it('builds a node invocation when HAPPIER_CLI_SUBPROCESS_RUNTIME=node', async () => {
        resetToBuiltEntrypointContract();
        process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');

        const inv = mod.buildHappyCliSubprocessInvocation(['--version']);
        expect(inv.runtime).toBe('node');
        expect(inv.argv).toEqual(
            expect.arrayContaining([
                '--no-warnings',
                '--no-deprecation',
                expect.stringMatching(/dist\/index\.mjs$/),
                '--version',
            ]),
        );
    });

    it('builds a bun invocation when HAPPIER_CLI_SUBPROCESS_RUNTIME=bun', async () => {
        resetToBuiltEntrypointContract();
        process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'bun';
        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['--version']);
        expect(inv.runtime).toBe('bun');
        expect(inv.argv).toEqual(expect.arrayContaining([expect.stringMatching(/dist\/index\.mjs$/), '--version']));
        expect(inv.argv).not.toContain('--no-warnings');
        expect(inv.argv).not.toContain('--no-deprecation');
    });

    it('uses overridden subprocess entrypoint when provided', async () => {
        resetToBuiltEntrypointContract();
        process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
        const overrideDir = join(tmpdir(), `happier-cli-entrypoint-${Date.now()}`);
        const overrideEntrypoint = join(overrideDir, 'index.mjs');
        mkdirSync(overrideDir, { recursive: true });
        writeFileSync(overrideEntrypoint, 'export {};\n', 'utf8');
        process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = overrideEntrypoint;

        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

        expect(inv.runtime).toBe('node');
        expect(inv.argv).toEqual(
            expect.arrayContaining([
                '--no-warnings',
                '--no-deprecation',
                overrideEntrypoint,
                'daemon',
                'start-sync',
            ]),
        );
    });

    it('prefers package-dist entrypoint when dist is absent in a packaged runtime', async () => {
        process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = '0';
        process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = '0';
        delete process.env.HAPPIER_VARIANT;
        delete process.env.HAPPIER_STACK_REPO_DIR;
        delete process.env.HAPPIER_STACK_CLI_ROOT_DIR;
        delete process.env.HAPPIER_STACK_STACK;
        delete process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
        process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';

        vi.doMock('node:fs', async () => {
            const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
            return {
                ...actual,
                existsSync: (path: string) => {
                    if (path.endsWith('package-dist/index.mjs')) return true;
                    if (path.endsWith('dist/index.mjs')) return false;
                    return actual.existsSync(path);
                },
            };
        });

        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

        expect(inv.runtime).toBe('node');
        expect(inv.argv).toEqual(
            expect.arrayContaining([
                '--no-warnings',
                '--no-deprecation',
                expect.stringMatching(/package-dist\/index\.mjs$/),
                'daemon',
                'start-sync',
            ]),
        );
        expect(inv.argv[2]).toMatch(/package-dist\/index\.mjs$/);
    });

    it('falls back to tsx source entrypoint in dev mode when dist entrypoint is missing', async () => {
        process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = '0';
        delete process.env.HAPPIER_STACK_REPO_DIR;
        delete process.env.HAPPIER_STACK_CLI_ROOT_DIR;
        delete process.env.HAPPIER_STACK_STACK;
        process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
        process.env.HAPPIER_VARIANT = 'dev';
        process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = '1';
        process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = join(tmpdir(), `missing-entrypoint-${Date.now()}`, 'index.mjs');

        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

        expect(inv.runtime).toBe('node');
        const importIndex = inv.argv.indexOf('--import');
        expect(importIndex).toBeGreaterThanOrEqual(0);
        // Node can accept either `--import tsx` or a fully-resolved tsx loader path, depending on resolution strategy.
        expect(inv.argv[importIndex + 1]).toMatch(/(^tsx$|\/tsx\/dist\/esm\/index\.mjs$)/);
        expect(inv.argv).toEqual(
            expect.arrayContaining([expect.stringMatching(/src\/index\.ts$/), 'daemon', 'start-sync']),
        );
        expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    });

    it('propagates --preserve-symlinks when the current CLI process was launched with it', async () => {
        resetToBuiltEntrypointContract();
        process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
        process.execArgv = ['--preserve-symlinks'];

        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

        expect(inv.runtime).toBe('node');
        expect(inv.argv).toEqual(
            expect.arrayContaining([
                '--preserve-symlinks',
                '--no-warnings',
                '--no-deprecation',
                expect.stringMatching(/dist\/index\.mjs$/),
                'daemon',
                'start-sync',
            ]),
        );
        expect(inv.argv.indexOf('--preserve-symlinks')).toBeLessThan(inv.argv.indexOf('--no-warnings'));
    });
});
