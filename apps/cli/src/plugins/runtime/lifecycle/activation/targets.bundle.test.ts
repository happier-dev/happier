import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('admits raw registry targets before compiled startup-policy and demand reads', async () => {
    const repoDir = fileURLToPath(new URL('../../../../../../../', import.meta.url));
    const outputDir = await mkdtemp(join(tmpdir(), 'happier-activation-bundle-'));
    try {
        // Source runtime bundles borrow the host's installed dependencies.
        await symlink(join(repoDir, 'node_modules'), join(outputDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        // The repository's source-resolver module is an untyped tooling boundary.
        const { bundleCliSourceSidecars, createWorkspaceSourceResolver, readWorkspacePackages, SOURCE_RUNTIME_COMMONJS_BANNER, SOURCE_RUNTIME_COMMONJS_DEFINE, SOURCE_RUNTIME_OUTPUT_OPTIONS } = await import(
            /* @vite-ignore */ new URL('../../../../../../../packages/cli-common/sourceRuntimeEntries.mjs', import.meta.url).href
        );
        const workspacePackages = await readWorkspacePackages(repoDir);
        const requireFromProject = createRequire(join(repoDir, 'apps/cli/package.json'));
        const entrypoint = join(outputDir, 'package-dist/probe.mjs');
        await mkdir(join(outputDir, 'package-dist'));
        await symlink(join(repoDir, 'apps/cli/node_modules'), join(outputDir, 'package-dist/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        await writeFile(join(outputDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module' }));
        const pluginEntry = join(outputDir, 'conditional.cjs');
        const moduleMarker = join(outputDir, 'module-evaluation.txt');
        await writeFile(pluginEntry, `
            require('node:fs').appendFileSync(${JSON.stringify(moduleMarker)}, 'evaluated\\n');
            exports.activate = api => { api.backgroundServices.register('worker', async () => {}); };
        `);
        await bundleCliSourceSidecars({ repoDir, outputDir: join(outputDir, 'scripts'), build, workspacePackages, requireFromProject });
        await build({
            absWorkingDir: repoDir,
            stdin: { resolveDir: repoDir, sourcefile: 'activation-targets-probe.ts', contents: `
                import assert from 'node:assert/strict';
                import { existsSync, readFileSync } from 'node:fs';
                import { ingestCanonicalPluginManifest } from './apps/cli/src/plugins/manifest/ingest.ts';
                import { createResolvedContributionRegistry } from './apps/cli/src/plugins/projection/registry/createResolvedContributionRegistry.ts';
                import { collectActivationTargets, shouldActivateTargetAtStartup, activationTargetMatchesContributionDemand } from './apps/cli/src/plugins/runtime/lifecycle/activation/targets.ts';
                import { activatePluginRuntimeRegistry } from './apps/cli/src/plugins/runtime/lifecycle/manager.ts';
                const admitted = ingestCanonicalPluginManifest({
                    schemaVersion: 2, id: 'acme.compiled-target', version: '1.0.0', displayName: 'Compiled target',
                    engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.js' },
                    contributes: { actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'],
                        execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
                }, { sourceProvenance: 'registryCustodied' });
                assert.equal(admitted.ok, true);
                if (!admitted.ok) throw new Error('Manifest admission failed');
                const raw = { pluginId: admitted.manifest.id, manifest: admitted.manifest,
                    manifestPath: '/fixture/plugin.json', daemonEntryPath: '/fixture/daemon.js',
                    sourceSpec: { kind: 'path', locator: '/fixture', trustPolicy: 'local_trusted', installPolicy: 'link' } };
                const registry = createResolvedContributionRegistry({ activationTargets: [raw] });
                assert.equal('registrationRights' in registry.activationTargets[0], false);
                const targets = collectActivationTargets(registry);
                assert.equal(targets.length, 1);
                assert.equal(targets[0].registrationRights.length, 1);
                assert.deepEqual(targets.filter(shouldActivateTargetAtStartup), []);
                assert.equal(activationTargetMatchesContributionDemand(targets[0], {
                    pluginId: admitted.manifest.id, family: 'actions', localId: 'run',
                }), true);
                assert.equal(activationTargetMatchesContributionDemand(targets[0], {
                    pluginId: admitted.manifest.id, family: 'actions', localId: 'missing',
                }), false);
                assert.deepEqual(collectActivationTargets(createResolvedContributionRegistry({})), []);
                const conditional = ingestCanonicalPluginManifest({
                    schemaVersion: 2, id: 'acme.conditional', version: '1.0.0', displayName: 'Conditional',
                    engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './conditional.cjs' },
                    activation: { configuration: { accountCollections: [{ pluginId: 'acme.conditional', collectionId: 'configuration' }] } },
                    contributes: { backgroundServices: [{ id: 'worker', title: 'Worker' }] },
                }, { sourceProvenance: 'registryCustodied' });
                assert.equal(conditional.ok, true);
                if (!conditional.ok) throw new Error('Conditional manifest admission failed');
                const conditionalRaw = { ...raw, pluginId: conditional.manifest.id, manifest: conditional.manifest,
                    daemonEntryPath: ${JSON.stringify(pluginEntry)} };
                const runtime = await activatePluginRuntimeRegistry({
                    contributes: createResolvedContributionRegistry({ activationTargets: [conditionalRaw] }), generation: 1,
                    resolveActivationSource: () => ({ kind: 'file_backed', entryPath: ${JSON.stringify(pluginEntry)},
                        trustPolicy: 'prompt', committedAuthorization: { pluginId: conditional.manifest.id, immutableGenerationId: 'compiled-conditional' } }),
                });
                try {
                    assert.equal(existsSync(${JSON.stringify(moduleMarker)}), false);
                    assert.equal(runtime.activatedPluginIds.size, 0);
                    await runtime.activateContributionsOnDemand([{ pluginId: conditional.manifest.id, family: 'backgroundServices', localId: 'worker' }]);
                    assert.equal(runtime.activatedPluginIds.has(conditional.manifest.id), true);
                    assert.equal(readFileSync(${JSON.stringify(moduleMarker)}, 'utf8'), 'evaluated\\n');
                } finally { await runtime.dispose(); }
            ` },
            outfile: entrypoint, bundle: true, platform: 'node', format: 'esm',
            ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
            // Match the retained source runtime's CommonJS bridge inside ESM.
            banner: { js: SOURCE_RUNTIME_COMMONJS_BANNER },
            define: SOURCE_RUNTIME_COMMONJS_DEFINE,
            conditions: ['happier-source'], tsconfig: join(repoDir, 'apps/cli/tsconfig.runtime.json'),
            plugins: [createWorkspaceSourceResolver({
                workspacePackages, requireFromProject,
            })],
        });
        // Preserve the exception rather than Node's entire minified source line.
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
            try { await import(${JSON.stringify(pathToFileURL(entrypoint).href)}); }
            catch (error) { console.error(error.stack); process.exitCode = 1; }
        `], { encoding: 'utf8' });
        expect(child.status, child.stderr).toBe(0);
    } finally {
        await rm(outputDir, { recursive: true, force: true });
    }
});
