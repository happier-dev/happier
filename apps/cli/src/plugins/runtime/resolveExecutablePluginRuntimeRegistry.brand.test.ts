import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPluginManifest } from '@/plugins/manifest/read';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const PLUGIN_ID = 'acme.brand-runtime';

function digest(bytes: Uint8Array): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function createPng(): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    return await sharp({
        create: {
            width: 64,
            height: 64,
            channels: 4,
            background: { r: 74, g: 49, b: 132, alpha: 1 },
        },
    }).png().toBuffer();
}

async function seedFixture(writeBrandFile: boolean): Promise<Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    brandBytes: Buffer;
}>> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-brand-runtime-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-brand-runtime-plugin-'));
    const brandBytes = await createPng();
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(pluginRoot, 'assets'), { recursive: true });
    if (writeBrandFile) {
        await writeFile(join(pluginRoot, 'assets', 'brand.png'), brandBytes);
    }
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: '1.0.0',
        displayName: 'Brand runtime fixture',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        brand: { iconResourceId: 'brand-icon' },
        activation: { events: [{ kind: 'startup' }] },
        hostAccess: { required: [], optional: [] },
        contributes: {
            resources: [{
                id: 'brand-icon',
                kind: 'asset',
                path: 'assets/brand.png',
                contentType: 'image/png',
            }],
        },
    }), 'utf8');
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
    });
    return Object.freeze({ happyHomeDir, pluginRoot, brandBytes });
}

async function resolveFixtureRuntimeInputs(fixture: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
}>) {
    const generationAuthority = await readCurrentCommittedPluginGenerations(
        resolvePluginStorePaths({ happyHomeDir: fixture.happyHomeDir }),
        { bundledArtifacts: [], isolateInvalidInstalledGenerations: false },
    );
    const admitted = generationAuthority?.generations.get(PLUGIN_ID);
    if (!generationAuthority || !admitted) {
        throw new Error('Expected the admitted immutable brand fixture generation');
    }
    const manifestPath = join(
        admitted.rootPath,
        ...admitted.record.manifestRelativePath.split('/'),
    );
    const immutableManifest = await readPluginManifest({
        manifestPath,
        manifestAuthority: 'external',
        enforceEngineCompatibility: true,
    });
    if (!immutableManifest.ok) {
        throw new Error(immutableManifest.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    }
    const resourceDefinition = immutableManifest.manifest.contributes.resources
        .find((resource) => resource.id === 'brand-icon');
    if (!resourceDefinition || resourceDefinition.source === 'dynamic') {
        throw new Error('Expected the admitted packaged brand Resource declaration');
    }
    const sourceSpec = {
        kind: 'path' as const,
        locator: fixture.pluginRoot,
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
        resolvedVersion: '1.0.0',
    };
    return Object.freeze({
        generationAuthority,
        contributes: createResolvedContributionRegistry({
            resources: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: PLUGIN_ID,
                pluginRootPath: admitted.rootPath,
                manifestPath,
                daemonEntryPath: join(admitted.rootPath, 'daemon.mjs'),
                sourceSpec,
                definition: {
                    kindVersion: 1,
                    id: resourceDefinition.id,
                    type: resourceDefinition.kind,
                    source: 'packaged',
                    path: resourceDefinition.path,
                    contentType: resourceDefinition.contentType,
                },
            }],
            activationTargets: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: PLUGIN_ID,
                manifestPath,
                daemonEntryPath: join(admitted.rootPath, 'daemon.mjs'),
                sourceSpec,
                activationEvents: ['startup'],
                manifest: immutableManifest.manifest,
            }],
        }),
    });
}

describe('executable plugin portable brand Resource projection', () => {
    it('binds the manifest declaration to the exact admitted immutable Resource facts', async () => {
        const fixture = await seedFixture(true);
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            const inputs = await resolveFixtureRuntimeInputs(fixture);
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: fixture.happyHomeDir,
                contributes: inputs.contributes,
                generationAuthority: inputs.generationAuthority,
            });

            expect(runtime.getPluginBrandAsset?.(PLUGIN_ID)).toEqual({
                state: 'available',
                resource: { pluginId: PLUGIN_ID, localId: 'brand-icon' },
                width: 64,
                height: 64,
                digest: digest(fixture.brandBytes),
            });
            runtime.retirePluginConsumers?.([PLUGIN_ID]);
            expect(runtime.getPluginBrandAsset?.(PLUGIN_ID)).toEqual({ state: 'retired' });
        } finally {
            await runtime?.dispose();
            await rm(fixture.happyHomeDir, { recursive: true, force: true });
            await rm(fixture.pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('retains a runnable plugin and reports a neutral fallback when its declared brand file is unavailable', async () => {
        const fixture = await seedFixture(false);
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            const inputs = await resolveFixtureRuntimeInputs(fixture);
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: fixture.happyHomeDir,
                contributes: inputs.contributes,
                generationAuthority: inputs.generationAuthority,
            });

            expect(runtime.pluginDiagnosticsByPluginId[PLUGIN_ID]).toEqual([]);
            expect(runtime.getPluginBrandAsset?.(PLUGIN_ID)).toEqual({ state: 'missing' });
        } finally {
            await runtime?.dispose();
            await rm(fixture.happyHomeDir, { recursive: true, force: true });
            await rm(fixture.pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);
});
