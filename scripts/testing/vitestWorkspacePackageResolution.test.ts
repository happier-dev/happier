import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import uiArtifactCacheConfig from '../../apps/ui/vitest.artifact-cache.config.ts';
import pluginSdkFacadeCurrentConfig from '../../packages/plugin-sdk/vitest.facade-current.config.ts';
import pluginSdkSourceConfig from '../../packages/plugin-sdk/vitest.source.config.ts';
import piRealOwnersConfig from '../../packages/plugins/pi/vitest.realOwners.config.ts';
import piSpawnedRealOwnersConfig from '../../packages/plugins/pi/vitest.spawnedRealOwners.config.ts';
import qaFixturesConfig from '../../packages/tests/vitest.qa-fixtures.config.ts';
import voiceModelpacksDirectSourceConfig from '../../packages/voice-modelpacks/vitest.direct-source.config.ts';

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

test('ordinary workspace-source Vitest configs use the canonical resolver instead of package aliases', () => {
    for (const { config, pluginName, importId, expectedSourcePath, additionalImports = [] } of [
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
