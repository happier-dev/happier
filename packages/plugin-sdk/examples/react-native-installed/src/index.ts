import {
    definePluginManifest,
    type PluginManifestV2,
} from '@happier-dev/plugin-sdk';
import {
    defineSurfaceContribution,
    defineUiTranslations,
} from '@happier-dev/plugin-sdk/ui';

const fallback = defineSurfaceContribution({
    mode: 'surfacePlacement',
    contribution: {
        id: 'examples.rnInstalled.fallback',
        placement: 'session.details',
        target: { kind: 'session', sessionIdPath: '/sessionId' },
        renderer: { kind: 'host', rendererId: 'descriptorPanel' },
        display: {
            titleKey: 'examples.rnInstalled.unavailableTitle',
            developerFallback: 'RN installed unavailable',
        },
        actions: [],
        hostActions: [],
    },
});

const nativeBundle = defineSurfaceContribution({
    mode: 'reactNative',
    contribution: {
        id: 'examples.rnInstalled.panel',
        bundle: {
            platform: 'ios',
            channel: 'internal',
            assetPath: 'dist/native/ios.bundle.js',
            integrity: { digest: 'sha256:c371eaf67a355e31c60653c55ce7b9e91d3cf41ab2fab3020a57a4cc2d3167b9' },
        },
        entry: { modulePath: './PluginPanel', exportName: 'PluginPanel' },
        compatibility: {
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.2.0',
            reactNativeVersion: '0.83.4',
            supportedPlatforms: ['ios'],
            supportedChannels: ['internal'],
            requiredNativeCapabilities: [],
        },
        hostApi: { minVersion: '1.0.0', methods: ['getSurfaceContext'] },
        nativeCapabilities: [],
        fallback: { kind: 'descriptor', descriptorId: fallback.id },
        display: {
            titleKey: 'examples.rnInstalled.title',
            developerFallback: 'RN installed example',
        },
    },
});

const placement = defineSurfaceContribution({
    mode: 'surfacePlacement',
    contribution: {
        id: 'examples.rnInstalled.panelPlacement',
        placement: 'session.details',
        target: { kind: 'session', sessionIdPath: '/sessionId' },
        renderer: {
            kind: 'reactNative',
            contributionId: nativeBundle.id,
            fallback: { kind: 'descriptor', descriptorId: fallback.id },
        },
        display: {
            titleKey: 'examples.rnInstalled.title',
            developerFallback: 'RN installed example',
        },
        actions: [],
        hostActions: [],
    },
});

export const manifest = definePluginManifest({
    schemaVersion: 2,
    id: 'examples.react-native-installed',
    version: '0.1.0',
    displayName: 'React Native Installed Example',
    description: 'Installed React Native bundle with explicit non-default export.',
    engines: { happier: '^0.2.0' },
    uses: ['uiDescriptors'],
    entrypoints: { main: './dist/index.js' },
    permissions: { required: [], optional: [] },
    contributes: {
        uiTranslations: [
            defineUiTranslations({
                locales: {
                    en: {
                        'examples.rnInstalled.title': 'RN installed example',
                        'examples.rnInstalled.unavailableTitle': 'RN installed unavailable',
                    },
                },
            }),
        ],
        surfacePlacements: [placement, fallback],
        reactNativeBundles: [nativeBundle],
        uiArtifacts: [
            {
                id: 'examples.rnInstalled.iosArtifact',
                contributionId: nativeBundle.id,
                contributionFamily: 'reactNativeBundles',
                artifactKind: 'reactNativeBundle',
                platform: 'ios',
                channel: 'internal',
                integrity: { digest: 'sha256:c371eaf67a355e31c60653c55ce7b9e91d3cf41ab2fab3020a57a4cc2d3167b9' },
                compatibility: {
                    hostAppVersion: '2.0.0',
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                    nativeCapabilities: [],
                },
                byteSize: 1116,
                contentType: 'application/javascript',
                assetPath: 'dist/native/ios.bundle.js',
            },
        ],
    },
} satisfies PluginManifestV2);
