import {
    defineComposerAttachment,
    defineComposerControl,
    defineComposerReference,
    defineComposerRegion,
    type DefinePluginInput,
} from '@happier-dev/plugin-sdk';
import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import type { PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import type { PluginAgentDefinition } from '@happier-dev/plugin-sdk/agents';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import type { PromptAssetContribution } from '@happier-dev/plugin-sdk/resources';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import { PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 } from '@happier-dev/plugin-sdk/ui';
import { VoiceCredentialSlotIdSchema } from '@happier-dev/plugin-sdk/voice';

import { createReviewAgentRuntime } from './agent/runtime.js';
import {
    observeSessionSpawned,
    reviewAgentRunnerFactory,
    projectCompanionDashboardResource,
    reviewReferenceProvider,
    reviewSessionStatusCollection,
    reviewSessionStatusResource,
    resolveAgentContextCompanionComposition,
    runExternalSessionDigest,
    runReviewSummary,
} from './daemon.js';
import { speechToTextRuntime, textToSpeechRuntime } from './voiceSpeechProvider.js';

/**
 * The single public-authoring source of truth. `happier plugins dev build`
 * projects this declaration into its staged `.happier-plugin/plugin.json` and
 * the matching activation module; no handwritten manifest or activation path
 * remains beside it.
 */
type PublicAuthoringActions = Readonly<Record<
    | 'review-summary'
    | 'external-session-digest'
    | 'open-review-status'
    | 'open-review-status-web-only-fixture',
    PluginActionDeclaration
>>;
type PublicAuthoringAgents = Readonly<Record<'review-agent', PluginAgentDefinition>>;
type PublicAuthoringPromptAssets = Readonly<Record<
    'agent-context-companion-prompt',
    Omit<PromptAssetContribution, 'id' | 'adapterDescriptor'>
>>;
type PublicAuthoringAccountCollections = Readonly<Record<
    'review-session-statuses',
    PluginAccountCollectionDefinition
>>;
type PublicAuthoringDefinition = DefinePluginInput<
    PublicAuthoringActions,
    PublicAuthoringAgents,
    PublicAuthoringPromptAssets,
    PublicAuthoringAccountCollections,
    'examples.public-sdk-review-assistant'
>;

const MEDIATED_VOICE_CREDENTIAL_SLOT_ID = VoiceCredentialSlotIdSchema.parse('api_key');
const RAW_VOICE_CREDENTIAL_SLOT_ID = VoiceCredentialSlotIdSchema.parse('raw_key');

export const publicAuthoringDefinition: PublicAuthoringDefinition = {
    id: 'examples.public-sdk-review-assistant',
    version: '0.1.0',
    displayName: 'Public SDK Review Assistant',
    description: 'Kitchen-sink public SDK example for actions, hooks, native Agent runtime, UI, and descriptor authoring.',
    runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime) as 1 },
    entrypoints: { daemon: './dist/daemon.js' },
    hostAccess: {
        required: [
            {
                id: 'review-agent-process',
                capability: 'process',
                reason: 'Launch the example review ACP agent through host-mediated execution.',
                scope: {
                    executables: [{ kind: 'systemTool', id: 'acme-review-agent' }],
                },
            },
            {
                id: 'model-pack-downloads',
                capability: 'network',
                reason: 'Download the declared example model-pack files and license metadata.',
                scope: {
                    targets: [{ kind: 'fixedOrigin', origin: 'https://models.example.com' }],
                },
            },
            {
                id: 'voice-client-auth',
                capability: 'network',
                reason: 'Exchange the host-owned account credential for a short-lived synthetic Voice client artifact.',
                scope: {
                    targets: [{ kind: 'fixedOrigin', origin: 'https://voice.example.test' }],
                    methods: ['POST'],
                },
            },
            {
                id: 'voice-catalog',
                capability: 'network',
                reason: 'Read the bounded synthetic Voice catalog.',
                scope: {
                    targets: [{ kind: 'fixedOrigin', origin: 'https://voice.example.test' }],
                    methods: ['GET'],
                },
            },
            {
                id: 'review-resource-account',
                capability: 'storage.account',
                reason: 'Read the declared Account review status for the current Session.',
                scope: { enabled: true },
            },
            {
                id: 'external-session-read',
                capability: 'sessions',
                reason: 'List external Agent sessions and read their transcripts to digest them.',
                scope: { access: ['read'] },
            },
        ],
        optional: [],
    },
    actions: {
        'review-summary': {
            title: 'Summarize review transcript',
            description: 'Produces a compact summary from the current review transcript.',
            scopes: ['global'],
            surfaces: ['cli', 'agent', 'ui'],
            execution: { target: 'daemon' },
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
            inputSchema: defineProtocolObject({
                transcript: defineProtocolString().optional(),
                maxBullets: defineProtocolNumber({ integer: true, minimum: 1, maximum: 8 }).optional(),
            }, { policy: 'closed' }),
            resultSchema: defineProtocolObject({
                summary: defineProtocolString(),
                bullets: defineProtocolArray(defineProtocolString()),
            }, { policy: 'closed' }),
            run: runReviewSummary,
        },
        'external-session-digest': {
            title: 'Digest external Agent sessions',
            description: 'Reads external Agent session transcripts through the host and reports a bounded per-session digest.',
            scopes: ['global'],
            surfaces: ['cli', 'agent', 'ui'],
            execution: { target: 'daemon' },
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
            inputSchema: defineProtocolObject({
                agentId: defineProtocolString().optional(),
                maxCandidates: defineProtocolNumber({ integer: true, minimum: 1, maximum: 10 }).optional(),
                maxItems: defineProtocolNumber({ integer: true, minimum: 1, maximum: 50 }).optional(),
            }, { policy: 'closed' }),
            resultSchema: defineProtocolObject({
                outcome: defineProtocolString(),
                reason: defineProtocolString().nullable(),
                entries: defineProtocolArray(defineProtocolObject({
                    title: defineProtocolString(),
                    agentTurns: defineProtocolNumber({ integer: true, minimum: 0 }),
                    userTurns: defineProtocolNumber({ integer: true, minimum: 0 }),
                    // No boolean builder is published; a closed two-literal
                    // union is the declaration-level way to say the same thing.
                    truncated: defineProtocolUnion([
                        defineProtocolLiteral(true),
                        defineProtocolLiteral(false),
                    ]),
                }, { policy: 'closed' })),
            }, { policy: 'closed' }),
            run: runExternalSessionDigest,
        },
        'open-review-status': {
            title: 'Open review status',
            description: 'Opens the existing review-status destination on this client.',
            surfaces: ['ui', 'voice'],
            execution: {
                target: 'client',
                client: {
                    artifactId: 'review-client-actions',
                    modulePath: './activate',
                    exportName: 'activate',
                },
                platforms: ['web', 'ios', 'android'],
            },
            dangerLevel: 'safe',
        },
        // This retained source fixture makes unsupported platform admission
        // explicit without making the review-status Action itself web-only.
        'open-review-status-web-only-fixture': {
            title: 'Open review status (web-only fixture)',
            description: 'Deliberately web-only client Action fixture for typed unavailable admission.',
            surfaces: ['ui', 'voice'],
            execution: {
                target: 'client',
                client: {
                    artifactId: 'voice-runtime-web',
                    modulePath: './voiceProvider',
                    exportName: 'activate',
                },
                platforms: ['web'],
            },
            dangerLevel: 'safe',
        },
    },
    resources: {
        'review-guide': {
            source: 'packaged',
            kind: 'template',
            path: 'resources/review-guide.md',
            contentType: 'text/markdown',
        },
        'agent-context-companion-guide': {
            source: 'packaged',
            kind: 'template',
            path: 'resources/agent-context-companion-guide.md',
            contentType: 'text/markdown',
        },
        'review-session-status': {
            source: 'dynamic',
            kind: 'config',
            contentType: 'text/plain',
            scope: 'session',
            hostAccess: ['review-resource-account'],
            maxBytes: 8192,
            runtime: reviewSessionStatusResource,
        },
        'project-companion-dashboard-document': {
            source: 'dynamic',
            kind: 'config',
            contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
            scope: 'session',
            hostAccess: ['review-resource-account'],
            maxBytes: 8192,
            runtime: projectCompanionDashboardResource,
        },
    },
    sessionInfoSections: {
        'project-companion-status': {
            resourceId: 'project-companion-dashboard-document',
            order: 40,
            actions: ['open-review-status'],
        },
    },
    // Deferred — not supported or advertised for ordinary author use. Do not
    // rely on this illustrative declaration; its matrix row owns the unblock condition.
    composer: {
        references: {
            'review-references': defineComposerReference({
                title: 'Review references',
                icon: 'search',
                ...reviewReferenceProvider,
            }),
        },
        attachments: {
            // A structural draft value only: no picker, control, runtime callback,
            // content handle, bytes, or media identifier is introduced here.
            'review-label': defineComposerAttachment({
                title: 'Review label',
                icon: 'file',
                cardinality: 'many',
                value: defineProtocolObject({
                    label: defineProtocolString(),
                }, { policy: 'closed' }),
            }),
            'review-evidence': defineComposerAttachment({
                title: 'Review evidence',
                icon: 'file',
                cardinality: 'many',
                value: defineProtocolObject({
                    summary: defineProtocolString(),
                    source: defineProtocolString().optional(),
                }, { policy: 'closed' }),
                picker: {
                    renderer: 'review-native',
                    fallbackRenderers: ['review-web'],
                },
            }),
        },
        controls: {
            'add-review-evidence': defineComposerControl({
                label: 'Add review evidence',
                icon: 'file',
                interaction: {
                    kind: 'attachmentPicker',
                    attachment: 'review-evidence',
                    presentation: 'popover',
                    layout: 'list',
                },
            }),
        },
        regions: {
            'review-context': defineComposerRegion({
                placement: 'afterComposer',
                renderer: {
                    renderer: 'review-native',
                    fallbackRenderers: ['review-web'],
                },
            }),
        },
    },
    // Deferred — not supported or advertised for ordinary author use. Do not rely on it.
    openableContentViewers: {
        'review-text-viewer': {
            destination: 'review-openable-content',
            contentClasses: ['text'],
            mimeTypes: ['text/markdown', 'text/plain'],
            extensions: ['.md', '.txt'],
        },
    },
    accountCollections: {
        'review-session-statuses': reviewSessionStatusCollection,
    },
    // Deferred — not supported or advertised for ordinary author use. Do not rely on it.
    tools: {
        'review-summary-tool': {
            name: 'review_summary',
            title: 'Summarize review transcript',
            surfaces: ['agent', 'mcp'],
            action: 'review-summary',
            promptSnippet: 'Use review_summary when a bounded review summary will help the current turn.',
            promptGuidelines: [
                'Keep the summary tied to the user-requested review scope.',
                'Do not treat tool output as persistent Session state.',
            ],
        },
    },
    promptAssets: {
        'agent-context-companion-prompt': {
            kind: 'context',
            resource: 'agent-context-companion-guide',
            target: { kind: 'agent', agent: 'review-agent' },
            priority: 50,
        },
    },
    // Deferred — source-wired but not supported or advertised for ordinary author use.
    commands: {
        'review-summary-command': {
            title: 'Summarize review transcript',
            path: ['review', 'summarize'],
            action: 'review-summary',
        },
    },
    // Deferred — not supported or advertised for ordinary author use. Do not rely on it.
    sessionHeaderActions: {
        'open-project-companion-dashboard': {
            title: 'Open Project Companion',
            command: {
                kind: 'openSurface',
                destination: 'project-companion-dashboard',
            },
        },
        'open-project-companion-activity': {
            title: 'Open Project Companion activity',
            command: {
                kind: 'openSurface',
                destination: 'project-companion-activity-log',
            },
        },
    },
    hooks: {
        'session-spawned': {
            declaration: {
                on: 'session.spawned',
                hookApiVersion: 1,
                category: 'lifecycle',
                scope: 'session',
                executionKind: 'observe',
                priority: 50,
            },
            handler: observeSessionSpawned,
        },
        'agent-context-companion': {
            declaration: {
                on: 'agent.composition.resolve',
                hookApiVersion: 1,
                category: 'augmentation',
                scope: 'agent',
                executionKind: 'augment',
                priority: 50,
            },
            handler: resolveAgentContextCompanionComposition,
        },
    },
    agents: {
        'review-agent': {
            declaration: {
                title: 'Public SDK Review Agent',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
            },
            factory: createReviewAgentRuntime,
            sessionRunnerFactory: reviewAgentRunnerFactory,
        },
    },
    systemTools: {
        'acme-review-agent': {
            title: 'Acme Review Agent',
            executableNames: ['acme-review-agent'],
        },
    },
    settings: {
        preferences: {
            title: 'Review assistant preferences',
            target: { kind: 'plugin' },
            scope: 'account',
            fields: [{
                id: 'enabled',
                title: 'Enabled',
                schema: { type: 'boolean' },
                default: true,
            }],
        },
    },
    ui: {
        views: [
            {
                id: 'review-panel',
                container: 'appPage',
                target: { kind: 'app' },
                renderer: 'review-native',
                fallbackRenderers: ['review-web'],
                title: 'Review assistant',
                instancePolicy: 'singleton',
            },
            {
                id: 'review-session-status-details',
                container: 'detailsTab',
                target: { kind: 'session' },
                renderer: 'review-native',
                fallbackRenderers: ['review-web'],
                title: 'Review status',
                instancePolicy: 'singleton',
            },
            {
                id: 'project-companion-dashboard',
                container: 'rightPane',
                target: { kind: 'session' },
                renderer: 'project-companion-dashboard-renderer',
                title: 'Project Companion',
                instancePolicy: 'singleton',
            },
            {
                id: 'project-companion-activity-log',
                container: 'bottomPane',
                target: { kind: 'session' },
                renderer: 'review-native',
                fallbackRenderers: ['review-web'],
                title: 'Project Companion activity',
                instancePolicy: 'singleton',
            },
            {
                id: 'project-companion-project-activity-log',
                container: 'bottomPane',
                target: { kind: 'project' },
                renderer: 'review-native',
                fallbackRenderers: ['review-web'],
                title: 'Project Companion activity',
                instancePolicy: 'singleton',
            },
            {
                id: 'review-openable-content',
                container: 'detailsTab',
                target: { kind: 'session' },
                renderer: 'review-openable-native',
                fallbackRenderers: ['review-openable-web'],
                title: 'Selected review file',
                instancePolicy: 'singleton',
            },
        ],
        renderers: [
            {
                id: 'project-companion-dashboard-renderer',
                kind: 'declarative',
                root: {
                    kind: 'group',
                    title: 'Project Companion',
                    description: 'Live review status for the current Session.',
                    children: [{
                        kind: 'status',
                        label: 'Review status',
                        value: 'Waiting for the current review status.',
                    }],
                },
                documentSource: {
                    kind: 'resource',
                    resourceId: 'project-companion-dashboard-document',
                },
            },
            {
                id: 'review-native',
                kind: 'reactNative',
                artifact: 'review-native',
                requiredHostMethods: [
                    'context',
                    'executeAction',
                    'openSurface',
                    'publishCurrentUiContext',
                    'readResource',
                    'watchResource',
                ],
            },
            {
                id: 'review-web',
                kind: 'hostedWeb',
                source: { kind: 'artifact', artifact: 'review-web' },
                requiredHostMethods: [
                    'context',
                    'executeAction',
                    'openSurface',
                    'publishCurrentUiContext',
                    'readResource',
                    'watchResource',
                ],
            },
            {
                id: 'review-openable-native',
                kind: 'reactNative',
                artifact: 'review-openable-native',
                requiredHostMethods: [
                    'context',
                    'statOpenableContent',
                    'readOpenableContent',
                ],
            },
            {
                id: 'review-openable-web',
                kind: 'hostedWeb',
                source: { kind: 'artifact', artifact: 'review-openable-web' },
                requiredHostMethods: [
                    'context',
                    'statOpenableContent',
                    'readOpenableContent',
                ],
            },
        ],
        translations: [],
    },
    voiceModelPacks: {
        'english-small': {
            schemaVersion: 1,
            executionHosts: ['daemon'],
            manifest: {
                schemaVersion: 1,
                kind: 'stt_sherpa',
                model: 'example-english-small',
                version: '1.0.0',
                runtime: {
                    family: 'sherpa_zipformer_streaming',
                    artifacts: {
                        encoder: { type: 'file', path: 'encoder.onnx' },
                        decoder: { type: 'file', path: 'decoder.onnx' },
                        joiner: { type: 'file', path: 'joiner.onnx' },
                        tokens: { type: 'file', path: 'tokens.txt' },
                    },
                    abiVersion: 1,
                    minHostVersion: '1.0.0',
                    platforms: ['darwin', 'linux', 'win32'],
                    architectures: ['arm64', 'x64'],
                },
                provenance: {
                    source: 'https://models.example.com/english-small',
                    publisher: 'Example Speech',
                },
                license: {
                    id: 'Apache-2.0',
                    title: 'Apache License 2.0',
                    url: 'https://models.example.com/licenses/apache-2.0',
                    requiresAcceptance: false,
                },
                files: [
                    {
                        path: 'encoder.onnx',
                        url: 'https://models.example.com/english-small/encoder.onnx',
                        sha256: '0000000000000000000000000000000000000000000000000000000000000000',
                        sizeBytes: 1,
                    },
                    {
                        path: 'decoder.onnx',
                        url: 'https://models.example.com/english-small/decoder.onnx',
                        sha256: '1111111111111111111111111111111111111111111111111111111111111111',
                        sizeBytes: 1,
                    },
                    {
                        path: 'joiner.onnx',
                        url: 'https://models.example.com/english-small/joiner.onnx',
                        sha256: '2222222222222222222222222222222222222222222222222222222222222222',
                        sizeBytes: 1,
                    },
                    {
                        path: 'tokens.txt',
                        url: 'https://models.example.com/english-small/tokens.txt',
                        sha256: '3333333333333333333333333333333333333333333333333333333333333333',
                        sizeBytes: 1,
                    },
                ],
            },
        },
    },
    voiceProviders: {
        'credentialed-browser': {
            declaration: {
                title: 'Account-mediated browser conversation example',
                kind: 'conversation',
                roles: ['realtime_conversation'],
                platforms: ['web'],
                capabilities: {
                    turn: { cancelResponse: false, bargeIn: false },
                    tools: { effectCalls: 'stable_ids' },
                },
                credentials: {
                    slot: {
                        id: MEDIATED_VOICE_CREDENTIAL_SLOT_ID,
                        purpose: 'voice.client-auth',
                        title: 'API key',
                    },
                    requirement: { kind: 'always' },
                    sources: [{
                        kind: 'savedSecret',
                        secretKinds: ['apiKey'],
                        operationProjections: [
                            {
                                kind: 'recipientCredential',
                                operation: 'client-auth',
                                phase: 'prepare',
                                format: 'bearer',
                            },
                            {
                                kind: 'recipientCredential',
                                operation: 'list-catalog',
                                phase: 'settings',
                                format: 'bearer',
                            },
                        ],
                    }],
                    hostMediated: {
                        operations: [
                            {
                                id: 'client-auth',
                                purpose: 'voice.client-auth',
                                credentialSlotId: MEDIATED_VOICE_CREDENTIAL_SLOT_ID,
                                effect: 'read',
                                request: {
                                    origin: 'https://voice.example.test',
                                    pathTemplate: '/v1/session',
                                    queryTemplate: [],
                                    headerTemplate: [],
                                    bodyTemplate: { kind: 'none' },
                                    method: 'POST',
                                    credential: {
                                        kind: 'httpHeader',
                                        name: 'authorization',
                                        format: 'bearer',
                                    },
                                    redirect: 'error',
                                    maxBodyBytes: 0,
                                    contentTypes: [],
                                },
                                parameters: {
                                    schema: { type: 'object', properties: {}, additionalProperties: false },
                                    mapping: [],
                                },
                                response: { maxBytes: 32768, contentTypes: ['application/json'] },
                            },
                            {
                                id: 'list-catalog',
                                purpose: 'voice.catalog',
                                credentialSlotId: MEDIATED_VOICE_CREDENTIAL_SLOT_ID,
                                effect: 'read',
                                request: {
                                    origin: 'https://voice.example.test',
                                    pathTemplate: '/v1/catalog',
                                    queryTemplate: [],
                                    headerTemplate: [],
                                    bodyTemplate: { kind: 'none' },
                                    method: 'GET',
                                    credential: {
                                        kind: 'httpHeader',
                                        name: 'authorization',
                                        format: 'bearer',
                                    },
                                    redirect: 'error',
                                    maxBodyBytes: 0,
                                    contentTypes: [],
                                },
                                parameters: {
                                    schema: { type: 'object', properties: {}, additionalProperties: false },
                                    mapping: [],
                                },
                                response: { maxBytes: 2097152, contentTypes: ['application/json'] },
                            },
                        ],
                    },
                },
                client: {
                    artifactId: 'voice-runtime-web',
                    modulePath: './voiceProvider',
                    exportName: 'activate',
                },
            },
        },
        'raw-browser': {
            declaration: {
                title: 'Raw browser conversation declaration example',
                kind: 'conversation',
                roles: ['realtime_conversation'],
                platforms: ['web'],
                capabilities: {
                    turn: { cancelResponse: true, bargeIn: true },
                    tools: { effectCalls: 'none' },
                },
                credentials: {
                    slot: {
                        id: RAW_VOICE_CREDENTIAL_SLOT_ID,
                        purpose: 'voice.raw-client',
                        title: 'Raw client key',
                    },
                    requirement: { kind: 'always' },
                    sources: [
                        {
                            kind: 'savedSecret',
                            secretKinds: ['apiKey'],
                            rawGrants: [{
                                realm: 'web',
                                phase: 'connection',
                                request: {
                                    kind: 'httpHeaders',
                                    origin: 'https://voice.example.test',
                                    headerNames: ['authorization'],
                                },
                            }],
                        },
                        {
                            kind: 'connectedAccount',
                            service: {
                                pluginId: 'acme.connected-accounts',
                                localId: 'voice-oauth',
                            },
                            rawGrants: [{
                                realm: 'web',
                                phase: 'connection',
                                request: {
                                    kind: 'httpHeaders',
                                    origin: 'https://voice.example.test',
                                    headerNames: ['authorization'],
                                },
                            }],
                        },
                    ],
                },
                client: {
                    artifactId: 'voice-runtime-web',
                    modulePath: './voiceProvider',
                    exportName: 'activate',
                },
            },
        },
        'speech-stt': {
            declaration: {
                title: 'Synthetic speech-to-text example',
                kind: 'speech',
                roles: ['dictation_stt', 'conversation_stt'],
                platforms: ['web', 'ios', 'android'],
                settings: {
                    schemaVersion: 2,
                    fields: [{
                        id: 'model',
                        title: 'Transcription model',
                        schema: { type: 'string', maxLength: 512 },
                        default: 'synthetic-stt-v1',
                        presentation: { control: 'select' },
                    }],
                    readiness: [{ kind: 'setting_nonempty', settingId: 'model' }],
                },
                catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }],
                limits: { transcribe: { maxInputBytes: 1048576 } },
            },
            runtime: speechToTextRuntime,
        },
        'speech-tts': {
            declaration: {
                title: 'Synthetic text-to-speech example',
                kind: 'speech',
                roles: ['conversation_tts'],
                platforms: ['web', 'ios', 'android'],
                settings: {
                    schemaVersion: 2,
                    fields: [{
                        id: 'voice',
                        title: 'Voice',
                        schema: { type: 'string', maxLength: 512 },
                        default: 'synthetic-voice',
                        presentation: { control: 'select' },
                    }],
                    actions: [{
                        id: 'refresh-voices',
                        title: 'Refresh voices',
                        placement: { kind: 'contributionFooter' },
                        confirmation: { kind: 'none' },
                        patchFieldIds: ['voice'],
                    }],
                    readiness: [{ kind: 'setting_nonempty', settingId: 'voice' }],
                },
                catalogs: [{ kind: 'voices', settingFieldId: 'voice', allowCustom: false }],
                limits: {
                    synthesize: {
                        maxInputCharacters: 4096,
                        maxOutputBytes: 2097152,
                    },
                },
            },
            runtime: textToSpeechRuntime,
        },
    },
};

export {
    createReviewAgentRuntime,
    observeSessionSpawned,
    reviewReferenceProvider,
    reviewSessionStatusResource,
    resolveAgentContextCompanionComposition,
    runExternalSessionDigest,
    runReviewSummary,
};
