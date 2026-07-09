import {
    definePluginManifest,
    type PluginManifestV2,
} from '@happier-dev/plugin-sdk';
import {
    defineSurfaceContribution,
    defineUiTranslations,
} from '@happier-dev/plugin-sdk/ui';

const descriptorFallback = defineSurfaceContribution({
    mode: 'surfacePlacement',
    contribution: {
        id: 'examples.fallback.descriptor',
        placement: 'session.details',
        target: { kind: 'session', sessionIdPath: '/sessionId' },
        renderer: { kind: 'host', rendererId: 'descriptorPanel' },
        display: {
            titleKey: 'examples.fallback.descriptorTitle',
            developerFallback: 'Descriptor fallback',
        },
        actions: [],
        hostActions: [],
    },
});

const hostedWeb = defineSurfaceContribution({
    mode: 'hostedWeb',
    contribution: {
        id: 'examples.fallback.web',
        service: { kind: 'staticAssets', assetRootId: 'hosted-web/fallback' },
        entry: { routeMode: 'pathFallback', path: '/' },
        bridge: { allowedMessages: ['ready'] },
        sandbox: {
            scripts: true,
            sameOrigin: false,
            popups: false,
            topNavigation: false,
            mixedContent: false,
        },
        security: {
            allowedNavigationOrigins: [],
            allowedCallbackOrigins: [],
            allowedConnectOrigins: [],
            csp: {
                scriptSrc: 'selfOnly',
                styleSrc: 'selfOnly',
                imgSrc: 'selfOnly',
                fontSrc: 'selfOnly',
                connectSrc: 'selfOnly',
                allowDataUrls: false,
                allowBlobUrls: false,
                allowInlineStyles: false,
                allowEval: false,
            },
            sourceMaps: 'disabled',
            mixedContent: 'deny',
        },
        fallback: { kind: 'descriptor', descriptorId: descriptorFallback.id },
        display: {
            titleKey: 'examples.fallback.webTitle',
            developerFallback: 'Multi-mode hosted web',
        },
    },
});

const nativeBundle = defineSurfaceContribution({
    mode: 'reactNative',
    contribution: {
        id: 'examples.fallback.native',
        bundle: {
            platform: 'ios',
            channel: 'internal',
            assetPath: 'dist/native/ios.bundle.js',
            integrity: { digest: 'sha256:3522541b808172cee500272fce1054da7a775fe5fab8ab431047b08cb75f98cd' },
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
        fallback: { kind: 'hostedWeb', contributionId: hostedWeb.id },
        display: {
            titleKey: 'examples.fallback.rnTitle',
            developerFallback: 'Multi-mode RN',
        },
    },
});

const placement = defineSurfaceContribution({
    mode: 'surfacePlacement',
    contribution: {
        id: 'examples.fallback.panelPlacement',
        placement: 'session.details',
        target: { kind: 'session', sessionIdPath: '/sessionId' },
        renderer: {
            kind: 'reactNative',
            contributionId: nativeBundle.id,
            fallback: { kind: 'hostedWeb', contributionId: hostedWeb.id },
        },
        display: {
            titleKey: 'examples.fallback.title',
            developerFallback: 'Multi-mode fallback example',
        },
        actions: [],
        hostActions: [],
    },
});

export const manifest = definePluginManifest({
    schemaVersion: 2,
    id: 'examples.multi-mode-fallback',
    version: '0.1.0',
    displayName: 'Multi-Mode Fallback Example',
    description: 'React Native to hostedWeb to descriptor fallback surface.',
    engines: { happier: '^0.2.0' },
    uses: ['uiDescriptors'],
    entrypoints: { main: './dist/index.js' },
    permissions: { required: [], optional: [] },
    contributes: {
        uiTranslations: [
            defineUiTranslations({
                locales: {
                    en: {
                        'examples.fallback.title': 'Multi-mode fallback example',
                        'examples.fallback.descriptorTitle': 'Descriptor fallback',
                        'examples.fallback.webTitle': 'Multi-mode hosted web',
                        'examples.fallback.rnTitle': 'Multi-mode RN',
                    },
                },
            }),
        ],
        surfacePlacements: [placement, descriptorFallback],
        reactNativeBundles: [nativeBundle],
        hostedWeb: [hostedWeb],
        uiArtifacts: [
            {
                id: 'examples.fallback.webArtifact',
                contributionId: hostedWeb.id,
                contributionFamily: 'hostedWeb',
                artifactKind: 'hostedWebAsset',
                platform: 'web',
                channel: 'internal',
                integrity: { digest: 'sha256:25899644ccfc1dc072079141bb227605724d128e04ca98dd8b0c605d3b119013' },
                compatibility: {
                    hostAppVersion: '2.0.0',
                    hostUiApiVersion: '1.0.0',
                    nativeCapabilities: [],
                },
                byteSize: 512,
                contentType: 'text/html',
                assetPath: 'hosted-web/fallback',
            },
            {
                id: 'examples.fallback.nativeArtifact',
                contributionId: nativeBundle.id,
                contributionFamily: 'reactNativeBundles',
                artifactKind: 'reactNativeBundle',
                platform: 'ios',
                channel: 'internal',
                integrity: { digest: 'sha256:3522541b808172cee500272fce1054da7a775fe5fab8ab431047b08cb75f98cd' },
                compatibility: {
                    hostAppVersion: '2.0.0',
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                    nativeCapabilities: [],
                },
                byteSize: 1121,
                contentType: 'application/javascript',
                assetPath: 'dist/native/ios.bundle.js',
            },
        ],
    },
} satisfies PluginManifestV2);
