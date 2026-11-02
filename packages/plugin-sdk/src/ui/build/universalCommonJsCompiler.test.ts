import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext, runInThisContext } from 'node:vm';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileUniversalPluginUiCommonJs } from './universalCommonJsCompiler.js';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../../cli-common/sourceRuntimeEntries.mjs';
import { resolve } from 'node:path';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { derivePluginAccountContributionRegistrationRights, derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createPluginRegistrationScope, readPluginActionInputParser } from '../../host/registration/index.js';
import type { PluginAccountActivationModule } from '../../activation.js';
import { manifest as authoredAccountManifest, activate as activateAuthoredRoot } from '../../../fixtures/account-actions/src/index.js';

const roots: string[] = [];
const moduleResolutionBoundary = vi.hoisted(() => ({ reactUnavailable: false }));

// Module resolution is the OS boundary: isolated SDK-only author installs do
// not contain React, which the invoking host supplies rather than the SDK.
vi.mock('node:module', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:module')>();
    return { ...actual, createRequire(filename: Parameters<typeof actual.createRequire>[0]) {
        const require = actual.createRequire(filename);
        const resolve = require.resolve;
        require.resolve = Object.assign((request: string, options?: Parameters<typeof resolve>[1]) => {
            if (moduleResolutionBoundary.reactUnavailable && request === 'react/package.json') {
                throw Object.assign(new Error("Cannot find module 'react/package.json'"), { code: 'MODULE_NOT_FOUND' });
            }
            return resolve(request, options);
        }, { paths: resolve.paths });
        return require;
    } };
});

afterEach(async () => {
    moduleResolutionBoundary.reactUnavailable = false;
    vi.restoreAllMocks();
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
    it('compiles a portable Account activation entry when the compiler cannot resolve host-provided React', async () => {
        moduleResolutionBoundary.reactUnavailable = true;
        const { root, entry } = await fixture('export function activate() { return { account: true }; }');
        const result = await compileUniversalPluginUiCommonJs({ projectRoot: root, entryPath: entry,
            artifactId: 'account-runtime', requestedExports: ['activate'] });
        expect(result.exports).toEqual(['activate']);
        expect(result.externalSpecifiers).toEqual([]);
    });
    it('admits the Account author fixture package root through ordinary daemon staging without registering Account handlers', async () => {
        const manifest = PluginManifestV2Schema.parse(authoredAccountManifest);
        const scope = createPluginRegistrationScope({ pluginId: manifest.id, target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(manifest.contributes) });
        try {
            await activateAuthoredRoot(scope.api);
            expect(scope.commit()).toEqual([]);
        } finally { await scope.dispose(); }
    });
    it('compiles and activates a separately authored Account plugin through the shared registration owner', async () => {
        const projectRoot = resolve(import.meta.dirname, '../../../fixtures/account-actions');
        const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../..'));
        const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
            exports: Record<string, string>;
        };
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot, entryPath: resolve(projectRoot, packageJson.exports['./happier-plugin-ui/account-runtime']!), artifactId: 'account-runtime',
            requestedExports: ['manifest', 'activate'], exportConditions: ['happier-source'],
            resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
        });
        expect(result.externalSpecifiers).toEqual([]);
        const module = { exports: {} as Record<string, unknown> };
        // UI and CLI portable CommonJS loaders execute in the invoking realm;
        // a separate VM realm would make ordinary host JSON fail prototype admission.
        const evaluate = runInThisContext(`(function(module, exports) { ${new TextDecoder().decode(result.bytes)}\n})`) as (
            module: { exports: Record<string, unknown> }, exports: Record<string, unknown>,
        ) => void;
        evaluate(module, module.exports);
        const manifest = PluginManifestV2Schema.parse(module.exports.manifest);
        expect(manifest).toEqual(PluginManifestV2Schema.parse(authoredAccountManifest));
        const scope = createPluginRegistrationScope({ pluginId: manifest.id,
            target: { realm: 'account', artifactId: 'account-runtime', exportName: 'activate' },
            rights: derivePluginAccountContributionRegistrationRights(manifest.contributes, { artifactId: 'account-runtime', exportName: 'activate' }),
        });
        if (typeof module.exports.activate !== 'function') throw new Error('Missing portable activation export');
        // The independently compiled module is the executable system boundary.
        await (module.exports.activate as PluginAccountActivationModule['activate'])(scope.api);
        const registrations = scope.commit();
        expect(registrations.map((registration) => registration.localId)).toEqual(manifest.contributes.actions.map((action) => action.id));
        const read = registrations.find((registration) => registration.localId === 'read');
        expect(readPluginActionInputParser(read?.value)?.({ key: 'retained' }).success).toBe(true);
        expect(readPluginActionInputParser(read?.value)?.({ key: 'retained', machineId: 'forged' }).success).toBe(false);
        await scope.dispose();
    });
    it('compiles the public-authoring renderer exported to external plugin authors', async () => {
        const projectRoot = resolve(import.meta.dirname, '../../../examples/public-authoring');
        const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
            exports: Record<string, string>;
        };
        const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../..'));
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot,
            entryPath: resolve(projectRoot, manifest.exports['./happier-plugin-ui/review-native']!),
            artifactId: 'review-native', requestedExports: ['renderSurface'],
            exportConditions: ['happier-source'],
            resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native'] }) : undefined,
        });
        expect(result.exports).toContain('renderSurface');
        expect(result.bytes.byteLength).toBeGreaterThan(0);
    });

    it('configures bundled Mini before an authored entry parses during module evaluation', async () => {
        const { root, entry } = await fixture([
            "import { z } from 'zod/mini';",
            "const parsed = z.string().check(z.minLength(3)).safeParse('ab');",
            "export const renderSurface = () => parsed.success ? '' : parsed.error.issues[0].message;",
        ].join('\n'));
        await mkdir(join(root, 'node_modules'), { recursive: true });
        const zodPackageRoot = join(createRequire(import.meta.url).resolve('zod/package.json'), '..');
        await symlink(zodPackageRoot, join(root, 'node_modules', 'zod'), process.platform === 'win32' ? 'junction' : 'dir');
        const result = await compileFixture(root, entry, 'mini-import-time-error');
        const module = { exports: {} as Record<string, unknown> };
        runInNewContext(new TextDecoder().decode(result.bytes), { module, exports: module.exports });
        if (typeof module.exports.renderSurface !== 'function') throw new Error('Missing renderSurface');
        expect(module.exports.renderSurface()).toBe('Too small: expected string to have >=3 characters');
    });

    it.each([
        ['sessions', 'AgentPermissionIntentV1Schema', '"default"', '"default"'],
        ['manifest', 'PluginContributionIdentityV1Schema', '{ pluginId: "happier.triage", localId: "entries" }', '{ pluginId: "happier.triage", localId: "entries" }'],
    ])('bundles a narrow %s parser without unrelated catalog, compilation or signing', async (subpath, schema, value, expected) => {
        const { root, entry } = await fixture(`import { ${schema} } from '@happier-dev/plugin-sdk/${subpath}'; export const renderSurface = () => ${schema}.parse(${value});`);
        const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../..'));
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot: root, entryPath: entry, artifactId: `parser-${subpath}`, requestedExports: ['renderSurface'],
            resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native'] }) : undefined,
        });
        const retained = Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs)
            .filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path));
        expect(retained.filter(path => /[/\\](?:ajv|ajv-formats|semver|tweetnacl|@noble)[/\\]/u.test(path))).toEqual([]);
        const module = { exports: {} as Record<string, unknown> };
        runInNewContext(new TextDecoder().decode(result.bytes), { module, exports: module.exports, TextEncoder, TextDecoder });
        if (typeof module.exports.renderSurface !== 'function') throw new Error('Missing renderSurface');
        expect(module.exports.renderSurface()).toEqual(runInNewContext(`(${expected})`));
    });

    it('bundles Action validation without the unused host catalog, JSON Schema compiler or signing', async () => {
        const { root, entry } = await fixture([
            "import { readActionInputOptionValue, readInputTypePickerLaunchInput, isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';",
            'export const renderSurface = () => ({ value: readActionInputOptionValue({ label: "portable" }), picker: readInputTypePickerLaunchInput({ inputType: { pluginId: "happier.triage", localId: "entries" }, semantic: "entries" }), deferred: isPluginActionApprovalRequestCreated(null) });',
        ].join('\n'));
        const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../..'));
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot: root, entryPath: entry, artifactId: 'action-option',
            requestedExports: ['renderSurface'], exportConditions: ['happier-source'],
            resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native'] }) : undefined,
        });
        const retained = Object.values(result.metafile.outputs).flatMap(output =>
            Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path));
        expect(retained.filter(path => /[/\\](?:ajv|ajv-formats|semver|tweetnacl|@noble)[/\\]/u.test(path))).toHaveLength(0);
        expect(retained.filter(path => /[/\\]actions[/\\]actionSpecs\.(?:ts|js)$/u.test(path))).toHaveLength(0);
        const module = { exports: {} as Record<string, unknown> };
        runInNewContext(new TextDecoder().decode(result.bytes), { module, exports: module.exports, TextEncoder, TextDecoder });
        if (typeof module.exports.renderSurface !== 'function') throw new Error('Missing renderSurface');
        expect(module.exports.renderSurface()).toEqual({ value: { label: 'portable' },
            picker: { inputType: { pluginId: 'happier.triage', localId: 'entries' }, semantic: 'entries' }, deferred: false });
    });

    it.each([
        ['scm', 'SCM_COMMIT_PATCH_MAX_COUNT', 'typeof SCM_COMMIT_PATCH_MAX_COUNT', 'number'],
        ['machine-provisioners', 'MachineProvisionerCheckInputV1Schema', 'MachineProvisionerCheckInputV1Schema.parse({})', {}],
    ])('compiles the pure %s author domain without daemon native adapters', async (subpath, symbol, expression, expected) => {
        const { root, entry } = await fixture(`import { ${symbol} } from '@happier-dev/plugin-sdk/${subpath}'; export const renderSurface = () => ${expression};`);
        const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../..'));
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot: root, entryPath: entry, artifactId: `pure-${subpath}`, requestedExports: ['renderSurface'],
            exportConditions: ['happier-source'],
            resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native'] }) : undefined,
        });
        const module = { exports: {} as Record<string, unknown> };
        runInNewContext(new TextDecoder().decode(result.bytes), { module, exports: module.exports, TextEncoder, TextDecoder, structuredClone });
        if (typeof module.exports.renderSurface !== 'function') throw new Error('Missing renderSurface');
        expect(module.exports.renderSurface()).toEqual(expected);
    });

    it.each([
        ['scm-github', 'src/ui/renderSurface.tsx', 'github-detail-native'],
        ['scm-gitlab', 'src/ui/renderSurface.tsx', 'gitlab-detail-native'],
        ['sentry', 'src/ui/renderSurface.tsx', 'sentry-detail-native'],
        ['triage', 'src/ui/comparisonPicker.tsx', 'triage-comparison-picker-native'],
    ])('compiles the current %s UI artifact through the source author boundary', async (directory, entry, artifactId) => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const repoRoot = resolve(import.meta.dirname, '../../../../..');
        const packages = await readWorkspacePackages(repoRoot);
        const projectRoot = join(repoRoot, 'packages/plugins', directory);
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot, entryPath: join(projectRoot, entry), artifactId, requestedExports: ['renderSurface'],
            exportConditions: ['happier-source'],
            resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native'] }) : undefined,
        });
        expect(result.bytes.byteLength).toBeGreaterThan(0);
        expect(warning).not.toHaveBeenCalledWith(expect.stringContaining('[bundled_host_module]'), expect.anything());
    });

    it.each([
        ['@happier-dev/plugin-ui', 'ansi'],
        ['@happier-dev/plugin-sdk', 'machine-provisioners'],
    ])('keeps the host-provided %s/%s facade outside the artifact', async (packageName, subpath) => {
        const specifier = `${packageName}/${subpath}`;
        const { root, entry } = await fixture(`import { marker } from '${specifier}'; export const renderSurface = () => marker;`);
        const packageRoot = join(root, 'node_modules', packageName);
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
            name: packageName, type: 'module', exports: { [`./${subpath}`]: './index.js' },
        }));
        await writeFile(join(packageRoot, 'index.js'), "export const marker = 'duplicated-host-facade';");
        const result = await compileFixture(root, entry, subpath);
        expect(result.externalSpecifiers).toContain(specifier);
        expect(new TextDecoder().decode(result.bytes)).not.toContain('duplicated-host-facade');
    });

    it('keeps a real Triage text projection free of unused schema and crypto implementations', async () => {
        const { root, entry } = await fixture([
            "import { formatTriageCountV1 } from '@happier-dev/triage-protocol/v1';",
            "export const renderSurface = () => formatTriageCountV1('en-US', 1200, 'compact');",
        ].join('\n'));
        const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../..'));
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot: root, entryPath: entry, artifactId: 'triage-text',
            requestedExports: ['renderSurface'], exportConditions: ['happier-source'],
            resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native'] }) : undefined,
        });
        const retained = Object.values(result.metafile.outputs).flatMap(output =>
            Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path));
        expect(retained.filter(path => /[/\\](?:protocol|zod|ajv|ajv-formats|semver|tweetnacl|@noble)[/\\]/u.test(path))).toEqual([]);
        const module = { exports: {} as Record<string, unknown> };
        runInNewContext(new TextDecoder().decode(result.bytes), { module, exports: module.exports });
        expect(module.exports.renderSurface).toBeTypeOf('function');
        if (typeof module.exports.renderSurface !== 'function') throw new Error('Missing renderSurface');
        expect(module.exports.renderSurface()).toBe('1.2K');
    });

    it('reports a bundled host dependency bypass without refusing a valid artifact', async () => {
        const { root, entry } = await fixture("import { marker } from './node_modules/react/index.js'; export const renderSurface = () => marker;");
        await installFixturePackage(root, 'react', 'duplicated-react-instance');
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await compileFixture(root, entry, 'bundled-host');
        expect(new TextDecoder().decode(result.bytes)).toContain('duplicated-react-instance');
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('[bundled_host_module]'), expect.objectContaining({
            artifactId: 'bundled-host', modules: ['react'],
        }));
    });

    it('does not report host inputs whose code was removed by tree-shaking', async () => {
        const { root, entry } = await fixture("import { marker } from './node_modules/react/index.js'; export const renderSurface = () => 'portable';");
        await installFixturePackage(root, 'react', 'unused-react-instance');
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await compileFixture(root, entry, 'removed-host');
        expect(new TextDecoder().decode(result.bytes)).not.toContain('unused-react-instance');
        expect(warning).not.toHaveBeenCalled();
    });

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

    it.each([
        '@happier-dev/plugin-ui/presentation',
        '@happier-dev/plugin-ui/presentation/typeScale',
    ])('rejects host-private presentation import %s before source resolution', async (specifier) => {
        const { root, entry } = await fixture(`import { marker } from '${specifier}'; export const renderSurface = () => marker;`);
        const privateSource = join(root, 'host-private.ts');
        await writeFile(privateSource, "export const marker = 'host-private-presentation';", 'utf8');

        await expect(compileUniversalPluginUiCommonJs({
            projectRoot: root,
            entryPath: entry,
            artifactId: 'private-presentation',
            requestedExports: ['renderSurface'],
            resolveSourceImport: (requested) => requested === specifier ? privateSource : undefined,
        })).rejects.toMatchObject({
            code: 'host_private_import_unsupported',
            artifactId: 'private-presentation',
            message: expect.stringContaining('@happier-dev/plugin-ui/components'),
        });
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
            "import * as Environment from '@happier-dev/plugin-ui/environment';",
            "import * as Advanced from '@happier-dev/plugin-ui/advanced';",
            "import * as Client from '@happier-dev/plugin-sdk/ui/client';",
            'export function renderSurface() {',
            '  return [React, jsx, jsxDEV, View, Navigation, NavigationStack, Reanimated, PluginUiProvider, Components, HostApi, usePluginData, Environment, Advanced, Client];',
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
