import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluatePortableCommonJs } from '../../test-support/evaluatePortableCommonJs.js';
import { afterEach, describe, expect, it } from 'vitest';

import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import type { PluginSourceSpecV1 } from '@happier-dev/protocol/plugins/source-spec';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../../cli-common/sourceRuntimeEntries.mjs';
import { normalizePluginAccountCollectionMigrationRuntimeProjection } from '../../definePlugin.js';
import { discoverExecutablePluginUiArtifacts } from './manifestArtifactDiscovery.js';
import { compileUniversalPluginUiCommonJs } from './universalCommonJsCompiler.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bundled Collection migration artifacts', () => {
    it('compiles every declaring bundled plugin with its captured manifest and real callbacks', async () => {
        const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
        // Dynamic file loading is the source-tool boundary; keep host files
        // outside this package's TypeScript compilation root.
        const registry: { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: readonly Readonly<{
            pluginId: string; manifest: unknown; sourceSpec: PluginSourceSpecV1;
        }>[] } = await import(pathToFileURL(join(repositoryRoot,
            'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts')).href);
        const packages = await readWorkspacePackages(repositoryRoot);
        const scratch = await mkdtemp(join(tmpdir(), 'happier-collection-artifacts-'));
        roots.push(scratch);
        let declaringPlugins = 0;
        for (const locator of registry.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS) {
            if (locator.sourceSpec.kind !== 'bundled') throw new Error('Expected bundled source');
            const owner = packages.get(locator.sourceSpec.locator);
            if (!owner) throw new Error(`Missing bundled workspace: ${locator.pluginId}`);
            // Capture the current authored declaration, as source preparation
            // does; generated membership does not supply potentially stale bytes.
            const authored = await import(pathToFileURL(join(owner.root, 'src/manifest.ts')).href);
            const manifest = PluginPortableReleaseManifestV1Schema.parse(authored.PLUGIN_MANIFEST);
            if (!manifest.contributes.accountCollections.some((collection) => collection.migrations.length > 0)) continue;
            declaringPlugins += 1;
            const manifestPath = join(scratch, locator.pluginId, 'plugin.json');
            await mkdir(join(scratch, locator.pluginId), { recursive: true });
            await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
            const declarations = await discoverExecutablePluginUiArtifacts(owner.root, manifestPath, ['happier-source']);
            const migrations = declarations.filter((declaration) => declaration.collectionMigrationManifest);
            expect(migrations, locator.pluginId).toHaveLength(1);
            for (const declaration of migrations) {
                const compiled = await compileUniversalPluginUiCommonJs({
                    ...declaration,
                    projectRoot: owner.root,
                    exportConditions: ['happier-source'],
                    resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
                        ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] })
                        : undefined,
                });
                const duplicatedSchemas = Object.values(compiled.metafile.outputs).flatMap(output => Object.entries(output.inputs))
                    .filter(([path, input]) => input.bytesInOutput > 0
                        && /(?:^|[/\\])(?:zod|protocol)(?:[/\\]|@)/u.test(path));
                expect(duplicatedSchemas, locator.pluginId).toHaveLength(0);
                const module = { exports: {} as Record<string, unknown> };
                evaluatePortableCommonJs(new TextDecoder().decode(compiled.bytes), module);
                const factory = module.exports.collectionMigrations;
                if (typeof factory !== 'function') throw new Error('Missing migration artifact factory');
                const payload = factory();
                expect(payload.manifest, locator.pluginId).toEqual(manifest);
                const callbacks = normalizePluginAccountCollectionMigrationRuntimeProjection(
                    payload.collectionMigrations, manifest.contributes.accountCollections,
                );
                for (const entries of Object.values(callbacks)) {
                    for (const migration of entries) {
                        expect(await migration.migrate({ retained: 'value' }, { currentRevision: 1 })).toEqual({ retained: 'value' });
                    }
                }
            }
        }
        expect(declaringPlugins).toBeGreaterThan(0);
    }, 120_000);
});
