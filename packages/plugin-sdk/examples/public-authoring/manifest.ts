import {
    definePluginManifest,
    type PluginManifestV2,
} from '@happier-dev/plugin-sdk';
import {
    defineSessionHeaderAction,
    defineSurfaceContribution,
    defineUiTranslations,
} from '@happier-dev/plugin-sdk/ui';

const display = {
    titleKey: 'review.title',
    descriptionKey: 'review.description',
    iconToken: 'preview',
    tone: 'info',
} as const;

const reviewSurface = defineSurfaceContribution({
    mode: 'surfacePlacement',
    contribution: {
        id: 'examples.publicSdk.reviewPanel',
        placement: 'session.preview',
        target: { kind: 'session', sessionIdPath: '/sessionId' },
        renderer: { kind: 'hostedWeb', contributionId: 'examples.publicSdk.reviewWeb' },
        actions: [],
        hostActions: [],
        display,
    },
});

const reviewHeaderAction = defineSessionHeaderAction({
    id: 'examples.publicSdk.openReviewPanel',
    action: {
        id: 'examples.publicSdk.openReviewPanel',
        kind: 'openSurface',
        labelKey: 'review.open',
        target: { surfaceId: reviewSurface.id },
    },
    display,
    placement: { area: 'primary', overflow: 'auto' },
});

const reviewWeb = defineSurfaceContribution({
    mode: 'hostedWeb',
    contribution: {
        id: 'examples.publicSdk.reviewWeb',
        service: { kind: 'sessionEndpoint', endpointIdPath: '/reviewPreviewEndpointId' },
        entry: { routeMode: 'hostOrigin', path: '/' },
        bridge: { allowedMessages: ['ready', 'heightChanged'] },
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
        fallback: { kind: 'unavailable' },
        display,
    },
});

export const manifest = definePluginManifest({
    schemaVersion: 2,
    id: 'examples.public-sdk-review-assistant',
    version: '0.1.0',
    displayName: 'Public SDK Review Assistant',
    description: 'V2-only public SDK example for action, hook, agent runtime, and UI authoring.',
    engines: {
        happier: '^0.2.0',
    },
    uses: ['actions', 'hooks', 'agents', 'uiDescriptors'],
    entrypoints: {
        main: './daemon.js',
    },
    permissions: {
        required: [],
        optional: [],
    },
    contributes: {
        actions: [
            {
                id: 'examples.publicSdk.reviewSummary',
                title: 'Summarize Review Transcript',
                description: 'Produces a compact summary from the current review transcript.',
                scopes: ['transcript'],
                surfaces: ['cli', 'agent'],
                placement: 'commandPalette',
                dangerLevel: 'safe',
                inputSchema: {
                    type: 'object',
                    properties: {
                        transcript: { type: 'string' },
                        maxBullets: { type: 'integer', minimum: 1, maximum: 8 },
                    },
                    required: ['transcript'],
                    additionalProperties: false,
                },
                resultSchema: {
                    type: 'object',
                    properties: {
                        summary: { type: 'string' },
                        bullets: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['summary', 'bullets'],
                    additionalProperties: false,
                },
                handler: {
                    target: 'daemon',
                    registrationId: 'examples.publicSdk.reviewSummary',
                },
            },
        ],
        hooks: [
            {
                hookApiVersion: 1,
                id: 'agent.response.after',
                category: 'lifecycle',
                scope: 'agent',
                executionKind: 'observe',
                priority: 50,
                handler: {
                    target: 'plugin',
                    exportName: 'observeAgentResponse',
                },
            },
        ],
        lifecycleHandlers: [
            {
                id: 'examples.publicSdk.activation',
                event: 'activated',
                priority: 10,
                handler: {
                    target: 'daemon',
                    registrationId: 'examples.publicSdk.activation',
                },
            },
        ],
        agents: [
            {
                kindVersion: 1,
                id: 'examples.publicSdk.reviewAcp',
                display: {
                    name: 'Public SDK Review Agent',
                    tags: ['example', 'review'],
                },
                catalogAgentId: 'customAcp',
                capabilities: {
                    executionRun: { supported: true },
                },
                runtime: {
                    kind: 'acp',
                    transport: {
                        kind: 'stdio',
                        launch: {
                            kind: 'executable',
                            command: 'acme-review-agent',
                            args: ['acp'],
                        },
                    },
                    ux: {
                        title: 'Acme Review ACP',
                        defaultMode: 'review',
                    },
                    mcp: {
                        policy: 'drop',
                    },
                },
            },
        ],
        uiTranslations: [
            defineUiTranslations({
                locales: {
                    en: {
                        'review.title': 'Review Assistant',
                        'review.description': 'Inspect generated review notes.',
                        'review.open': 'Open review panel',
                    },
                },
            }),
        ],
        surfacePlacements: [reviewSurface],
        sessionHeaderActions: [reviewHeaderAction],
        hostedWeb: [reviewWeb],
        uiDescriptors: [
            {
                id: 'examples.publicSdk.reviewSettings',
                surface: 'settings',
                title: 'Review Assistant',
                description: 'Configure the public SDK review assistant example.',
                tone: 'info',
                fields: [
                    {
                        id: 'enabled',
                        type: 'boolean',
                        title: 'Enabled',
                    },
                    {
                        id: 'defaultProfile',
                        type: 'select',
                        title: 'Default profile',
                        options: [
                            { value: 'fast', label: 'Fast' },
                            { value: 'careful', label: 'Careful' },
                        ],
                    },
                    {
                        id: 'runSummary',
                        type: 'action',
                        title: 'Run summary',
                        actionId: 'examples.publicSdk.reviewSummary',
                    },
                ],
            },
        ],
    },
} satisfies PluginManifestV2);
