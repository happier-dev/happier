import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

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
    writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-fixture',
        exports: {
            './ui/voice': {
                types: './dist/ui/voice/index.d.ts',
                'react-native': './dist/ui/voice/index.native.js',
                default: './dist/ui/voice/index.js',
            },
        },
    }), 'utf8');
    writeFileSync(resolve(sourceRoot, 'ui', 'voice', 'index.ts'), 'export const platform = \"web\";\n', 'utf8');
    writeFileSync(resolve(sourceRoot, 'ui', 'voice', 'index.native.ts'), 'export const platform = \"native\";\n', 'utf8');
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
