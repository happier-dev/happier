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

    beforeEach(() => {
        vi.resetModules();
        assertCliEntrypointExists();
    });

    afterEach(() => {
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
    });

    it('builds a node invocation when HAPPIER_CLI_SUBPROCESS_RUNTIME=node', async () => {
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
        process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'bun';
        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['--version']);
        expect(inv.runtime).toBe('bun');
        expect(inv.argv).toEqual(expect.arrayContaining([expect.stringMatching(/dist\/index\.mjs$/), '--version']));
        expect(inv.argv).not.toContain('--no-warnings');
        expect(inv.argv).not.toContain('--no-deprecation');
    });

    it('uses overridden subprocess entrypoint when provided', async () => {
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

    it('falls back to tsx source entrypoint in dev mode when dist entrypoint is missing', async () => {
        process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
        process.env.HAPPIER_VARIANT = 'dev';
        process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = '1';
        process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = join(tmpdir(), `missing-entrypoint-${Date.now()}`, 'index.mjs');

        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

        expect(inv.runtime).toBe('node');
        expect(inv.argv).toEqual(
            expect.arrayContaining([
                '--import',
                'tsx',
                expect.stringMatching(/src\/index\.ts$/),
                'daemon',
                'start-sync',
            ]),
        );
    });
});
