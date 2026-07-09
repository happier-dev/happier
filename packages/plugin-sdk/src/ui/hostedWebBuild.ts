import type { PluginHostedWebContributionV1 } from '@happier-dev/protocol';
import {
    PluginHostedWebSecurityPolicyV1Schema,
    PluginHostedWebRuntimeModeV1Schema,
    PluginUiArtifactsManifestEntryV1Schema,
    type PluginHostedWebSecurityPolicyV1,
    type PluginHostedWebRuntimeModeV1,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    readOutputPathSegment,
    readRelativeBuildPath,
    readRequiredString,
} from './buildPaths.js';

export type HostedWebStaticAssetsBindingV1 = Readonly<{
    contributionId: string;
    hostedWebServiceRef: Extract<PluginHostedWebContributionV1['service'], { kind: 'staticAssets' }>;
    runtimeMode: Extract<PluginHostedWebRuntimeModeV1, { kind: 'installedStaticAssets' }>;
}>;

const HOSTED_WEB_FEATURE_ID = 'plugins.ui.hostedWeb';
const HOSTED_WEB_REQUIRED_FEATURE_IDS = Object.freeze([HOSTED_WEB_FEATURE_ID] as const);
const HOSTED_WEB_BUNDLED_DEPENDENCIES = Object.freeze(['react-native-web'] as const);
const EMPTY_EXTERNALS = Object.freeze([] as const);

export type HostedWebViteBuildPresetInputV1 = Readonly<{
    contributionId: string;
    sourceEntry: string;
    viteVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
}>;

export type HostedWebViteBuildPresetV1 = Readonly<{
    tier: 'hostedWeb';
    bundler: 'vite';
    contributionId: string;
    sourceEntry: string;
    output: Readonly<{
        root: string;
        entry: string;
    }>;
    vite: Readonly<{
        version: string;
        mode: 'app';
        base: './';
        assetsDir: 'assets';
        bundledDependencies: readonly ['react-native-web'];
        external: readonly [];
        sourcemap: false;
    }>;
    security: PluginHostedWebSecurityPolicyV1;
    compatibility: Readonly<{
        hostUiApiVersion: string;
        reactVersion: string;
    }>;
    requiredFeatureIds: readonly [typeof HOSTED_WEB_FEATURE_ID];
}>;

export type HostedWebViteBuildArtifactInputV1 = Readonly<{
    contributionId: string;
    entry: string;
    files: readonly string[];
    digest: string;
    viteVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
}>;

export function defineHostedWebStaticAssets(input: Readonly<{
    contributionId: string;
    artifactId: string;
    assetRootId: string;
}>): HostedWebStaticAssetsBindingV1 {
    const contributionId = readRequiredString(input.contributionId, 'contributionId');
    const artifactId = readRequiredString(input.artifactId, 'artifactId');
    const assetRootId = readRequiredString(input.assetRootId, 'assetRootId');
    const runtimeMode = PluginHostedWebRuntimeModeV1Schema.parse({
        kind: 'installedStaticAssets',
        artifactId,
        assetRootId,
    }) as Extract<PluginHostedWebRuntimeModeV1, { kind: 'installedStaticAssets' }>;

    return Object.freeze({
        contributionId,
        hostedWebServiceRef: Object.freeze({
            kind: 'staticAssets',
            assetRootId,
        }),
        runtimeMode: Object.freeze(runtimeMode),
    });
}

function createDenyByDefaultHostedWebSecurity(): PluginHostedWebSecurityPolicyV1 {
    return PluginHostedWebSecurityPolicyV1Schema.parse({});
}

function readVitePresetInput(input: HostedWebViteBuildPresetInputV1) {
    return {
        contributionId: readOutputPathSegment(input.contributionId, 'contributionId'),
        sourceEntry: readRelativeBuildPath(input.sourceEntry, 'sourceEntry'),
        viteVersion: readRequiredString(input.viteVersion, 'viteVersion'),
        hostUiApiVersion: readRequiredString(input.hostUiApiVersion, 'hostUiApiVersion'),
        reactVersion: readRequiredString(input.reactVersion, 'reactVersion'),
    };
}

export function defineHostedWebViteBuildPreset(
    input: HostedWebViteBuildPresetInputV1,
): HostedWebViteBuildPresetV1 {
    const parsed = readVitePresetInput(input);
    return Object.freeze({
        tier: 'hostedWeb',
        bundler: 'vite',
        contributionId: parsed.contributionId,
        sourceEntry: parsed.sourceEntry,
        output: Object.freeze({
            root: `dist/happier-plugin-ui/hosted-web/${parsed.contributionId}`,
            entry: `hosted-web/${parsed.contributionId}/index.html`,
        }),
        vite: Object.freeze({
            version: parsed.viteVersion,
            mode: 'app',
            base: './',
            assetsDir: 'assets',
            bundledDependencies: HOSTED_WEB_BUNDLED_DEPENDENCIES,
            external: EMPTY_EXTERNALS,
            sourcemap: false,
        }),
        security: createDenyByDefaultHostedWebSecurity(),
        compatibility: Object.freeze({
            hostUiApiVersion: parsed.hostUiApiVersion,
            reactVersion: parsed.reactVersion,
        }),
        requiredFeatureIds: HOSTED_WEB_REQUIRED_FEATURE_IDS,
    });
}

function defineViteBuildArtifact(
    tier: 'hostedWeb',
    input: HostedWebViteBuildArtifactInputV1,
): PluginUiArtifactsManifestEntryV1 {
    const entry = readRelativeBuildPath(input.entry, 'entry');
    const files = input.files.map((file, index) => readRelativeBuildPath(file, `files[${index}]`));

    return PluginUiArtifactsManifestEntryV1Schema.parse({
        contributionId: readRequiredString(input.contributionId, 'contributionId'),
        tier,
        platform: 'web',
        entry,
        files,
        digest: input.digest,
        builtWith: { bundler: 'vite', version: readRequiredString(input.viteVersion, 'viteVersion') },
        hostUiApiVersion: readRequiredString(input.hostUiApiVersion, 'hostUiApiVersion'),
        compat: { react: readRequiredString(input.reactVersion, 'reactVersion') },
    });
}

export function defineHostedWebViteBuildArtifact(
    input: HostedWebViteBuildArtifactInputV1,
): PluginUiArtifactsManifestEntryV1 {
    return defineViteBuildArtifact('hostedWeb', input);
}

export type {
    PluginHostedWebSecurityPolicyV1,
    PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';
