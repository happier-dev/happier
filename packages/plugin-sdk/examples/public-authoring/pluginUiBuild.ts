import { defineBuildConfig as defineConfig } from '@happier-dev/plugin-sdk/ui/build';

/**
 * Stable UI build configuration. `outDir` is only the managed bundler's work
 * output. The host-owned builder resolves the matching bundler for each target
 * and stages verified install artifacts into `dist/happier-plugin-ui`; plugin
 * code does not receive a process runner or author a final artifact manifest.
 */
export const pluginUiBuildConfig = defineConfig({
    projectRoot: '.',
    outDir: 'dist/ui',
    targets: [
        {
            rendererId: 'voice-runtime-web',
            entry: 'voiceProvider.ts',
            kind: 'reactNative',
            platforms: ['web'],
        },
        {
            rendererId: 'review-client-actions',
            entry: 'ui/reviewClientActions.ts',
            kind: 'reactNative',
            platforms: ['web', 'ios', 'android'],
            module: {
                containerName: 'examples_public_authoring_review_client_actions',
                modulePath: './activate',
                exportName: 'activate',
            },
        },
        {
            rendererId: 'review-web',
            entry: 'ui/reviewPanel.web.tsx',
            kind: 'hostedWeb',
        },
        {
            rendererId: 'review-openable-web',
            entry: 'ui/reviewPanel.web.tsx',
            kind: 'hostedWeb',
        },
        {
            rendererId: 'review-native',
            entry: 'ui/reviewPanel.native.tsx',
            kind: 'reactNative',
            platforms: ['web', 'ios', 'android', 'desktop'],
            module: {
                containerName: 'examples_public_authoring_review_native',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
        },
        {
            rendererId: 'review-openable-native',
            entry: 'ui/reviewPanel.native.tsx',
            kind: 'reactNative',
            platforms: ['web', 'ios', 'android', 'desktop'],
            module: {
                containerName: 'examples_public_authoring_review_openable_native',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
        },
    ],
});

export default pluginUiBuildConfig;
