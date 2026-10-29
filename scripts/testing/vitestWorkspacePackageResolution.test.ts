import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile } from 'vite';

import {
    createWorkspacePackageSourcesPlugin,
    readBundledPluginWorkspacePackageSpecs,
    resolveWorkspacePackageSource,
} from './vitestWorkspacePackageResolution.ts';

function writeFixturePackage(): Readonly<{
    packageName: string;
    sourceRoot: string;
}> {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-vitest-workspace-resolution-'));
    const packageRoot = resolve(repoRoot, 'packages', 'plugins', 'fixture');
    const sourceRoot = resolve(packageRoot, 'src');
    mkdirSync(resolve(sourceRoot, 'ui', 'voice'), { recursive: true });
    mkdirSync(resolve(sourceRoot, 'ui', 'public'), { recursive: true });
    writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-fixture',
        imports: {
            '#transport': { node: './dist/transport.node.js', default: './dist/transport.js' },
            '#outside': '../outside.js',
        },
        exports: {
            '.': {
                default: './dist/index.js',
            },
            './ui/voice': {
                types: './dist/ui/voice/index.d.ts',
                'react-native': './dist/ui/voice/index.native.js',
                default: './dist/ui/voice/index.js',
            },
            './ui/public': {
                default: './dist/ui/public/index.js',
            },
            './authored-script': {
                default: './authored-script.cjs',
            },
        },
    }), 'utf8');
    writeFileSync(resolve(sourceRoot, 'index.ts'), 'export const visibility = \"internal\";\n', 'utf8');
    writeFileSync(resolve(sourceRoot, 'index.public.ts'), 'export const visibility = \"public\";\n', 'utf8');
    writeFileSync(resolve(sourceRoot, 'ui', 'voice', 'index.ts'), 'export const platform = \"web\";\n', 'utf8');
    writeFileSync(resolve(sourceRoot, 'ui', 'voice', 'index.native.ts'), 'export const platform = \"native\";\n', 'utf8');
    writeFileSync(resolve(sourceRoot, 'ui', 'public', 'index.ts'), 'export const visibility = \"internal\";\n', 'utf8');
    writeFileSync(resolve(sourceRoot, 'ui', 'public', 'index.public.ts'), 'export const visibility = \"public\";\n', 'utf8');
    writeFileSync(resolve(sourceRoot, 'private.ts'), 'export const privateValue = true;\n', 'utf8');
    writeFileSync(resolve(sourceRoot, 'transport.ts'), 'export const transport = "fetch";\n', 'utf8');
    writeFileSync(resolve(sourceRoot, 'transport.node.ts'), 'export const transport = "node";\n', 'utf8');
    writeFileSync(resolve(packageRoot, 'authored-script.cjs'), 'module.exports = {};\n', 'utf8');
    return Object.freeze({
        packageName: '@happier-dev/plugins-fixture',
        sourceRoot,
    });
}

test('workspace export resolution selects the default source entry by default', () => {
    const fixture = writeFixturePackage();

    assert.equal(
        resolveWorkspacePackageSource(
            `${fixture.packageName}/ui/voice`,
            fixture.packageName,
            fixture.sourceRoot,
        ),
        resolve(fixture.sourceRoot, 'ui', 'voice', 'index.ts'),
    );
});

for (const indexedRoot of [false, true]) {
    test(`workspace export resolution maps ${indexedRoot ? 'indexed' : 'conditional'} dual-mode root entries to authored source`, () => {
        const packageRoot = mkdtempSync(join(tmpdir(), 'happier-vitest-dual-mode-resolution-'));
        const sourceRoot = resolve(packageRoot, 'src');
        mkdirSync(sourceRoot);
        writeFileSync(resolve(sourceRoot, 'index.ts'), 'export const value = true;\n', 'utf8');
        writeFileSync(resolve(sourceRoot, 'private.ts'), 'export const privateValue = true;\n', 'utf8');
        const rootExport = {
            require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
            import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
        };
        writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({
            name: 'dual-mode-fixture',
            exports: indexedRoot ? { '.': rootExport } : rootExport,
        }), 'utf8');

        const sourcePlugins = [[], ['require']].map((exportConditions) =>
            createWorkspacePackageSourcesPlugin(
                [{ packageName: 'dual-mode-fixture', packageSourceRoot: sourceRoot }],
                'dual-mode-fixture-sources',
                { exportConditions },
            ));
        assert.deepEqual(
            sourcePlugins.map((sourcePlugin) => sourcePlugin.resolveId('dual-mode-fixture')),
            [resolve(sourceRoot, 'index.ts'), resolve(sourceRoot, 'index.ts')],
        );
        for (const sourcePlugin of sourcePlugins) {
            assert.equal(sourcePlugin.resolveId('dual-mode-fixture/private'), null);
        }
    });
}

test('workspace export resolution prefers the authored public leaf for declared index entrypoints', () => {
    const fixture = writeFixturePackage();

    assert.equal(
        resolveWorkspacePackageSource(
            fixture.packageName,
            fixture.packageName,
            fixture.sourceRoot,
        ),
        resolve(fixture.sourceRoot, 'index.public.ts'),
    );
    assert.equal(
        resolveWorkspacePackageSource(
            `${fixture.packageName}/ui/public`,
            fixture.packageName,
            fixture.sourceRoot,
        ),
        resolve(fixture.sourceRoot, 'ui', 'public', 'index.public.ts'),
    );
});

test('workspace export resolution follows declared authored files and rejects undeclared source subpaths', () => {
    const fixture = writeFixturePackage();

    assert.equal(
        resolveWorkspacePackageSource(
            `${fixture.packageName}/authored-script`,
            fixture.packageName,
            fixture.sourceRoot,
        ),
        resolve(fixture.sourceRoot, '..', 'authored-script.cjs'),
    );
    assert.equal(
        resolveWorkspacePackageSource(
            `${fixture.packageName}/private`,
            fixture.packageName,
            fixture.sourceRoot,
        ),
        null,
    );
});

test('workspace export resolution selects the react-native source entry when requested', () => {
    const fixture = writeFixturePackage();

    assert.equal(
        createWorkspacePackageSourcesPlugin(
            [{
                packageName: fixture.packageName,
                packageSourceRoot: fixture.sourceRoot,
            }],
            'fixture-react-native-workspace-sources',
            { exportConditions: ['react-native'] },
        ).resolveId(`${fixture.packageName}/ui/voice`),
        resolve(fixture.sourceRoot, 'ui', 'voice', 'index.native.ts'),
    );
});

test('package-private imports resolve in their owning workspace with its conditions', () => {
    const fixture = writeFixturePackage();
    const packages = [{ packageName: fixture.packageName, packageSourceRoot: fixture.sourceRoot }];
    const sourcePlugin = createWorkspacePackageSourcesPlugin(packages);
    const importer = `${resolve(fixture.sourceRoot, 'index.ts')}?import`;
    assert.equal(sourcePlugin.resolveId('#transport', importer), resolve(fixture.sourceRoot, 'transport.ts'));
    assert.equal(
        createWorkspacePackageSourcesPlugin(packages, 'node-source', { exportConditions: ['node'] })
            .resolveId('#transport', importer),
        resolve(fixture.sourceRoot, 'transport.node.ts'),
    );
    assert.equal(sourcePlugin.resolveId('#transport', resolve(fixture.sourceRoot, '..', '..', 'another', 'index.ts')), null);
    assert.equal(sourcePlugin.resolveId('#unknown', importer), null);
    assert.equal(sourcePlugin.resolveId('#outside', importer), null);
});

test('bundled plugin workspace specs derive from the canonical shippable package membership', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-vitest-bundled-workspaces-'));
    const packageRoot = resolve(repoRoot, 'packages', 'plugins', 'fixture');
    const sourceRoot = resolve(packageRoot, 'src');
    mkdirSync(resolve(sourceRoot, 'ui', 'voice'), { recursive: true });
    writeFileSync(resolve(sourceRoot, 'manifest.ts'), 'export const manifest = {};\n', 'utf8');
    writeFileSync(resolve(sourceRoot, 'ui', 'voice', 'index.ts'), 'export const platform = \"web\";\n', 'utf8');
    writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-fixture',
        exports: {
            './ui/voice': {
                default: './dist/ui/voice/index.js',
            },
        },
    }), 'utf8');

    const workspacePackages = readBundledPluginWorkspacePackageSpecs(repoRoot);
    assert.deepEqual(workspacePackages, [{
        packageName: '@happier-dev/plugins-fixture',
        packageSourceRoot: sourceRoot,
    }]);
    assert.equal(
        createWorkspacePackageSourcesPlugin(workspacePackages).resolveId(
            '@happier-dev/plugins-fixture/ui/voice',
        ),
        resolve(sourceRoot, 'ui', 'voice', 'index.ts'),
    );
});

function firstPartyAliases(config: { resolve?: { alias?: unknown } }): readonly unknown[] {
    const aliases = config.resolve?.alias;
    if (Array.isArray(aliases)) {
        return aliases.filter((alias) => (
            alias
            && typeof alias === 'object'
            && 'find' in alias
            && (
                (typeof alias.find === 'string' && alias.find.startsWith('@happier-dev/'))
                || alias.find instanceof RegExp && alias.find.source.includes('@happier-dev')
            )
        ));
    }
    if (aliases && typeof aliases === 'object') {
        return Object.keys(aliases as Record<string, unknown>).filter((alias) => alias.startsWith('@happier-dev/'));
    }
    return [];
}

test('host source aliases follow the importing host through the ordinary UI loader', async (t) => {
    const server = await createServer({
        configFile: resolve('apps/ui/vitest.config.ts'),
        server: { middlewareMode: true, watch: null },
        optimizeDeps: { noDiscovery: true },
        logLevel: 'silent',
    });
    t.after(async () => { await server.close(); });
    const cliImporter = `${resolve('apps/cli/src/daemon/actionOperations/actionOperationStore.ts')}?import`;
    const cliSource = await server.pluginContainer.resolveId('@/daemon/lifecycle/requesterWorkAttribution', cliImporter);
    assert.equal(cliSource?.id, resolve('apps/cli/src/daemon/lifecycle/requesterWorkAttribution.ts'));
    const uiSource = resolve('apps/ui/sources/sync/domains/browser/actions/runtimeActionExecutor.ts');
    for (const importer of [
        resolve('apps/ui/sources/components/browser/surfaces/BrowserSurfaceHost.tsx'),
        resolve('apps/cli/src-other/consumer.ts'),
        undefined,
    ]) {
        const resolved = await server.pluginContainer.resolveId('@/sync/domains/browser/actions/runtimeActionExecutor', importer);
        assert.equal(resolved?.id, uiSource);
    }
});

test('ordinary UI collection loads current Settings metadata from source with poisoned workspace dist', async (t) => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    // Keep dependency lookup in this checkout, while every poisoned byte lives
    // in a disposable replica rather than the shared workspace publication.
    const fixturesRoot = resolve(repoRoot, '.project/tmp');
    mkdirSync(fixturesRoot, { recursive: true });
    const fixtureRoot = mkdtempSync(resolve(fixturesRoot, 'vitest-stale-dist-'));
    t.after(() => { rmSync(fixtureRoot, { recursive: true, force: true }); });
    const uiRoot = resolve(fixtureRoot, 'apps/ui');
    const packageRoot = resolve(fixtureRoot, 'packages/protocol');
    const metadataLeaf = 'actions/settings/builtInSettingsMetadata';
    const sourcePath = resolve(packageRoot, `src/${metadataLeaf}.ts`);
    const distPath = resolve(packageRoot, `dist/${metadataLeaf}.js`);
    const evaluationPath = resolve(fixtureRoot, 'dist-evaluations');
    const sourceEvaluationPath = resolve(fixtureRoot, 'source-evaluations');
    const importId = `@happier-dev/protocol/${metadataLeaf}`;
    mkdirSync(resolve(uiRoot, 'sources'), { recursive: true });
    mkdirSync(resolve(packageRoot, 'src/actions/settings'), { recursive: true });
    mkdirSync(resolve(packageRoot, 'dist/actions/settings'), { recursive: true });
    mkdirSync(resolve(fixtureRoot, 'node_modules/@happier-dev'), { recursive: true });
    symlinkSync(resolve(repoRoot, 'scripts'), resolve(fixtureRoot, 'scripts'), 'junction');
    symlinkSync(packageRoot, resolve(fixtureRoot, 'node_modules/@happier-dev/protocol'), 'junction');
    copyFileSync(resolve(repoRoot, 'apps/ui/vitest.config.ts'), resolve(uiRoot, 'vitest.config.ts'));
    const uiManifest = JSON.parse(readFileSync(resolve(repoRoot, 'apps/ui/package.json'), 'utf8'));
    uiManifest.dependencies['@happier-dev/new-ui-fixture'] = 'workspace:*';
    writeFileSync(resolve(uiRoot, 'package.json'), JSON.stringify(uiManifest));
    const newSourceRoot = resolve(fixtureRoot, 'packages/new-ui-fixture/src');
    mkdirSync(newSourceRoot, { recursive: true });
    writeFileSync(resolve(newSourceRoot, '../package.json'), JSON.stringify({
        name: '@happier-dev/new-ui-fixture', exports: { '.': './dist/index.js' },
    }));
    writeFileSync(resolve(newSourceRoot, 'index.ts'), 'export const currentSource = true;\n');
    for (const entry of readdirSync(resolve(repoRoot, 'packages'), { withFileTypes: true })) {
        if (entry.name === 'protocol') continue;
        symlinkSync(resolve(repoRoot, 'packages', entry.name), resolve(fixtureRoot, 'packages', entry.name), entry.isDirectory() ? 'junction' : 'file');
    }
    copyFileSync(resolve(repoRoot, 'packages/protocol/package.json'), resolve(packageRoot, 'package.json'));
    writeFileSync(sourcePath, [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(sourceEvaluationPath)}, JSON.stringify({ source: import.meta.url, pid: process.pid }) + "\\n");`,
        readFileSync(resolve(repoRoot, `packages/protocol/src/${metadataLeaf}.ts`), 'utf8'),
    ].join('\n'), 'utf8');
    writeFileSync(distPath, [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(evaluationPath)}, "evaluated\\n");`,
        'export const BUILT_IN_SETTINGS_METADATA_V1 = [];',
        'throw new Error("Poisoned first-party dist evaluated");',
    ].join('\n'), 'utf8');
    const collectorPath = resolve(uiRoot, 'sources/settingsMetadataCollection.ts');
    writeFileSync(collectorPath, [
        `import { BUILT_IN_SETTINGS_METADATA_V1 } from ${JSON.stringify(importId)};`,
        'export const encryptionMetadata = BUILT_IN_SETTINGS_METADATA_V1.find(',
        '  (metadata) => metadata.anchor === "account.encryptionMode",',
        ');',
        'if (!encryptionMetadata) throw new Error("Current Settings metadata missing during collection");',
    ].join('\n'), 'utf8');

    const transformedPaths: string[] = [];
    const server = await createServer({
        root: uiRoot,
        configFile: resolve(uiRoot, 'vitest.config.ts'),
        server: { middlewareMode: true, watch: null },
        optimizeDeps: { noDiscovery: true },
        logLevel: 'silent',
        plugins: [{
            name: 'observe-first-party-collection-paths',
            transform(_source, id) { transformedPaths.push(id); },
        }],
    });
    t.after(async () => { await server.close(); });

    const addedDependency = await server.pluginContainer.resolveId('@happier-dev/new-ui-fixture', collectorPath);
    assert.equal(addedDependency?.id, resolve(newSourceRoot, 'index.ts'),
        'a newly declared UI dependency must resolve current source without a second package inventory');
    const resolved = await server.pluginContainer.resolveId(importId, collectorPath);
    assert.equal(resolved?.id, sourcePath);
    const collected = await server.ssrLoadModule(collectorPath);
    assert.equal(collected.encryptionMetadata?.anchor, 'account.encryptionMode');
    assert.ok(transformedPaths.includes(sourcePath), 'the source metadata must actually be transformed and evaluated');
    const distTransforms = transformedPaths.filter((path) => /\/packages\/(?:plugins\/)?[^/]+\/dist\//.test(path));
    assert.deepEqual(distTransforms, []);
    assert.equal(existsSync(evaluationPath), false, 'no first-party dist may evaluate during source collection');
    t.diagnostic(JSON.stringify({ resolvedSource: resolved?.id, evaluatedSource: sourcePath, firstPartyDistEvaluations: 0 }));

    // The ordinary Vitest setup stays intact. Link its real source graph into
    // the replica, retaining the copied metadata leaf and poisoned publication.
    for (const entry of readdirSync(resolve(repoRoot, 'apps/ui/sources'), { withFileTypes: true })) {
        symlinkSync(resolve(repoRoot, 'apps/ui/sources', entry.name), resolve(uiRoot, 'sources', entry.name), entry.isDirectory() ? 'junction' : 'file');
    }
    for (const [parent, retained] of [['', 'actions'], ['actions', 'settings'], ['actions/settings', 'builtInSettingsMetadata.ts']] as const) {
        for (const entry of readdirSync(resolve(repoRoot, 'packages/protocol/src', parent), { withFileTypes: true })) {
            if (entry.name === retained) continue;
            symlinkSync(resolve(repoRoot, 'packages/protocol/src', parent, entry.name), resolve(packageRoot, 'src', parent, entry.name), entry.isDirectory() ? 'junction' : 'file');
        }
    }
    rmSync(sourceEvaluationPath);
    const childTestPath = resolve(uiRoot, 'sources/settingsMetadataCollection.test.ts');
    writeFileSync(childTestPath, [
        'import { expect, it } from "vitest";',
        'import { existsSync, readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        `import { BUILT_IN_SETTINGS_METADATA_V1 } from ${JSON.stringify(importId)};`,
        'it("collects current source metadata while dist is poisoned", () => {',
        '  expect(BUILT_IN_SETTINGS_METADATA_V1.some((metadata) => metadata.anchor === "account.encryptionMode")).toBe(true);',
        `  const evaluations = readFileSync(${JSON.stringify(sourceEvaluationPath)}, "utf8").trim().split("\\n").map((line) => JSON.parse(line));`,
        `  expect(evaluations.some(({ source, pid }) => fileURLToPath(source) === ${JSON.stringify(sourcePath)} && pid === process.pid)).toBe(true);`,
        `  expect(existsSync(${JSON.stringify(evaluationPath)})).toBe(false);`,
        '});',
    ].join('\n'), 'utf8');
    const childResultPath = resolve(fixtureRoot, 'vitest-result.json');
    const child = spawnSync(process.execPath, [
        resolve(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run',
        'sources/settingsMetadataCollection.test.ts', '--config', resolve(uiRoot, 'vitest.config.ts'),
        '--reporter=json', '--outputFile', childResultPath,
    ], { cwd: uiRoot, encoding: 'utf8' });
    // Do not print child setup/fixture output: it can contain credential-shaped
    // values from unrelated canonical UI boundary fixtures.
    assert.equal(child.error, undefined, 'the real Vitest child must launch');
    assert.equal(child.status, 0, `the real Vitest child must pass (signal=${child.signal})`);
    const childResult = JSON.parse(readFileSync(childResultPath, 'utf8')) as { numPassedTests: number; numFailedTests: number };
    assert.equal(childResult.numPassedTests, 1);
    assert.equal(childResult.numFailedTests, 0);
    const childEvaluations = readFileSync(sourceEvaluationPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { source: string; pid: number });
    assert.ok(childEvaluations.some(({ source, pid }) => fileURLToPath(source) === sourcePath && pid !== process.pid));
    assert.equal(existsSync(evaluationPath), false, 'the real Vitest child must evaluate zero poisoned dist modules');
    t.diagnostic(JSON.stringify({ vitestChildPassedTests: childResult.numPassedTests, evaluatedSource: childEvaluations.map(({ source }) => fileURLToPath(source)), firstPartyDistEvaluations: 0 }));

    // This control proves the fixture is executable poison, not an absent dist
    // file or a marker that the loader could silently ignore.
    await assert.rejects(server.ssrLoadModule(distPath), /Poisoned first-party dist evaluated/);
    assert.equal(readFileSync(evaluationPath, 'utf8'), 'evaluated\n');
});

test('ordinary workspace-source Vitest configs use the canonical resolver instead of package aliases', async () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const [
        uiArtifactCacheConfig,
        pluginSdkFacadeCurrentConfig,
        pluginSdkSourceConfig,
        piRealOwnersConfig,
        piSpawnedRealOwnersConfig,
        qaFixturesConfig,
        voiceModelpacksDirectSourceConfig,
        serverUnitConfig,
    ] = await Promise.all([
        'apps/ui/vitest.artifact-cache.config.ts',
        'packages/plugin-sdk/vitest.facade-current.config.ts',
        'packages/plugin-sdk/vitest.source.config.ts',
        'packages/plugins/pi/vitest.realOwners.config.ts',
        'packages/plugins/pi/vitest.spawnedRealOwners.config.ts',
        'packages/tests/vitest.qa-fixtures.config.ts',
        'packages/voice-modelpacks/vitest.direct-source.config.ts',
        'apps/server/vitest.config.ts',
    ].map(async (configPath) => {
        // Authored Vitest configs are evaluated by Vite, including their source
        // policy dependencies; native Node imports are not that loading contract.
        const loaded = await loadConfigFromFile(
            { command: 'serve', mode: 'test' }, resolve(repoRoot, configPath), repoRoot,
        );
        assert.ok(loaded, `Vite did not load ${configPath}`);
        return loaded.config;
    }));
    for (const { config, pluginName, importId, expectedSourcePath, additionalImports = [] } of [
        {
            config: serverUnitConfig,
            pluginName: 'happier-server-workspace-package-sources',
            importId: '@happier-dev/peer-transport/duplexFrames',
            expectedSourcePath: '/packages/peer-transport/src/duplexFrames/index.ts',
            additionalImports: [
                ['@happier-dev/plugin-ui/environment', '/packages/plugin-ui/src/environment/index.public.ts'],
                ['@happier-dev/plugin-ui/presentation', '/packages/plugin-ui/src/presentation/index.public.ts'],
                ['@happier-dev/plugin-ui/declarative', '/packages/plugin-ui/src/declarative/index.public.ts'],
                ['@happier-dev/brand/planet', '/packages/brand/planet.mjs'],
            ],
        },
        {
            config: uiArtifactCacheConfig,
            pluginName: 'happier-ui-artifact-cache-workspace-package-sources',
            importId: '@happier-dev/protocol/plugins/ui/client',
            expectedSourcePath: '/packages/protocol/src/plugins/ui/client.ts',
        },
        {
            config: pluginSdkFacadeCurrentConfig,
            pluginName: 'happier-plugin-sdk-facade-current-workspace-package-sources',
            importId: '@happier-dev/protocol/plugins/actions/json-schema-validation',
            expectedSourcePath: '/packages/protocol/src/plugins/actions/jsonSchemaValidation.ts',
        },
        {
            config: pluginSdkSourceConfig,
            pluginName: 'happier-plugin-sdk-source-workspace-package-sources',
            importId: '@happier-dev/plugin-sdk',
            expectedSourcePath: '/packages/plugin-sdk/src/index.public.ts',
            additionalImports: [
                ['@happier-dev/protocol', '/packages/protocol/src/index.ts'],
            ],
        },
        {
            config: piRealOwnersConfig,
            pluginName: 'happier-pi-real-owners-workspace-package-sources',
            importId: '@happier-dev/cli-common/process',
            expectedSourcePath: '/packages/cli-common/src/process/index.ts',
            additionalImports: [
                ['@happier-dev/agents', '/packages/agents/src/index.ts'],
                ['@happier-dev/plugin-sdk', '/packages/plugin-sdk/src/index.public.ts'],
                ['@happier-dev/protocol', '/packages/protocol/src/index.ts'],
                ['@happier-dev/tests/testkit/tls/ephemeralTlsServerFixture', '/packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs'],
            ],
        },
        {
            config: piSpawnedRealOwnersConfig,
            pluginName: 'happier-pi-spawned-real-owners-workspace-package-sources',
            importId: '@happier-dev/cli-common/process',
            expectedSourcePath: '/packages/cli-common/src/process/index.ts',
            additionalImports: [
                ['@happier-dev/agents', '/packages/agents/src/index.ts'],
                ['@happier-dev/plugin-sdk', '/packages/plugin-sdk/src/index.public.ts'],
                ['@happier-dev/protocol', '/packages/protocol/src/index.ts'],
                ['@happier-dev/tests/testkit/tls/ephemeralTlsServerFixture', '/packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs'],
            ],
        },
        {
            config: qaFixturesConfig,
            pluginName: 'happier-qa-fixtures-workspace-package-sources',
            importId: '@happier-dev/protocol',
            expectedSourcePath: '/packages/protocol/src/index.ts',
        },
        {
            config: voiceModelpacksDirectSourceConfig,
            pluginName: 'happier-voice-modelpacks-workspace-package-sources',
            importId: '@happier-dev/protocol',
            expectedSourcePath: '/packages/protocol/src/index.ts',
        },
    ]) {
        const plugin = config.plugins?.find((candidate) => (
            candidate
            && typeof candidate === 'object'
            && 'name' in candidate
            && candidate.name === pluginName
        )) as { resolveId?: (id: string) => string | null } | undefined;

        assert.equal(firstPartyAliases(config).length, 0);
        assert.match(plugin?.resolveId?.(importId) ?? '', new RegExp(`${expectedSourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
        for (const [additionalImportId, additionalExpectedSourcePath] of additionalImports) {
            assert.match(
                plugin?.resolveId?.(additionalImportId) ?? '',
                new RegExp(`${additionalExpectedSourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
            );
        }
    }
});
