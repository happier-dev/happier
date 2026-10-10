import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { compileUniversalPluginUiCommonJs } from './universalCommonJsCompiler.js';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source: string): Promise<Readonly<{ root: string; entry: string }>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-ui-cjs-'));
    roots.push(root);
    const entry = join(root, 'entry.tsx');
    await writeFile(entry, source, 'utf8');
    return { root, entry };
}

async function installFixturePackage(root: string, packageName: string, marker: string): Promise<void> {
    const packageRoot = join(root, 'node_modules', ...packageName.split('/'));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: packageName,
        type: 'module',
        exports: './index.js',
    }), 'utf8');
    await writeFile(join(packageRoot, 'index.js'), `export const marker = ${JSON.stringify(marker)};`, 'utf8');
}

async function compileFixture(root: string, entry: string, artifactId: string) {
    return compileUniversalPluginUiCommonJs({
        projectRoot: root,
        entryPath: entry,
        artifactId,
        requestedExports: ['renderSurface'],
    });
}

describe('compileUniversalPluginUiCommonJs', () => {
    it('selects actual workspace source when source preparation explicitly requests its condition', async () => {
        const { root, entry } = await fixture("import { marker } from '@happier-dev/source-fixture'; export const renderSurface = () => marker;");
        const packageRoot = join(root, 'node_modules/@happier-dev/source-fixture');
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
            name: '@happier-dev/source-fixture', type: 'module',
            exports: { 'happier-source': './source.ts', default: './dist.js' },
        }));
        await writeFile(join(packageRoot, 'source.ts'), "export const marker = 'actual-source-ui';");
        await writeFile(join(packageRoot, 'dist.js'), "export const marker = 'stale-dist-ui';");
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot: root, entryPath: entry, artifactId: 'source-ui',
            requestedExports: ['renderSurface'], exportConditions: ['happier-source'],
        });
        const output = new TextDecoder().decode(result.bytes);
        expect(output).toContain('actual-source-ui');
        expect(output).not.toContain('stale-dist-ui');
        const canonicalSource = join(root, 'canonical-source.ts');
        await writeFile(canonicalSource, "export const marker = 'canonical-host-source-ui';");
        const canonical = await compileUniversalPluginUiCommonJs({
            projectRoot: root, entryPath: entry, artifactId: 'canonical-ui',
            requestedExports: ['renderSurface'], exportConditions: ['happier-source'],
            resolveSourceImport: (specifier) => specifier === '@happier-dev/source-fixture' ? canonicalSource : undefined,
        });
        expect(new TextDecoder().decode(canonical.bytes)).toContain('canonical-host-source-ui');
        const published = await compileFixture(root, entry, 'published-ui');
        expect(new TextDecoder().decode(published.bytes)).toContain('stale-dist-ui');
    });

    it('emits one minified neutral CommonJS file and keeps only the exact host family external', async () => {
        const { root, entry } = await fixture([
            "import React from 'react';",
            "import { jsx } from 'react/jsx-runtime';",
            "import { jsxDEV } from 'react/jsx-dev-runtime';",
            "import { View } from 'react-native';",
            "import * as Navigation from '@react-navigation/native';",
            "import * as NavigationStack from '@react-navigation/native-stack';",
            "import * as Reanimated from 'react-native-reanimated';",
            "import { PluginUiProvider } from '@happier-dev/plugin-ui';",
            "import * as Components from '@happier-dev/plugin-ui/components';",
            "import * as HostApi from '@happier-dev/plugin-ui/hostApi';",
            "import { usePluginData } from '@happier-dev/plugin-ui/data';",
            "import * as Presentation from '@happier-dev/plugin-ui/presentation';",
            "import * as Environment from '@happier-dev/plugin-ui/environment';",
            "import * as Advanced from '@happier-dev/plugin-ui/advanced';",
            "import * as Client from '@happier-dev/plugin-sdk/ui/client';",
            'export function renderSurface() {',
            '  return [React, jsx, jsxDEV, View, Navigation, NavigationStack, Reanimated, PluginUiProvider, Components, HostApi, usePluginData, Presentation, Environment, Advanced, Client];',
            '}',
        ].join('\n'));

        const result = await compileUniversalPluginUiCommonJs({
            projectRoot: root,
            entryPath: entry,
            artifactId: 'fixture-surface',
            requestedExports: ['renderSurface'],
        });

        expect(result.relativePath).toBe('react-native/fixture-surface/entry.cjs.bundle');
        expect(result.bytes.byteLength).toBeGreaterThan(0);
        expect(result.externalSpecifiers).toEqual([
            '@happier-dev/plugin-sdk/ui/client',
            '@happier-dev/plugin-ui',
            '@happier-dev/plugin-ui/advanced',
            '@happier-dev/plugin-ui/components',
            '@happier-dev/plugin-ui/data',
            '@happier-dev/plugin-ui/environment',
            '@happier-dev/plugin-ui/hostApi',
            '@happier-dev/plugin-ui/presentation',
            '@react-navigation/native',
            '@react-navigation/native-stack',
            'react',
            'react-native',
            'react-native-reanimated',
            'react/jsx-dev-runtime',
            'react/jsx-runtime',
        ]);
        expect(new TextDecoder().decode(result.bytes)).not.toContain('sourceMappingURL');
    });

    it('bundles non-host dependency families instead of publishing them as host externals', async () => {
        const { root, entry } = await fixture([
            "import { marker as zodMarker } from 'zod';",
            "import { marker as protocolMarker } from '@happier-dev/protocol';",
            "import { marker as ajvMarker } from 'ajv';",
            "import { marker as semverMarker } from 'semver';",
            "import { marker as sdkMarker } from '@happier-dev/plugin-sdk';",
            'export const renderSurface = () => [zodMarker, protocolMarker, ajvMarker, semverMarker, sdkMarker];',
        ].join('\n'));
        const markers = [
            ['zod', 'bundled-zod-marker'],
            ['@happier-dev/protocol', 'bundled-protocol-marker'],
            ['ajv', 'bundled-ajv-marker'],
            ['semver', 'bundled-semver-marker'],
            ['@happier-dev/plugin-sdk', 'bundled-sdk-root-marker'],
        ] as const;
        await Promise.all(markers.map(([packageName, marker]) => installFixturePackage(root, packageName, marker)));

        const result = await compileUniversalPluginUiCommonJs({
            projectRoot: root,
            entryPath: entry,
            artifactId: 'bundled-dependencies',
            requestedExports: ['renderSurface'],
        });

        expect(result.externalSpecifiers).toEqual([]);
        const output = new TextDecoder().decode(result.bytes);
        for (const [, marker] of markers) expect(output).toContain(marker);
    });

    it('rejects an unexpected external retained by esbuild before publication', async () => {
        const { root, entry } = await fixture([
            "export const renderSurface = () => import('https://unexpected.example/plugin-ui.js');",
        ].join('\n'));

        await expect(compileUniversalPluginUiCommonJs({
            projectRoot: root,
            entryPath: entry,
            artifactId: 'unexpected-external',
            requestedExports: ['renderSurface'],
        })).rejects.toMatchObject({ code: 'unexpected_external' });
    });

    it('bundles ordinary dependencies and rejects direct react-native-web imports', async () => {
        const { root, entry } = await fixture("import { View } from 'react-native-web'; export const renderSurface = () => View;");
        await expect(compileUniversalPluginUiCommonJs({
            projectRoot: root,
            entryPath: entry,
            artifactId: 'fixture-surface',
            requestedExports: ['renderSurface'],
        })).rejects.toMatchObject({ code: 'direct_react_native_web_import' });
    });

    it('rejects platform-suffixed plugin-owned entries and reachable inputs', async () => {
        const platformEntry = await fixture('export const renderSurface = () => null;');
        const iosEntry = join(platformEntry.root, 'entry.ios.tsx');
        await writeFile(iosEntry, 'export const renderSurface = () => null;', 'utf8');
        await expect(compileFixture(platformEntry.root, iosEntry, 'platform-entry')).rejects.toMatchObject({
            code: 'platform_variant_unsupported',
            message: expect.stringContaining('Platform.OS'),
        });

        const reachableInput = await fixture(
            "import { value } from './value.native'; export const renderSurface = () => value;",
        );
        await writeFile(join(reachableInput.root, 'value.native.ts'), 'export const value = 1;', 'utf8');
        await expect(compileFixture(reachableInput.root, reachableInput.entry, 'platform-input')).rejects.toMatchObject({
            code: 'platform_variant_unsupported',
        });
    });

    it('rejects ambiguous platform siblings of reachable plugin-owned inputs', async () => {
        const { root, entry } = await fixture(
            "import { value } from './value'; export const renderSurface = () => value;",
        );
        await writeFile(join(root, 'value.ts'), 'export const value = 1;', 'utf8');
        await writeFile(join(root, 'value.native.ts'), 'export const value = 2;', 'utf8');

        await expect(compileFixture(root, entry, 'ambiguous-platform-input')).rejects.toMatchObject({
            code: 'platform_variant_ambiguous',
            message: expect.stringContaining('Platform.OS'),
        });
    });

    it('keeps ordinary plugin-local modules and dependency-internal platform variants portable', async () => {
        const { root, entry } = await fixture([
            "import { localValue } from './localValue';",
            "import { marker } from 'portable-dependency';",
            'export const renderSurface = () => [localValue, marker];',
        ].join('\n'));
        await writeFile(join(root, 'localValue.ts'), 'export const localValue = 1;', 'utf8');
        await installFixturePackage(root, 'portable-dependency', 'portable-dependency-marker');
        await writeFile(
            join(root, 'node_modules', 'portable-dependency', 'index.native.js'),
            'export const marker = "dependency-native-marker";',
            'utf8',
        );

        const result = await compileFixture(root, entry, 'portable-ordinary-inputs');

        expect(new TextDecoder().decode(result.bytes)).toContain('portable-dependency-marker');
    });

    it('rejects live Node built-ins and missing requested exports with bounded codes', async () => {
        const nodeBuiltin = await fixture("import fs from 'node:fs'; export const renderSurface = () => fs;");
        await expect(compileUniversalPluginUiCommonJs({
            projectRoot: nodeBuiltin.root,
            entryPath: nodeBuiltin.entry,
            artifactId: 'node-builtin',
            requestedExports: ['renderSurface'],
        })).rejects.toMatchObject({ code: 'node_builtin_unsupported' });

        const missing = await fixture('export const somethingElse = () => null;');
        await expect(compileUniversalPluginUiCommonJs({
            projectRoot: missing.root,
            entryPath: missing.entry,
            artifactId: 'missing-export',
            requestedExports: ['renderSurface'],
        })).rejects.toMatchObject({ code: 'requested_export_missing' });
    });

    it('does not write source maps or sibling chunks', async () => {
        const { root, entry } = await fixture('export const renderSurface = () => null;');
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot: root,
            entryPath: entry,
            artifactId: 'single-output',
            requestedExports: ['renderSurface'],
        });
        expect(result.outputFiles).toHaveLength(1);
        await expect(readFile(join(root, 'entry.cjs.bundle.map'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
