import {
    createManagedRuntimeBundlerRunner,
    type PluginBuildUiCliConfigV1,
    type PluginUiBuildSurfaceV1,
} from '@happier-dev/plugin-sdk/ui/build';
import { defineHostedWebViteBuildPreset } from '@happier-dev/plugin-sdk/ui/hostedWebBuild';
import { defineReactNativeRepackBuildPreset } from '@happier-dev/plugin-sdk/ui/reactNativeBuild';
import { defineReactNativeWebViteBuildPreset } from '@happier-dev/plugin-sdk/ui/reactNativeWebBuild';
import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

const hostUiApiVersion = '1.0.0';
const reactVersion = '19.2.0';

const hostedWebSurface: PluginUiBuildSurfaceV1 = {
    kind: 'hostedWeb',
    preset: defineHostedWebViteBuildPreset({
        contributionId: 'examples.publicSdk.reviewWeb',
        sourceEntry: 'ui/reviewPanel.web.tsx',
        viteVersion: '7.0.0',
        hostUiApiVersion,
        reactVersion,
    }),
    hostUiApiVersion,
    reactVersion,
};

const reactNativeSurface: PluginUiBuildSurfaceV1 = {
    kind: 'reactNative',
    preset: defineReactNativeRepackBuildPreset({
        contributionId: 'examples.publicSdk.reviewNative',
        platform: 'ios',
        sourceEntry: 'ui/reviewPanel.native.tsx',
        repackVersion: '5.0.0',
        hostUiApiVersion,
        compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
    }),
    hostUiApiVersion,
    compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
};

// RN-WEB-LOADER / LEDGER DEC-6: the SAME reactNative-mode contribution ships a
// second build surface for the web target — the identical `sourceEntry`
// compiled through Vite + react-native-web instead of Re.Pack. One authoring
// model, one contribution, one more manifest entry (see
// `reactNativeWebBuild.ts`'s doc comment and `uiArtifactsManifest.ts`'s
// `superRefine` branch for the schema side of this).
const reactNativeWebSurface: PluginUiBuildSurfaceV1 = {
    kind: 'reactNative',
    preset: defineReactNativeWebViteBuildPreset({
        contributionId: 'examples.publicSdk.reviewNative',
        sourceEntry: 'ui/reviewPanel.native.tsx',
        viteVersion: '7.3.1',
        hostUiApiVersion,
        compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
    }),
    hostUiApiVersion,
    compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
};

/**
 * Build configuration consumed by `happier-plugin-build-ui`. The bundler runner
 * is constructed through the managed runtime so the author build stays
 * binary-safe (no raw node/npm/npx). The runtime, emitted artifact root, and
 * emitted-file listing are supplied by the author's environment.
 */
export function definePluginUiBuildConfig(input: Readonly<{
    exec: ExecRuntimeServiceV1;
    emittedRoot: string;
    listEmittedFiles: (
        surface: PluginUiBuildSurfaceV1,
        context: Readonly<{ projectRoot: string; emittedRoot: string }>,
    ) => Promise<readonly string[]>;
}>): PluginBuildUiCliConfigV1 {
    return {
        surfaces: [hostedWebSurface, reactNativeSurface, reactNativeWebSurface],
        runBundler: createManagedRuntimeBundlerRunner({
            exec: input.exec,
            emittedRoot: input.emittedRoot,
            listEmittedFiles: input.listEmittedFiles,
        }),
    };
}
