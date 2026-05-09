/**
 * Tests for building Happier CLI subprocess invocations across runtimes (node/bun).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    createSpawnHappyCliEnvScope,
    withTempHappyCliEntrypoint,
} from '@/testkit/process/spawnHappyCliHarness';

describe('happier-cli subprocess invocation', () => {
    const envScope = createSpawnHappyCliEnvScope();
    const originalExecArgv = [...process.execArgv];

    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.doUnmock('node:fs');
        vi.restoreAllMocks();
        envScope.restore();
        process.execArgv = [...originalExecArgv];
    });

    it('builds a node invocation when HAPPIER_CLI_SUBPROCESS_RUNTIME=node', async () => {
        await withTempHappyCliEntrypoint(async (entrypoint) => {
            envScope.patch({
                HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
                HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
                HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
                HAPPIER_VARIANT: undefined,
                HAPPIER_STACK_REPO_DIR: undefined,
                HAPPIER_STACK_CLI_ROOT_DIR: undefined,
                HAPPIER_STACK_STACK: undefined,
                HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
            });
            const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');

            const inv = mod.buildHappyCliSubprocessInvocation(['--version']);
            expect(inv.runtime).toBe('node');
            expect(inv.argv).toEqual(
                expect.arrayContaining([
                    '--no-warnings',
                    '--no-deprecation',
                    entrypoint,
                    '--version',
                ]),
            );
        });
    });

    it('builds a bun invocation when HAPPIER_CLI_SUBPROCESS_RUNTIME=bun', async () => {
        await withTempHappyCliEntrypoint(async (entrypoint) => {
            envScope.patch({
                HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
                HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
                HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
                HAPPIER_VARIANT: undefined,
                HAPPIER_STACK_REPO_DIR: undefined,
                HAPPIER_STACK_CLI_ROOT_DIR: undefined,
                HAPPIER_STACK_STACK: undefined,
                HAPPIER_CLI_SUBPROCESS_RUNTIME: 'bun',
            });
            const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
            const inv = mod.buildHappyCliSubprocessInvocation(['--version']);
            expect(inv.runtime).toBe('bun');
            expect(inv.argv).toEqual(expect.arrayContaining([entrypoint, '--version']));
            expect(inv.argv).not.toContain('--no-warnings');
            expect(inv.argv).not.toContain('--no-deprecation');
        });
    });

    it('uses overridden subprocess entrypoint when provided', async () => {
        await withTempHappyCliEntrypoint(async (entrypoint) => {
            envScope.patch({
                HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
                HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
                HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
                HAPPIER_VARIANT: undefined,
                HAPPIER_STACK_REPO_DIR: undefined,
                HAPPIER_STACK_CLI_ROOT_DIR: undefined,
                HAPPIER_STACK_STACK: undefined,
                HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
            });

            const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
            const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

            expect(inv.runtime).toBe('node');
            expect(inv.argv).toEqual(
                expect.arrayContaining([
                    '--no-warnings',
                    '--no-deprecation',
                    entrypoint,
                    'daemon',
                    'start-sync',
                ]),
            );
        });
    });

    it('prefers package-dist entrypoint when dist is absent in a packaged runtime', async () => {
        envScope.patch({
            HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
            HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
            HAPPIER_VARIANT: undefined,
            HAPPIER_STACK_REPO_DIR: undefined,
            HAPPIER_STACK_CLI_ROOT_DIR: undefined,
            HAPPIER_STACK_STACK: undefined,
            HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined,
            HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        });

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
                expect.stringMatching(/package-dist[\\/]index\.mjs$/),
                'daemon',
                'start-sync',
            ]),
        );
        expect(inv.argv[2]).toMatch(/package-dist[\\/]index\.mjs$/);
    });

    it('falls back to tsx source entrypoint in dev mode when dist entrypoint is missing', async () => {
        envScope.patch({
            HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
            HAPPIER_STACK_REPO_DIR: undefined,
            HAPPIER_STACK_CLI_ROOT_DIR: undefined,
            HAPPIER_STACK_STACK: undefined,
            HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
            HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: join(process.cwd(), 'missing-entrypoint-synthetic', 'index.mjs'),
        });

        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

        expect(inv.runtime).toBe('node');
        const importIndex = inv.argv.indexOf('--import');
        expect(importIndex).toBeGreaterThanOrEqual(0);
        // Node can accept either `--import tsx` or a fully-resolved tsx loader path, depending on resolution strategy.
        expect(inv.argv[importIndex + 1]).toMatch(/(^tsx$|[\\/]tsx[\\/]dist[\\/]esm[\\/]index\.mjs$)/);
        expect(inv.argv).toEqual(
            expect.arrayContaining([expect.stringMatching(/src[\\/]index\.ts$/), 'daemon', 'start-sync']),
        );
        expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    });

    it('propagates --preserve-symlinks when the current CLI process was launched with it', async () => {
        await withTempHappyCliEntrypoint(async (entrypoint) => {
            envScope.patch({
                HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
                HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
                HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
                HAPPIER_VARIANT: undefined,
                HAPPIER_STACK_REPO_DIR: undefined,
                HAPPIER_STACK_CLI_ROOT_DIR: undefined,
                HAPPIER_STACK_STACK: undefined,
                HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
            });
            process.execArgv = ['--preserve-symlinks'];

            const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
            const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

            expect(inv.runtime).toBe('node');
            expect(inv.argv).toEqual(
                expect.arrayContaining([
                    '--preserve-symlinks',
                    '--no-warnings',
                    '--no-deprecation',
                    entrypoint,
                    'daemon',
                    'start-sync',
                ]),
            );
            expect(inv.argv.indexOf('--preserve-symlinks')).toBeLessThan(inv.argv.indexOf('--no-warnings'));
        });
    });
});
