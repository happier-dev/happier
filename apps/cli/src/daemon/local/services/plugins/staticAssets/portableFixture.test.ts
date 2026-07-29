import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    PluginUiArtifactsManifestV1Schema,
    type PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    definePluginUiBuildConfig,
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

const hostUiApiVersion = '1.0.0';
const reactVersion = '19.0.0';

const hostedWebSecurity: PluginHostedWebSecurityPolicyV1 = {
    allowedNavigationOrigins: [],
    allowedCallbackOrigins: [],
    allowedConnectOrigins: [],
    csp: {
        scriptSrc: 'selfOnly',
        styleSrc: 'selfOnly',
        imgSrc: 'selfOnly',
        fontSrc: 'selfOnly',
        connectSrc: 'declaredOrigins',
        allowDataUrls: false,
        allowBlobUrls: false,
        allowInlineStyles: false,
        allowEval: false,
    },
    sourceMaps: 'declaredDigestOnly',
    mixedContent: 'deny',
};

let pluginRoot: string;
let builtDigest: string;

function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

async function buildPortableFixture(): Promise<void> {
    const buildConfig = definePluginUiBuildConfig({
        targets: [{
            rendererId: 'preview-web',
            entry: 'ui/reviewPanel.web.tsx',
            kind: 'hostedWeb',
            platforms: ['web'],
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
            compat: { react: reactVersion },
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
}

function registry(): Pick<ResolvedContributionRegistry, 'hostedWeb' | 'uiArtifacts'> {
    const base = {
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId: 'examples.plugin-ui-portable',
        pluginRootPath: pluginRoot,
        manifestPath: join(pluginRoot, '.happier-plugin/plugin.json'),
        manifestDigest: 'sha256:manifest',
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'path' as const,
            locator: pluginRoot,
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
        },
    };
    return {
        hostedWeb: [{
            ...base,
            definition: {
                id: 'preview-web',
                service: { kind: 'staticAssets' as const, assetRootId: 'hosted-web/preview-web' },
                entry: { routeMode: 'pathFallback' as const, path: '/' },
                bridge: { allowedMessages: ['ready' as const] },
                sandbox: {
                    scripts: true,
                    sameOrigin: false,
                    popups: false,
                    topNavigation: false,
                    mixedContent: false,
                },
                security: hostedWebSecurity,
                fallback: { kind: 'unavailable' as const },
                display: {
                    titleKey: 'plugin.portable.title',
                    developerFallback: 'Portable preview web',
                },
            },
        }],
        uiArtifacts: [{
            ...base,
            definition: {
                id: 'preview-web-static',
                contributionId: 'preview-web',
                contributionFamily: 'hostedWeb' as const,
                artifactKind: 'hostedWebAsset' as const,
                platform: 'web' as const,
                channel: 'internal' as const,
                integrity: { digest: builtDigest },
                compatibility: {
                    hostAppVersion: '1.0.0',
                    hostUiApiVersion,
                    reactVersion,
                    nativeCapabilities: [],
                },
                byteSize: 1024,
                contentType: 'text/html',
            },
        }],
    };
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

    it('resolves the built hosted-web contribution with zero manifest-read-failed diagnostics', async () => {
        const result = await resolveHostedWebStaticAssetLifecycleSource({
            registry: registry(),
            sessionId: 'session-1',
            machineId: 'machine-1',
        });

        expect(
            result.diagnostics.filter(
                (entry) => entry.code === 'hosted_web_ui_artifacts_manifest_read_failed',
            ),
        ).toEqual([]);
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
