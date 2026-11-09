import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';

import unitConfig from '../../vitest.config';
import integrationConfig from '../../vitest.integration.config';
import slowConfig from '../../vitest.slow.config';
import { workspacePackageSourcesPlugin } from '../vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../../scripts/testing/vitestWorkers';
import { createTestTempDirectory } from '../../../../scripts/testing/process/temporaryDirectories.mjs';

describe('Vitest lane separation', () => {
    it('collects authored tests without treating AppleDouble metadata as test source', async () => {
        const fixture = createTestTempDirectory('happier-cli-test-discovery-');
        try {
            mkdirSync(join(fixture.root, 'src'));
            for (const suffix of ['test.ts', 'integration.test.ts', 'slow.test.ts']) {
                writeFileSync(join(fixture.root, 'src', `example.${suffix}`), 'export {};\n');
                writeFileSync(join(fixture.root, 'src', `._example.${suffix}`), Buffer.from([0, 5, 22, 7]));
            }
            for (const [config, authoredFile] of [
                [unitConfig, 'src/example.test.ts'],
                [integrationConfig, 'src/example.integration.test.ts'],
                [slowConfig, 'src/example.slow.test.ts'],
            ] as const) {
                // Vitest includes dotfiles; Node's globSync does not and would
                // conceal the metadata discovery defect this contract guards.
                const vitest = await createVitest('test', {
                    config: false,
                    root: fixture.root,
                    ...(config.test?.include ? { include: config.test.include } : {}),
                    exclude: config.test?.exclude,
                    watch: false,
                }, { server: { watch: null } });
                try {
                    const collected = (await vitest.globTestSpecifications())
                        .map(spec => relative(fixture.root, spec.moduleId).split(sep).join('/'));
                    expect(collected).toContain(authoredFile);
                    expect(collected.filter(file => file.split('/').some(part => part.startsWith('._'))))
                        .toEqual([]);
                } finally {
                    await vitest.close();
                }
            }
        } finally {
            fixture.cleanup();
        }
    });

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

    it('keeps the source-built workspace-sync test in its fail-closed dedicated lane', () => {
        expect(integrationConfig.test?.exclude).toContain(
            'src/daemon/startup/createDaemonWorkspaceSyncRuntime.real.integration.test.ts',
        );
        expect(integrationConfig.test?.exclude).toContain(
            'src/daemon/peer/iroh/workspaceMachineCarrierMutagen.real.integration.test.ts',
        );

    });

    it('uses the canonical shared-host worker budget in parallel CLI lanes', () => {
        for (const config of [unitConfig, slowConfig]) {
            expect(config.test?.maxWorkers).toBe(resolveVitestWorkers().maxWorkers);
        }
        // Integration deliberately serializes its process/environment mutations.
        expect(integrationConfig.test?.poolOptions?.forks?.singleFork).toBe(true);
    });

    it('does not force full dist builds in the fast CLI test scripts', () => {
        const packageJson = JSON.parse(
            readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
        ) as { scripts?: Record<string, string> };

        const unitLocal = packageJson.scripts?.['test:unit:local'];
        const vitestLocal = packageJson.scripts?.['vitest:local'];
        const fastScripts = [
            unitLocal,
            packageJson.scripts?.['test:integration:local'],
            packageJson.scripts?.['test:slow:local'],
        ].join('\n');

        // The unit lane's post-suite checks (native node:test files + import-cycle guard)
        // run only behind `--unit-checks`; runVitestShards.test.ts proves what that flag runs.
        expect(unitLocal).toContain('node scripts/runVitestShards.mjs --config vitest.config.ts --unit-checks');
        // Each lane selects its own config; a lane on the unit config silently reruns unit specs.
        expect(packageJson.scripts?.['test:integration:local']).toContain('--config vitest.integration.config.ts');
        expect(packageJson.scripts?.['test:slow:local']).toContain('--config vitest.slow.config.ts');
        expect(fastScripts).not.toContain('runPkgrollBuild');
        expect(fastScripts).not.toContain('syncPackageDist');
        expect(fastScripts).not.toContain('syncSharedDepsForDev');
        expect(vitestLocal).not.toContain('syncSharedDepsForDev');

        // pnpm runs `pre*` lifecycle hooks implicitly; none may reintroduce a build.
        expect(packageJson.scripts?.pretest).toBeUndefined();
        expect(packageJson.scripts?.['pretypecheck:local']).toBeUndefined();
        expect(packageJson.scripts?.['typecheck:local']).not.toContain(
            'prepare:declarations',
        );
    });

    it('exposes the CLI runtime import-cycle guard from the repository root', () => {
        const rootPackageJson = JSON.parse(
            readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
        ) as { scripts?: Record<string, string> };

        expect(rootPackageJson.scripts?.['test:import-cycles']).toBe(
            'pnpm --filter @happier-dev/cli run test:import-cycles',
        );
    });

    it('keeps build-output dist verification out of the unit lane', () => {
        expect(
            existsSync(new URL('../buildOutputs.spawnHooks.integration.test.ts', import.meta.url)),
        ).toBe(true);
        expect(
            existsSync(new URL('../buildOutputs.spawnHooks.test.ts', import.meta.url)),
        ).toBe(false);
    });

    it('collects physical workspace consumers only in the prepared integration lane', () => {
        const cwd = fileURLToPath(new URL('../../', import.meta.url));
        const collect = (config: typeof unitConfig) => new Set(globSync(
            config.test?.include ?? [],
            { cwd, exclude: config.test?.exclude ?? [] },
        ));
        const source = collect(unitConfig);
        const integration = collect(integrationConfig);
        for (const owner of [
            'src/plugins/authoring/bundleDaemonRuntime',
            'src/plugins/authoring/sourceModule',
            'src/plugins/authoring/toolchain',
            'src/plugins/scaffold/scaffold',
            'src/plugins/packaging/pack',
            'src/plugins/packaging/packedExternalVoiceProvider.contract',
            'scripts/build-owned/generateBundledPluginEntries',
        ]) {
            expect(source.has(`${owner}.test.ts`), owner).toBe(true);
            expect(source.has(`${owner}.integration.test.ts`), owner).toBe(false);
            expect(integration.has(`${owner}.integration.test.ts`), owner).toBe(true);
            expect(integration.has(`${owner}.test.ts`), owner).toBe(false);
        }
        expect(source.has('src/rpc/handlers/capabilities.test.ts')).toBe(false);
        expect(integration.has('src/rpc/handlers/capabilities.integration.test.ts')).toBe(true);
        for (const owner of [
            'src/plugins/daemon/currentCatalog',
            'src/rpc/handlers/capabilities.probeModes.cwd',
        ]) {
            expect(source.has(`${owner}.test.ts`), owner).toBe(false);
            expect(integration.has(`${owner}.runtimeCatalog.integration.test.ts`), owner).toBe(true);
        }
        // These existing fixtures replace the filesystem boundary, not catalog logic.
        expect(source.has('src/plugins/daemon/currentCatalog.bundled.test.ts')).toBe(true);
        expect(source.has('src/ui/auth.featureAdmission.test.ts')).toBe(true);
    });

    it('uses one export-driven source plugin in every CLI source-test lane', () => {
        for (const config of [
            unitConfig,
            integrationConfig,
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

    it('resolves the canonical host lock from its declared workspace leaf', () => {
        expect(
            workspacePackageSourcesPlugin.resolveId(
                '@happier-dev/cli-common/fs/jsonOwnerFileLock',
            ),
        ).toEqual(expect.stringContaining(
            '/packages/cli-common/src/fs/jsonOwnerFileLock.ts',
        ));
        expect(workspacePackageSourcesPlugin.resolveId(
            '@happier-dev/plugin-sdk/internal/fs/json-owner-file-lock',
        )).toBeNull();
    });
});
