import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    PluginUiArtifactsManifestV1Schema,
    type PluginUiArtifactDigestV1,
    type PluginUiArtifactsManifestV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    defineBuildConfig,
} from '@happier-dev/plugin-sdk/ui/build';

import {
    HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH,
    resolveHostedWebStaticAssetLifecycleSource,
} from './source';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = join(
    HERE,
    '../../../../../plugins/testkit/fixtures/authoring-examples/plugin-ui-portable',
);

const hostUiApiVersion = PLUGIN_UI_HOST_API_VERSION_V1;

let pluginRoot: string;
let builtDigest: PluginUiArtifactDigestV1;
let builtManifest: PluginUiArtifactsManifestV1;

function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

async function buildPortableFixture(): Promise<void> {
    const buildConfig = defineBuildConfig({
        targets: [{
            rendererId: 'preview-web',
            entry: 'ui/reviewPanel.web.tsx',
            kind: 'hostedWeb',
        }],
    });
    const target = buildConfig.targets[0];
    const viteVersion = '7.0.0';
    const sourceBytes = await readFile(join(pluginRoot, 'ui/reviewPanel.web.tsx'));
    const emitted = [
        {
            relativePath: 'hosted-web/preview-web/index.html',
            bytes: encode('<!doctype html><html><body><script type="module" src="./assets/index.js"></script></body></html>'),
        },
        {
            relativePath: 'hosted-web/preview-web/assets/index.js',
            bytes: new Uint8Array(sourceBytes),
        },
    ];
    const digest = computePluginUiArtifactFileSetSha256DigestV1(emitted);
    const manifest = PluginUiArtifactsManifestV1Schema.parse({
        version: 1,
        entries: [{
            contributionId: target.rendererId,
            tier: 'hostedWeb',
            platform: 'web',
            entry: `hosted-web/${target.rendererId}/index.html`,
            files: emitted.map((file) => ({
                relativePath: file.relativePath,
                digest: computePluginUiArtifactSha256DigestV1(file.bytes),
                byteSize: file.bytes.byteLength,
            })),
            digest,
            builtWith: { bundler: 'vite', version: viteVersion },
            hostUiApiVersion,
            compat: {},
        }],
    });
    const artifactsRoot = join(pluginRoot, ...HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH.split('/'));
    for (const file of emitted) {
        const outputPath = join(artifactsRoot, ...file.relativePath.split('/'));
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, file.bytes);
    }
    await writeFile(join(artifactsRoot, 'ui-artifacts.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    builtDigest = digest;
    builtManifest = manifest;
}

function registry(): Pick<ResolvedContributionRegistry, 'uiViewsV2' | 'uiRenderersV2'> {
    const base = {
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId: 'examples.plugin-ui-portable',
        pluginRootPath: pluginRoot,
        manifestPath: join(pluginRoot, '.happier-plugin/plugin.json'),
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'path' as const,
            locator: pluginRoot,
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
        },
    };
    return {
        uiViewsV2: [{
            ...base,
            identity: { pluginId: base.pluginId, localId: 'preview-web-view' },
            definition: {
                id: 'preview-web-view',
                container: 'rightPane',
                target: { kind: 'session' },
                renderer: 'preview-web',
                title: 'Portable preview web',
            },
        }],
        uiRenderersV2: [{
            ...base,
            identity: { pluginId: base.pluginId, localId: 'preview-web' },
            generatedUiArtifactsManifest: builtManifest,
            definition: {
                id: 'preview-web',
                kind: 'hostedWeb',
                source: { kind: 'artifact', artifact: 'preview-web' },
            },
        }],
    } as unknown as Pick<ResolvedContributionRegistry, 'uiViewsV2' | 'uiRenderersV2'>;
}

describe('plugin-ui-portable fixture is consumed by the daemon static-asset source after build', () => {
    beforeEach(async () => {
        pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-ui-portable-'));
        await cp(FIXTURE_SOURCE, pluginRoot, { recursive: true });
        await buildPortableFixture();
    });

    afterEach(async () => {
        await rm(pluginRoot, { recursive: true, force: true });
    });

    it('resolves the built generated hosted-web renderer with zero diagnostics', async () => {
        const result = await resolveHostedWebStaticAssetLifecycleSource({
            registry: registry(),
            sessionId: 'session-1',
            machineId: 'machine-1',
        });

        expect(result.diagnostics).toEqual([]);
        expect(result.contributions).toHaveLength(1);
        expect(result.contributions[0]).toEqual(
            expect.objectContaining({
                pluginId: 'examples.plugin-ui-portable',
                contributionId: 'preview-web',
                installedRoot: join(pluginRoot, HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH),
            }),
        );
    });

    it('writes a ui-artifacts.json whose entry digest matches a recomputation over the built bytes', async () => {
        const manifestRaw = await readFile(
            join(pluginRoot, HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH, 'ui-artifacts.json'),
            'utf8',
        );
        const manifest = JSON.parse(manifestRaw) as { entries: { digest: string }[] };
        expect(manifest.entries[0]?.digest).toBe(builtDigest);
    });
});
