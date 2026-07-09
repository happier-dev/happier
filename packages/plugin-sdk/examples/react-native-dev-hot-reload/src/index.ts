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
        id: 'examples.rnDev.fallback',
        placement: 'session.details',
        target: { kind: 'session', sessionIdPath: '/sessionId' },
        renderer: { kind: 'host', rendererId: 'descriptorPanel' },
        display: {
            titleKey: 'examples.rnDev.unavailableTitle',
            developerFallback: 'RN dev server unavailable',
        },
        actions: [],
        hostActions: [],
    },
});

const nativeBundle = defineSurfaceContribution({
    mode: 'reactNative',
    contribution: {
        id: 'examples.rnDev.panel',
        bundle: {
            platform: 'ios',
            channel: 'development',
        },
        entry: { modulePath: './PluginPanel', exportName: 'PluginPanel' },
        compatibility: {
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.2.0',
            reactNativeVersion: '0.83.4',
            supportedPlatforms: ['ios'],
            supportedChannels: ['development'],
            requiredNativeCapabilities: [],
        },
        hostApi: { minVersion: '1.0.0', methods: ['getSurfaceContext'] },
        nativeCapabilities: [],
        policy: { allowDevHotReload: true },
        fallback: { kind: 'descriptor', descriptorId: fallback.id },
        display: {
            titleKey: 'examples.rnDev.title',
            developerFallback: 'RN dev hot reload example',
        },
    },
});

const placement = defineSurfaceContribution({
    mode: 'surfacePlacement',
    contribution: {
        id: 'examples.rnDev.panelPlacement',
        placement: 'session.details',
        target: { kind: 'session', sessionIdPath: '/sessionId' },
        renderer: {
            kind: 'reactNative',
            contributionId: nativeBundle.id,
            fallback: { kind: 'descriptor', descriptorId: fallback.id },
        },
        display: {
            titleKey: 'examples.rnDev.title',
            developerFallback: 'RN dev hot reload example',
        },
        actions: [],
        hostActions: [],
    },
});

export const manifest = definePluginManifest({
    schemaVersion: 2,
    id: 'examples.react-native-dev-hot-reload',
    version: '0.1.0',
    displayName: 'React Native Dev Hot Reload Example',
    description: 'Development React Native bundle loaded from a local dev server.',
    engines: { happier: '^0.2.0' },
    uses: ['uiDescriptors'],
    entrypoints: { main: './dist/index.js', dev: './src/index.ts' },
    permissions: { required: [], optional: [] },
    source: {
        kind: 'path',
        locator: '.',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
    },
    contributes: {
        uiTranslations: [
            defineUiTranslations({
                locales: {
                    en: {
                        'examples.rnDev.title': 'RN dev hot reload example',
                        'examples.rnDev.unavailableTitle': 'RN dev server unavailable',
                    },
                },
            }),
        ],
        surfacePlacements: [placement, fallback],
        reactNativeBundles: [nativeBundle],
        uiArtifacts: [
            {
                id: 'examples.rnDev.iosDevServer',
                contributionId: nativeBundle.id,
                contributionFamily: 'reactNativeBundles',
                artifactKind: 'reactNativeBundle',
                platform: 'ios',
                channel: 'development',
                compatibility: {
                    hostAppVersion: '2.0.0',
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                    nativeCapabilities: [],
                },
                byteSize: 1,
                contentType: 'application/javascript',
                devUrl: 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true',
            },
        ],
    },
} satisfies PluginManifestV2);
