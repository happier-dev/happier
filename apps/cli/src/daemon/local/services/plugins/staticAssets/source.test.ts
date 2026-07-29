import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginHostedWebSecurityPolicyV1 } from '@happier-dev/protocol/plugins/ui';

import {
    HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH,
    resolveHostedWebStaticAssetLifecycleSource,
} from './source';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

let pluginRoot: string;

const hostedWebSecurity: PluginHostedWebSecurityPolicyV1 = {
    allowedNavigationOrigins: [],
    allowedCallbackOrigins: [],
    allowedConnectOrigins: ['https://api.example.test'],
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

const hostedWebContribution = {
    provenance: 'external' as const,
    source: { kind: 'path' as const },
    pluginId: 'acme.preview',
    pluginRootPath: '',
    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:manifest',
    daemonEntryPath: null,
    sourceSpec: {
        kind: 'path' as const,
        locator: '/plugins/acme',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
    },
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
            titleKey: 'plugin.preview.title',
            developerFallback: 'Preview web',
        },
    },
};

const hostedWebArtifact = {
    provenance: 'external' as const,
    source: { kind: 'path' as const },
    pluginId: 'acme.preview',
    pluginRootPath: '',
    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:manifest',
    daemonEntryPath: null,
    sourceSpec: {
        kind: 'path' as const,
        locator: '/plugins/acme',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
    },
    definition: {
        id: 'preview-web-static',
        contributionId: 'preview-web',
        contributionFamily: 'hostedWeb' as const,
        artifactKind: 'hostedWebAsset' as const,
        platform: 'web' as const,
        channel: 'internal' as const,
        integrity: { digest: 'sha256:web' },
        compatibility: {
            hostAppVersion: '1.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            nativeCapabilities: [],
        },
        byteSize: 2048,
        contentType: 'text/html',
    },
};

type HostedWebStaticAssetSourceRegistry = Pick<ResolvedContributionRegistry, 'hostedWeb' | 'uiArtifacts'>;

function registry(
    overrides: Partial<HostedWebStaticAssetSourceRegistry> = {},
): HostedWebStaticAssetSourceRegistry {
    return {
        hostedWeb: [{
            ...hostedWebContribution,
            pluginRootPath: pluginRoot,
        }],
        uiArtifacts: [{
            ...hostedWebArtifact,
            pluginRootPath: pluginRoot,
        }],
        ...overrides,
    };
}

async function writeUiArtifactsManifest(): Promise<void> {
    const root = join(pluginRoot, HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH);
    await mkdir(join(root, 'hosted-web/preview-web'), { recursive: true });
    await writeFile(join(root, 'ui-artifacts.json'), JSON.stringify({
        version: 1,
        entries: [{
            contributionId: 'preview-web',
            tier: 'hostedWeb',
            platform: 'web',
            entry: 'hosted-web/preview-web/index.html',
            files: [
                {
                    relativePath: 'hosted-web/preview-web/index.html',
                    digest: `sha256:${'a'.repeat(64)}`,
                    byteSize: 1,
                },
                {
                    relativePath: 'hosted-web/preview-web/assets/index.js',
                    digest: `sha256:${'b'.repeat(64)}`,
                    byteSize: 1,
                },
            ],
            digest: 'sha256:web',
            builtWith: { bundler: 'vite', version: '6.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.0.0' },
        }],
    }));
}

describe('hosted-web static asset lifecycle source', () => {
    beforeEach(async () => {
        pluginRoot = await mkdtemp(join(tmpdir(), 'happier-hosted-web-source-'));
        await writeUiArtifactsManifest();
    });

    afterEach(async () => {
        await rm(pluginRoot, { recursive: true, force: true });
    });

    it('maps static hosted-web registry entries to session-scoped lifecycle contributions', async () => {
        const result = await resolveHostedWebStaticAssetLifecycleSource({
            registry: registry(),
            sessionId: 'session-1',
            machineId: 'machine-1',
        });

        expect(result.diagnostics).toEqual([]);
        expect(result.contributions).toEqual([
            expect.objectContaining({
                pluginId: 'acme.preview',
                contributionId: 'preview-web',
                sessionId: 'session-1',
                machineId: 'machine-1',
                title: 'Preview web',
                installedRoot: join(pluginRoot, HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH),
                runtimeMode: {
                    kind: 'installedStaticAssets',
                    artifactId: 'preview-web-static',
                    assetRootId: 'hosted-web/preview-web',
                },
                routeMode: 'pathFallback',
                sourceMaps: {
                    enabled: true,
                    allowedDigests: new Set(['sha256:web']),
                },
                artifact: expect.objectContaining({
                    pluginId: 'acme.preview',
                    artifactKind: 'hostedWebAsset',
                    contributionFamily: 'hostedWeb',
                }),
            }),
        ]);
    });

    it('reports missing artifact or unreadable ui-artifacts manifest without returning unsafe contributions', async () => {
        const missingArtifact = await resolveHostedWebStaticAssetLifecycleSource({
            registry: registry({ uiArtifacts: [] }),
            sessionId: 'session-1',
            machineId: 'machine-1',
        });
        expect(missingArtifact.contributions).toEqual([]);
        expect(missingArtifact.diagnostics).toEqual([
            expect.objectContaining({
                code: 'hosted_web_static_artifact_missing',
                pluginId: 'acme.preview',
                contributionId: 'preview-web',
            }),
        ]);

        await rm(join(pluginRoot, HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH, 'ui-artifacts.json'));
        const missingManifest = await resolveHostedWebStaticAssetLifecycleSource({
            registry: registry(),
            sessionId: 'session-1',
            machineId: 'machine-1',
        });
        expect(missingManifest.contributions).toEqual([]);
        expect(missingManifest.diagnostics).toEqual([
            expect.objectContaining({
                code: 'hosted_web_ui_artifacts_manifest_read_failed',
                pluginId: 'acme.preview',
                contributionId: 'preview-web',
            }),
        ]);
    });
});
