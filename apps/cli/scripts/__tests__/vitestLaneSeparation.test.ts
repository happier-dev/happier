import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import unitConfig from '../../vitest.config';
import integrationConfig from '../../vitest.integration.config';
import slowConfig from '../../vitest.slow.config';

describe('Vitest lane separation', () => {
    it('uses lane-specific global setup entrypoints', () => {
        expect(unitConfig.test?.globalSetup).toEqual(['./src/test-setup.unit.ts']);
        expect(integrationConfig.test?.globalSetup).toEqual(['./src/test-setup.integration.ts']);
        expect(slowConfig.test?.globalSetup).toEqual(['./src/test-setup.slow.ts']);
    });

    it('keeps slow tests out of integration lane include patterns', () => {
        const include = integrationConfig.test?.include;
        expect(Array.isArray(include)).toBe(true);
        expect(include).not.toContain('src/**/*.slow.test.ts');
        expect(include).not.toContain('scripts/**/*.slow.test.ts');
    });

    it('keeps slow tests in slow lane include patterns', () => {
        const include = slowConfig.test?.include;
        expect(Array.isArray(include)).toBe(true);
        expect(include).toContain('src/**/*.slow.test.ts');
    });

    it('allows empty integration shards to exit cleanly', () => {
        expect(integrationConfig.test?.passWithNoTests).toBe(true);
    });

    it('does not force full dist builds in the fast CLI test scripts', () => {
        const packageJson = JSON.parse(
            readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
        ) as { scripts?: Record<string, string> };

        expect(packageJson.scripts?.['test:unit']).toBe(
            'node scripts/withNodeHeapLimit.mjs vitest run --config vitest.config.ts',
        );
        expect(packageJson.scripts?.['test:integration']).toBe(
            'node scripts/runVitestShards.mjs --config vitest.integration.config.ts',
        );

        // `yarn vitest ...` (without going through `yarn test:unit`) should still build internal
        // workspaces first so protocol/agents dist artifacts are never stale/missing.
        expect(packageJson.scripts?.vitest).toBe('$npm_execpath run -s build:shared && vitest');
    });

    it('keeps build-output dist verification out of the unit lane', () => {
        expect(
            existsSync(new URL('../buildOutputs.spawnHooks.integration.test.ts', import.meta.url)),
        ).toBe(true);
        expect(
            existsSync(new URL('../buildOutputs.spawnHooks.test.ts', import.meta.url)),
        ).toBe(false);
    });

    it('resolves bundled workspace packages from their source roots in the unit lane', () => {
        const alias = unitConfig.resolve?.alias;
        expect(Array.isArray(alias)).toBe(true);

        expect(alias).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    find: '@happier-dev/cli-common',
                    replacement: expect.stringContaining('/packages/cli-common/src'),
                }),
                expect.objectContaining({
                    find: '@happier-dev/agents',
                    replacement: expect.stringContaining('/packages/agents/src'),
                }),
                expect.objectContaining({
                    find: '@happier-dev/protocol',
                    replacement: expect.stringContaining('/packages/protocol/src'),
                }),
                expect.objectContaining({
                    find: '@happier-dev/connection-supervisor',
                    replacement: expect.stringContaining('/packages/connection-supervisor/src'),
                }),
                expect.objectContaining({
                    find: '@happier-dev/transfers',
                    replacement: expect.stringContaining('/packages/transfers/src'),
                }),
                expect.objectContaining({
                    find: '@happier-dev/release-runtime',
                    replacement: expect.stringContaining('/packages/release-runtime/src'),
                }),
                expect.objectContaining({
                    find: '@happier-dev/plugins-claude',
                    replacement: expect.stringContaining('/packages/plugins/claude/src'),
                }),
                expect.objectContaining({
                    find: '@happier-dev/plugins-codex',
                    replacement: expect.stringContaining('/packages/plugins/codex/src'),
                }),
            ]),
        );
    });

    it('resolves bundled workspace packages from their source roots in the integration lane', () => {
        const alias = integrationConfig.resolve?.alias;
        expect(Array.isArray(alias)).toBe(true);

        expect(alias).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    find: '@happier-dev/cli-common',
                    replacement: expect.stringContaining('/packages/cli-common/src'),
                }),
                expect.objectContaining({
                    find: '@happier-dev/release-runtime',
                    replacement: expect.stringContaining('/packages/release-runtime/src'),
                }),
                expect.objectContaining({
                    find: '@happier-dev/plugins-claude',
                    replacement: expect.stringContaining('/packages/plugins/claude/src'),
                }),
                expect.objectContaining({
                    find: '@happier-dev/plugins-codex',
                    replacement: expect.stringContaining('/packages/plugins/codex/src'),
                }),
            ]),
        );
    });
});
