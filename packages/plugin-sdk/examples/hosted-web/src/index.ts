import {
    definePluginManifest,
    type PluginManifestV2,
} from '@happier-dev/plugin-sdk';
import {
    defineSurfaceContribution,
    defineUiTranslations,
} from '@happier-dev/plugin-sdk/ui';

const hostedWebFallback = defineSurfaceContribution({
    mode: 'surfacePlacement',
    contribution: {
        id: 'examples.hostedWeb.fallback',
        placement: 'session.details',
        target: { kind: 'session', sessionIdPath: '/sessionId' },
        renderer: { kind: 'host', rendererId: 'descriptorPanel' },
        display: {
            titleKey: 'examples.hostedWeb.unavailableTitle',
            developerFallback: 'Hosted Web unavailable',
        },
        actions: [],
        hostActions: [],
    },
});

const hostedWeb = defineSurfaceContribution({
    mode: 'hostedWeb',
    contribution: {
        id: 'examples.hostedWeb.panel',
        service: { kind: 'staticAssets', assetRootId: 'hosted-web/panel' },
        entry: { routeMode: 'pathFallback', path: '/' },
        bridge: { allowedMessages: ['ready', 'heightChanged', 'requestSessionResource'] },
        sandbox: { scripts: true, sameOrigin: false, popups: false, topNavigation: false, mixedContent: false },
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
        fallback: { kind: 'descriptor', descriptorId: hostedWebFallback.id },
        display: { titleKey: 'examples.hostedWeb.title', developerFallback: 'Hosted Web Example' },
    },
});

const hostedWebPlacement = defineSurfaceContribution({
    mode: 'surfacePlacement',
    contribution: {
        id: 'examples.hostedWeb.panelPlacement',
        placement: 'session.details',
        target: { kind: 'session', sessionIdPath: '/sessionId' },
        renderer: {
            kind: 'hostedWeb',
            contributionId: hostedWeb.id,
            fallback: { kind: 'descriptor', descriptorId: hostedWebFallback.id },
        },
        display: { titleKey: 'examples.hostedWeb.title', developerFallback: 'Hosted Web Example' },
        actions: [],
        hostActions: [],
    },
});

export const manifest = definePluginManifest({
    schemaVersion: 2,
    id: 'examples.hosted-web',
    version: '0.1.0',
    displayName: 'Hosted Web Example',
    description: 'Hosted-web surface with sandbox bridge and descriptor fallback.',
    engines: { happier: '^0.2.0' },
    uses: ['uiDescriptors'],
    entrypoints: { main: './dist/index.js' },
    permissions: { required: [], optional: [] },
    contributes: {
        uiTranslations: [
            defineUiTranslations({
                locales: {
                    en: {
                        'examples.hostedWeb.title': 'Hosted Web Example',
                        'examples.hostedWeb.unavailableTitle': 'Hosted Web unavailable',
                    },
                },
            }),
        ],
        surfacePlacements: [hostedWebPlacement, hostedWebFallback],
        hostedWeb: [hostedWeb],
        uiArtifacts: [
            {
                id: 'examples.hostedWeb.staticAssets',
                contributionId: hostedWeb.id,
                contributionFamily: 'hostedWeb',
                artifactKind: 'hostedWebAsset',
                platform: 'web',
                channel: 'internal',
                integrity: { digest: 'sha256:9ddb924e911212d50bafdfe806ea745e63315903c3b3cf462dd5236fa02cf103' },
                compatibility: {
                    hostAppVersion: '2.0.0',
                    hostUiApiVersion: '1.0.0',
                    nativeCapabilities: [],
                },
                byteSize: 512,
                contentType: 'text/html',
                assetPath: 'hosted-web/panel',
            },
        ],
    },
} satisfies PluginManifestV2);
