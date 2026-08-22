import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    PluginUiArtifactIntegrityBindingV1Schema,
    verifyPluginUiArtifactFileSetIntegrityV1,
} from '@happier-dev/protocol/plugins/ui';

import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createLocalPathPluginDistributionIdentity, createPluginTrustRecord } from '@/plugins/store/install/trustIdentity';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { prepareOwnedImmutablePluginGeneration } from '@/plugins/store/registry/generationStore';
import { PluginStateFileV1Schema } from '@/plugins/store/state';

import { createHostedWebStaticAssetLifecycle } from './lifecycle';
import { resolveHostedWebStaticAssetLifecycleSource } from './source';

const roots: string[] = [];
const pluginId = 'acme.generated-ui-runtime';
const artifactId = 'preview-web-artifact';
const rendererId = 'preview-web-renderer';
const entryPath = `hosted-web/${artifactId}/index.html`;
const assetPath = `hosted-web/${artifactId}/assets/app.js`;

afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function installGeneratedUiPlugin(input?: Readonly<{
    platform?: 'web' | 'android';
}>): Promise<Readonly<{
    happyHomeDir: string;
    installedRoot: string;
    html: string;
}>> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generated-ui-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-generated-ui-source-'));
    roots.push(happyHomeDir, sourceRoot);

    const html = '<!doctype html><html><body>Generated V2 preview</body></html>';
    const app = 'globalThis.generatedPreview = true;';
    const emitted = [
        { relativePath: entryPath, bytes: new TextEncoder().encode(html) },
        { relativePath: assetPath, bytes: new TextEncoder().encode(app) },
    ];
    const digest = computePluginUiArtifactFileSetSha256DigestV1(emitted);
    const manifestPath = join(sourceRoot, '.happier-plugin', 'plugin.json');
    const artifactsRoot = join(sourceRoot, 'dist', 'happier-plugin-ui');
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(artifactsRoot, `hosted-web/${artifactId}/assets`), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Generated UI runtime fixture',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        hostAccess: { required: [], optional: [] },
        contributes: {
            ui: {
                views: [{
                    id: 'preview',
                    container: 'detailsTab',
                    target: { kind: 'session', sessionIdPath: '/session/id' },
                    renderer: rendererId,
                }],
                renderers: [{
                    id: rendererId,
                    kind: 'hostedWeb',
                    source: { kind: 'artifact', artifact: artifactId },
                }],
                translations: [],
            },
        },
    }), 'utf8');
    await writeFile(join(artifactsRoot, 'ui-artifacts.json'), JSON.stringify({
        version: 1,
        entries: [{
            contributionId: artifactId,
            tier: 'hostedWeb',
            platform: input?.platform ?? 'web',
            entry: entryPath,
            files: emitted.map((file) => ({
                relativePath: file.relativePath,
                digest: computePluginUiArtifactSha256DigestV1(file.bytes),
                byteSize: file.bytes.byteLength,
            })),
            digest,
            builtWith: { bundler: 'vite', version: '7.0.0' },
            hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
            compat: {},
        }],
    }), 'utf8');
    await writeFile(join(artifactsRoot, entryPath), html, 'utf8');
    await writeFile(join(artifactsRoot, assetPath), app, 'utf8');

    const distribution = await createLocalPathPluginDistributionIdentity(sourceRoot);
    const trust = createPluginTrustRecord({ pluginId, distribution, approvedAtMs: 1 });
    const catalogRecord = PluginStateFileV1Schema.parse({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
            [pluginId]: {
                source: {
                    kind: 'path',
                    locator: sourceRoot,
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                    resolvedPath: sourceRoot,
                    manifestPath,
                },
                compatibility: { status: 'compatible', diagnostics: [] },
                install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
                state: { enabled: true },
            },
        },
    }).plugins[pluginId]!;
    const store = createPluginRegistryStateStore({
        happyHomeDir,
        runtimeLifecycle: {
            prepare: async () => ({
                abort: async () => undefined,
                adopt: async () => undefined,
            }),
        },
    });
    const preparedGeneration = await prepareOwnedImmutablePluginGeneration({
        paths: store.paths,
        pluginId,
        sourceRootPath: sourceRoot,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution,
        updatePolicy: 'manual',
        createdAtMs: Date.now(),
    });
    try {
        await store.install({
            pluginId,
            catalogRecord,
            trust,
            updatePolicy: 'manual',
            optionalAccess: [],
            preparedGeneration,
        });
    } finally {
        await preparedGeneration.cleanup();
    }
    const installedRoot = (await store.read()).plugins[pluginId]?.install.installedPath;
    if (!installedRoot) throw new Error('Expected committed immutable plugin generation');

    return { happyHomeDir, installedRoot, html };
}

async function resolveGeneratedLifecycleSource(happyHomeDir: string) {
    const registry = await resolveMergedContributionRegistry({ happyHomeDir });
    expect(registry.pluginDiagnosticsByPluginId[pluginId]).toEqual([]);
    expect(registry.uiRenderersV2?.filter((renderer) => renderer.pluginId === pluginId)).toEqual([
        expect.objectContaining({
            definition: expect.objectContaining({ id: rendererId, kind: 'hostedWeb' }),
        }),
    ]);
    expect(registry).not.toHaveProperty('uiArtifacts');
    expect(registry.hostedWeb?.filter((contribution) => contribution.pluginId === pluginId) ?? []).toEqual([]);
    return await resolveHostedWebStaticAssetLifecycleSource({
        registry,
        sessionId: 'session-generated-ui',
        machineId: 'machine-generated-ui',
    });
}

function createLifecycle() {
    return createHostedWebStaticAssetLifecycle({
        verifyArtifact: ({ files, digest }) => {
            const integrity = PluginUiArtifactIntegrityBindingV1Schema.safeParse({
                digest,
                pluginId,
                contributionId: artifactId,
                artifactKind: 'hostedWebAsset',
            });
            if (!integrity.success) {
                return { ok: false as const, reasonCode: 'unsupported_digest' };
            }
            const result = verifyPluginUiArtifactFileSetIntegrityV1({
                files,
                integrity: integrity.data,
            });
            return result.ok
                ? { ok: true as const }
                : { ok: false as const, reasonCode: result.reasonCode };
        },
        registerPreview: async (resource) => resource,
        unregisterPreview: async () => undefined,
    });
}

describe('generated V2 UI installed runtime', () => {
    it('serves a generated artifact from the committed generation and rejects stale or wrong-platform bytes', async () => {
        const installed = await installGeneratedUiPlugin();
        expect(installed.installedRoot).toContain('/generations/');
        const source = await resolveGeneratedLifecycleSource(installed.happyHomeDir);
        expect(source.diagnostics).toEqual([]);
        expect(source.contributions).toEqual([
            expect.objectContaining({
                pluginId,
                contributionId: rendererId,
                installedRoot: await realpath(join(installed.installedRoot, 'dist', 'happier-plugin-ui')),
                runtimeMode: {
                    kind: 'installedStaticAssets',
                    artifactId,
                    assetRootId: `hosted-web/${artifactId}`,
                },
            }),
        ]);

        const lifecycle = createLifecycle();
        const active = await lifecycle.sync(source.contributions);
        expect(active.diagnostics).toEqual([]);
        expect(active.active).toHaveLength(1);
        const response = await fetch(`${active.active[0]!.baseUrl}/`);
        await expect(response.text()).resolves.toBe(installed.html);
        await lifecycle.stop();

        await writeFile(
            join(installed.installedRoot, 'dist', 'happier-plugin-ui', assetPath),
            'globalThis.generatedPreview = false;',
            'utf8',
        );
        const staleLifecycle = createLifecycle();
        const stale = await staleLifecycle.sync(source.contributions);
        expect(stale.active).toEqual([]);
        expect(stale.diagnostics).toEqual([
            expect.objectContaining({ code: 'static_asset_server_start_failed' }),
        ]);
        await staleLifecycle.stop();

        const wrongPlatform = await installGeneratedUiPlugin({ platform: 'android' });
        const rejected = await resolveGeneratedLifecycleSource(wrongPlatform.happyHomeDir);
        expect(rejected.contributions).toEqual([]);
        expect(rejected.diagnostics).toEqual([
            expect.objectContaining({
                pluginId,
                contributionId: rendererId,
                code: 'hosted_web_static_artifact_platform_mismatch',
            }),
        ]);
    });
});
