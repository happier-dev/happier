import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import unitConfig from '../../vitest.config';
import integrationConfig from '../../vitest.integration.config';
import g3ComposedConfig from '../../vitest.g3-composed.config';
import providersTempConfig from '../../vitest.providers.temp.config';
import slowConfig from '../../vitest.slow.config';
import { workspacePackageSourcesPlugin } from '../vitestWorkspacePackageResolution';

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

    it('leaves empty-collection tolerance to the shard runner, not the integration lane config', () => {
        // The shard runner passes `--passWithNoTests` per shard. If the config
        // set it, a directly invoked selected pattern that collects nothing
        // would exit green — CI runs exactly such a direct invocation.
        expect(integrationConfig.test?.passWithNoTests).toBeUndefined();
    });

    it('caps parallel CLI test workers at six', () => {
        expect(unitConfig.test?.maxWorkers).toBe(6);
        expect(slowConfig.test?.maxWorkers).toBe(6);
    });

    it('does not force full dist builds in the fast CLI test scripts', () => {
        const packageJson = JSON.parse(
            readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
        ) as { scripts?: Record<string, string> };

        const unitWrapper = packageJson.scripts?.['test:unit'];
        const unitLocal = packageJson.scripts?.['test:unit:local'];
        const integrationWrapper = packageJson.scripts?.['test:integration'];
        const integrationLocal = packageJson.scripts?.['test:integration:local'];
        const slowWrapper = packageJson.scripts?.['test:slow'];
        const slowLocal = packageJson.scripts?.['test:slow:local'];
        const vitestWrapper = packageJson.scripts?.vitest;
        const vitestLocal = packageJson.scripts?.['vitest:local'];
        const fastScripts = [
            unitLocal,
            integrationLocal,
            slowLocal,
        ].join('\n');

        expect(unitWrapper).toContain('--script=test:unit:local');
        expect(unitLocal).toContain(
            'vitest run --config vitest.config.ts',
        );
        expect(unitLocal).toContain('test:import-cycles');
        expect(integrationWrapper).toContain('--script=test:integration:local');
        expect(integrationLocal).toContain(
            'node scripts/runVitestShards.mjs --config vitest.integration.config.ts',
        );
        expect(slowWrapper).toContain('--script=test:slow:local');
        expect(slowLocal).toContain('vitest run --config vitest.slow.config.ts');
        expect(fastScripts).not.toContain('runPkgrollBuild');
        expect(fastScripts).not.toContain('syncPackageDist');
        expect(fastScripts).not.toContain('syncSharedDepsForDev');
        expect(vitestLocal).not.toContain('syncSharedDepsForDev');

        expect(vitestWrapper).toContain('--script=vitest:local');
        expect(vitestLocal).toBe('vitest');
        expect(packageJson.scripts?.pretest).toBeUndefined();
        expect(packageJson.scripts?.typecheck).toContain('--script=typecheck:local');
        expect(packageJson.scripts?.['pretypecheck:local']).toBeUndefined();
        expect(packageJson.scripts?.['typecheck:local']).not.toContain(
            'prepare:declarations',
        );
    });

    it('wires the CLI runtime import-cycle guard into root and CLI unit lanes', () => {
        const cliPackageJson = JSON.parse(
            readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
        ) as { scripts?: Record<string, string> };
        const rootPackageJson = JSON.parse(
            readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
        ) as { scripts?: Record<string, string> };

        expect(rootPackageJson.scripts?.['test:import-cycles']).toBe(
            'yarn workspace @happier-dev/cli test:import-cycles',
        );
        expect(cliPackageJson.scripts?.['test:unit']).toContain('--script=test:unit:local');
        expect(cliPackageJson.scripts?.['test:unit:local']).toContain('test:import-cycles');
    });

    it('keeps build-output dist verification out of the unit lane', () => {
        expect(
            existsSync(new URL('../buildOutputs.spawnHooks.integration.test.ts', import.meta.url)),
        ).toBe(true);
        expect(
            existsSync(new URL('../buildOutputs.spawnHooks.test.ts', import.meta.url)),
        ).toBe(false);
    });

    it('uses one export-driven source plugin in every CLI source-test lane', () => {
        for (const config of [
            unitConfig,
            integrationConfig,
            g3ComposedConfig,
            providersTempConfig,
        ]) {
            const aliases = config.resolve?.alias;
            expect(Array.isArray(aliases)).toBe(true);
            expect(aliases).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ find: expect.stringMatching(/^@happier-dev\//u) }),
            ]));
            expect(config.plugins).toEqual(expect.arrayContaining([workspacePackageSourcesPlugin]));
        }
    });

    it('resolves declared workspace exports through the canonical source plugin', () => {
        expect(
            workspacePackageSourcesPlugin.resolveId('@happier-dev/protocol/plugins/hooks'),
        ).toEqual(expect.stringContaining('/packages/protocol/src/plugins/hooks/catalog.ts'));
        expect(
            workspacePackageSourcesPlugin.resolveId(
                '@happier-dev/cli-common/componentArtifacts/cliRuntimeSidecars',
            ),
        ).toEqual(expect.stringContaining(
            '/packages/cli-common/src/componentArtifacts/cliRuntimeSidecars.ts',
        ));
        expect(
            workspacePackageSourcesPlugin.resolveId('@happier-dev/channels-protocol/v1'),
        ).toEqual(expect.stringContaining('/packages/channels-protocol/src/v1/index'));
    });

    it('resolves the public Plugin SDK lock bridge from its declared public leaf', () => {
        expect(
            workspacePackageSourcesPlugin.resolveId(
                '@happier-dev/plugin-sdk/host/fs/json-owner-file-lock',
            ),
        ).toEqual(expect.stringContaining(
            '/packages/plugin-sdk/src/host/fs/json-owner-file-lock/index.public.ts',
        ));
        expect(workspacePackageSourcesPlugin.resolveId(
            '@happier-dev/plugin-sdk/internal/fs/json-owner-file-lock',
        )).toBeNull();
    });
});
