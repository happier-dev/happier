import {
    formatPluginManifestIngestionDiagnostics,
    PLUGIN_CONTRIBUTION_CATALOG_V2,
} from '@happier-dev/protocol/plugins/manifest';
import {
    COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1,
} from '@happier-dev/protocol/plugins/contributions/composer-attachments';

import type { ActionContract, ActionHandler } from './actions/contracts.js';
import type {
    HookHandler,
    PluginEventHandler,
    PluginMcpDiscoveryHandler,
    PluginMcpServerRuntime,
    PluginNotificationSender,
    PluginRequestInterceptor,
    BackendRuntime,
    HostingProviderRuntime,
    PluginActivationModule,
    PluginApi,
    PluginCleanup,
    ComposerAttachmentRuntime,
    ComposerReferenceRuntime,
} from './activation.js';
import type { PluginDynamicResourceRuntime } from './services/resources.js';
import type {
    DaemonDatabaseIncumbentQueryFixture,
    DaemonDatabaseMigration,
} from './storage/database.js';

import type {
    AgentProviderBindingAdapter,
    AgentRuntimeFactory,
    AgentSessionRunnerFactoryLocatorV1,
} from './agentRuntime/index.js';
import type { AgentContribution } from './agents.js';
import type { BackgroundServiceDefinition } from './backgroundServices.js';
import type { EventContribution } from './events.js';
import type { HookContribution } from './hooks.js';
import type {
    JsonValue,
    PluginContributionLocalId,
} from './identity.js';
import type { ManagedProviderRuntime } from './managed-services/contract.js';
import type {
    McpDiscoverySourceContribution,
    McpServerContribution,
} from './mcp/projections.js';
import type { PromptAssetAdapter, PromptAssetContribution } from './resources.js';
import type { ConnectedAccountRuntime } from './connectedAccounts.js';
import type {
    PluginAccountCollectionDeclaration,
    PluginAccountCollectionDefinition,
    PluginAccountCollectionMigration,
} from './collections.js';
import {
    readProtocolComposableSchema,
    type ProtocolComposableSchema,
    type ProtocolSchemaInput,
    type ProtocolSchemaOutput,
} from './protocol/protocolFacade.js';
import type {
    ContributionAuthorTargets,
    ContributionPointAuthorDefinition,
    DefinedContributionPointProtocolMap,
    DefinedContributionPoints,
} from './targetedContributionAuthoring.js';
import type { TargetedContributionPointRef } from './services/targetedContributions.js';
import {
    attachTargetedContributionPointSemanticRefs,
    projectDefinedTargetedContributionPoints,
} from './targetedContributionAuthoring.js';
import type { AgentExternalSessionsContribution } from './externalSessions.js';
import type { AgentExternalSessionHooksContribution } from './externalSessionHooks.js';
import type { AgentExternalSessionObservationContribution } from './externalSessionObservation.js';
import type { AgentExternalSessionTakeoverContribution } from './sessions/externalSessionTakeover.js';
import type { VoiceProviderContribution, VoiceProviderRuntime } from './voice/projections.js';
import {
    parsePluginManifest,
    type ParsedPluginManifest,
    type PluginContributes,
    type PluginManifest,
    type PluginManifestParseResult,
    type PluginLocalizedStringV2,
} from './manifest.js';
import {
    projectUiSurfaceDefinitions,
    type UiAuthoringInput,
    type UiSurface,
} from './ui/surface.js';
import type { ComposerOperationV1 } from './ui/hostApi.js';
import type { PluginUiIconTokenV1 } from './ui/publicContract.js';

/**
 * One author entry in the discriminated `resources` family. A packaged entry is
 * a pure descriptor; a dynamic entry additionally binds its runtime producer.
 */
export type PluginResourceDefinition =
    | Readonly<{
        source?: 'packaged';
        kind: 'prompt' | 'skill' | 'template' | 'asset' | 'config';
        path: string;
        digest?: string;
        contentType: string;
        metadata?: Readonly<Record<string, JsonValue>>;
    }>
    | Readonly<{
        source: 'dynamic';
        kind: 'prompt' | 'skill' | 'template' | 'asset' | 'config';
        contentType: string;
        scope: 'global' | 'session' | 'surface';
        hostAccess?: readonly string[];
        maxBytes?: number;
        metadata?: Readonly<Record<string, JsonValue>>;
        runtime: PluginDynamicResourceRuntime;
    }>;

type DistributiveOmit<T, TKey extends PropertyKey> = T extends unknown
    ? Omit<T, TKey>
    : never;

type PluginManifestContributes = NonNullable<PluginManifest['contributes']>;
type ContributionRow<TFamily extends keyof PluginManifestContributes> =
    NonNullable<PluginManifestContributes[TFamily]> extends readonly (infer TRow)[] ? TRow : never;

/**
 * SDK-owned spelling of the parser-owned Action placement vocabulary. Keeping
 * the finite author contract here prevents `definePlugin` declarations from
 * acquiring the daemon Protocol root as a type dependency.
 */
export type PluginActionPlacement =
    | 'primary'
    | 'secondary'
    | 'rowAction'
    | 'contextMenu'
    | 'commandPalette'
    | 'toolbar'
    | 'detailsPanel'
    | 'composer.primary'
    | 'composer.more'
    | 'composer.slash'
    | 'message.menu';

/**
 * SDK-owned author projection of one Action declaration. Protocol remains the
 * parser and runtime manifest owner; this structural spelling keeps ordinary
 * `definePlugin` declarations independent of the daemon-only Action service.
 */
type ActionContribution = Readonly<{
    id: string;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    icon?: string;
    scopes: readonly (
        | 'global'
        | 'settings'
        | 'agent'
        | 'session'
        | 'message'
        | 'transcript'
        | 'executionRun'
        | 'toolResult'
        | 'workspace'
        | 'machine'
    )[];
    surfaces: readonly ('cli' | 'mcp' | 'agent' | 'ui' | 'plugin')[];
    placementBindings?: readonly PluginActionPlacement[];
    slash?: Readonly<{ tokens: readonly string[] }>;
    inputSchema?: object;
    inputHints?: object;
    connectedAccountPurposeBindings?: readonly Readonly<{
        path: string;
        purpose: string;
    }>[];
    resultSchema?: object;
    availability?: object;
    hostAccess?: readonly string[];
    priority?: number;
    dangerLevel: 'safe' | 'writesLocal' | 'writesRemote' | 'externalSideEffect' | 'destructive';
    confirmation?: Readonly<{
        title: PluginLocalizedStringV2;
        body?: PluginLocalizedStringV2;
        confirmLabel?: PluginLocalizedStringV2;
    }>;
    metadata?: Readonly<Record<string, JsonValue>>;
}>;

export type PluginActionAuthorDefaults = Readonly<{
    scopes?: readonly (
        | 'global'
        | 'settings'
        | 'agent'
        | 'session'
        | 'message'
        | 'transcript'
        | 'executionRun'
        | 'toolResult'
        | 'workspace'
        | 'machine'
    )[];
    /** Immutable schema-derived surface facts are valid Action author input. */
    surfaces?: readonly ('cli' | 'mcp' | 'agent' | 'ui' | 'plugin')[];
    placementBindings?: readonly PluginActionPlacement[];
    dangerLevel?: 'safe' | 'writesLocal' | 'writesRemote' | 'externalSideEffect' | 'destructive';
}>;
export type PluginActionDeclaration = Readonly<{
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    icon?: string;
    slash?: Readonly<{ tokens: readonly string[] }>;
    inputSchema?: object;
    inputHints?: object;
    connectedAccountPurposeBindings?: readonly Readonly<{
        path: string;
        purpose: string;
    }>[];
    resultSchema?: object;
    availability?: object;
    hostAccess?: readonly string[];
    priority?: number;
    confirmation?: Readonly<{
        title: PluginLocalizedStringV2;
        body?: PluginLocalizedStringV2;
        confirmLabel?: PluginLocalizedStringV2;
    }>;
    metadata?: Readonly<Record<string, JsonValue>>;
} & PluginActionAuthorDefaults>;
export type PluginActionDefinition<
    THandler extends ActionHandler = ActionHandler,
> = Readonly<
    PluginActionDeclaration & { run: THandler }
>;

/** @preview */
export type ProtocolActionSchemaInput<TSchema> = TSchema extends ProtocolComposableSchema<unknown, unknown>
    ? ProtocolSchemaInput<TSchema> extends JsonValue ? ProtocolSchemaInput<TSchema> : JsonValue
    : JsonValue;
/** @preview */
export type ProtocolActionSchemaOutput<TSchema> = TSchema extends ProtocolComposableSchema<unknown, unknown>
    ? ProtocolSchemaOutput<TSchema> extends JsonValue ? ProtocolSchemaOutput<TSchema> : JsonValue | void
    : JsonValue | void;

type ValidatedPluginActionDefinition<TDefinition extends PluginActionDeclaration> = Readonly<
    TDefinition
    & {
        run: ActionHandler<
            ProtocolActionSchemaInput<TDefinition extends { inputSchema: infer TSchema } ? TSchema : undefined>,
            ProtocolActionSchemaOutput<TDefinition extends { resultSchema: infer TSchema } ? TSchema : undefined>
        >;
    }
>;
type ValidatedPluginActionDefinitions<
    TDefinitions extends Readonly<Record<string, PluginActionDeclaration>>,
> = Readonly<{
    [TLocalId in keyof TDefinitions]: ValidatedPluginActionDefinition<TDefinitions[TLocalId]>;
}>;

/**
 * `definePlugin` owns executable Agent bindings. Its cold declaration remains
 * a complete SDK-neutral spelling of the manifest Agent grammar; Protocol is
 * the sole parser and runtime validation owner.
 */
type PluginAgentContributionReference = string | Readonly<{
    pluginId: string;
    localId: string;
}>;

type PluginAgentPolicyExpression =
    | Readonly<{
        fact: 'plugin.enabled' | 'session.exists' | 'project.exists' | 'browser.exists';
        operator: 'equals';
        value: boolean;
    }>
    | Readonly<{
        fact: 'host.platform';
        operator: 'equals' | 'notEquals';
        value: 'web' | 'ios' | 'android' | 'desktop';
    }>
    | Readonly<{
        fact: 'host.feature';
        operator: 'enabled';
        value: string;
    }>
    | Readonly<{
        fact: 'session.agentId' | 'session.state' | 'project.id' | 'machine.id' | 'browser.origin';
        operator: 'equals' | 'notEquals';
        value: string;
    }>
    | Readonly<{
        fact: 'session.capability';
        operator: 'contains';
        value: string;
    }>
    | Readonly<{ all: readonly PluginAgentPolicyExpression[] }>
    | Readonly<{ any: readonly PluginAgentPolicyExpression[] }>
    | Readonly<{ not: PluginAgentPolicyExpression }>;

type PluginAgentAvailabilityDescriptor =
    | Readonly<{
        when?: PluginAgentPolicyExpression;
        disabledWhen?: never;
        disabledReason?: never;
    }>
    | Readonly<{
        when?: PluginAgentPolicyExpression;
        disabledWhen: PluginAgentPolicyExpression;
        disabledReason: PluginLocalizedStringV2;
    }>;

type PluginAgentAcpTimeouts = Readonly<{
    initializeMs?: number;
    idleMs?: number;
    toolCallMs?: number;
}>;
type PluginAgentAcpExecutable =
    | Readonly<{ kind: 'managedDependency'; id: PluginAgentContributionReference }>
    | Readonly<{ kind: 'systemTool'; id: PluginAgentContributionReference }>;
type PluginAgentAcpTransport =
    | Readonly<{
        kind: 'stdio';
        executable: PluginAgentAcpExecutable;
        preferredPath?: string;
        args?: readonly string[];
        env?: Readonly<Record<string, string>>;
        timeouts?: PluginAgentAcpTimeouts;
    }>
    | Readonly<{
        kind: 'webSocket';
        url: string;
        headers?: Readonly<Record<string, string>>;
        timeouts?: PluginAgentAcpTimeouts;
    }>
    | Readonly<{
        kind: 'tcp';
        host: string;
        port: number;
        timeouts?: PluginAgentAcpTimeouts;
    }>;

type PluginAgentGoalSetCapability = Readonly<{
    fields: readonly ('objective' | 'status' | 'tokenBudget')[];
    writableStatuses?: readonly ('active' | 'paused' | 'complete')[];
}>;
type PluginAgentGoalControlMode = Readonly<{
    get?: true;
    clear?: true;
    set?: PluginAgentGoalSetCapability;
}>;
type PluginAgentGoals = Readonly<{
    active?: PluginAgentGoalControlMode;
    inactive?: PluginAgentGoalControlMode;
    source: string;
}>;
type PluginAgentActivity<TValue> = Readonly<{
    active?: TValue;
    inactive?: TValue;
}>;
type PluginAgentSessionCapabilities = Readonly<{
    open: readonly ('create' | 'resume' | 'fork')[];
    delivery: readonly ('newTurn' | 'steer' | 'followUp')[];
    cancel: boolean;
    configuration?: boolean;
    compaction?: Readonly<{ events: true; manual?: true }>;
    conversationRollback?: true;
    goals?: PluginAgentGoals;
    catalog?: PluginAgentActivity<readonly ('vendorPlugins' | 'skills')[]>;
    usageLimitRecovery?: PluginAgentActivity<readonly ('checkNow' | 'consumeResetCredit')[]>;
    continuationVerification?: Readonly<{
        intents: readonly ('resume' | 'fork')[];
        requirement: 'required' | 'advisory';
    }>;
    workStateSources?: readonly Readonly<{
        id: string;
        itemKinds: readonly ('goal' | 'task' | 'todo')[];
    }>[];
    runtimeActivitySnapshots?: true;
    startupInstructions?: Readonly<{ versions: readonly [1] }>;
}>;
type PluginAgentExecutionRunCapabilities = Readonly<{
    open: readonly ('create' | 'resume' | 'fork')[];
    checkpoint: boolean;
    stop: boolean;
}>;
type PluginAgentAuxiliarySurfaces = readonly ('terminal' | 'externalSessions')[];
type PluginAgentExternalSessionsSurfaces =
    | readonly ['externalSessions']
    | readonly ['externalSessions', 'terminal']
    | readonly ['terminal', 'externalSessions'];

type PluginAgentConnectedAccountPurpose = Readonly<{
    purpose: string;
    service: PluginAgentContributionReference;
    required?: boolean;
    materializationKinds?: readonly ('httpHeaders' | 'environment' | 'files')[];
}>;

type PluginAgentCredentialTransportSupport = Readonly<{
    protocol: 'anthropic' | 'openai-chat' | 'openai-responses' | 'ollama-native';
    destination:
        | Readonly<{
            kind: 'httpHeader';
            names: 'anyValidated' | readonly string[];
            formats: readonly ('raw' | 'bearer' | 'template')[];
        }>
        | Readonly<{
            kind: 'queryParam';
            names: 'anyValidated' | readonly string[];
            formats: readonly ('raw' | 'bearer' | 'template')[];
        }>;
}>;
type PluginAgentProviderRequirements = Readonly<{
    acceptsProtocols: readonly ('anthropic' | 'openai-chat' | 'openai-responses' | 'ollama-native')[];
    required: Readonly<{
        streaming?: true;
        toolRoundTrips?: true;
        statefulResponses?: true;
        reasoningControls?: true;
    }>;
    credentialSupport: Readonly<{
        supportsNoAuth: boolean;
        apiKeyTransports: readonly PluginAgentCredentialTransportSupport[];
    }>;
    authIsolation: Readonly<{
        suppressConnectedServiceIds: readonly (
            | 'openai-codex'
            | 'openai'
            | 'anthropic'
            | 'claude-subscription'
            | 'gemini'
            | 'github'
            | 'bitbucket'
        )[];
        ownedEnvKeys: readonly string[];
    }>;
    materialization: 'spawnEnv' | 'engineConfig' | 'configFile';
    applyPolicy: 'live' | 'next_prompt' | 'restart_session' | 'unsupported';
    supportsFreeformModelIds: boolean;
}>;

type PluginAgentCliInstallCommand = Readonly<{
    cmd: string;
    args: readonly string[];
    requiresAdmin?: boolean;
    note?: string | null;
}>;
type PluginAgentCliManualInstallRecipes = Readonly<{
    darwin?: readonly PluginAgentCliInstallCommand[];
    linux?: readonly PluginAgentCliInstallCommand[];
    win32?: readonly PluginAgentCliInstallCommand[];
}>;
type PluginAgentCliManagedInstall =
    | Readonly<{
        kind: 'github_release_binary';
        githubRepo: string;
        binaryName: string;
        assetNameByPlatform?: Readonly<{
            darwin: Readonly<{ arm64: string; x64: string }>;
            linux: Readonly<{ arm64: string; x64: string }>;
            win32: Readonly<{ arm64: string; x64: string }>;
        }>;
        archiveEntriesByPlatform?: Readonly<{
            darwin: readonly Readonly<{ archivePath: string; destinationPath: string }>[];
            linux: readonly Readonly<{ archivePath: string; destinationPath: string }>[];
            win32: readonly Readonly<{ archivePath: string; destinationPath: string }>[];
        }>;
        archiveExtractionLimits?: Readonly<{
            maxFileBytes: number;
            maxExpandedBytes: number;
        }>;
    }>
    | Readonly<{
        kind: 'managed_package';
        packageName: string;
        binaryName: string;
        packageBinarySetup?: Readonly<{ kind: 'opencode_platform_binary' }> | null;
    }>;
type PluginAgentCliMetadata = Readonly<{
    displayName?: string;
    executable: Readonly<{
        binaryName: string;
        alternativeBinaryNames?: readonly string[];
        alternativeBinaryFallbackEnabledEnvVar?: string;
        knownUserBinDirSuffixes?: readonly string[] | null;
        sourcePreference: 'system-first' | 'managed-first';
        acceptsJavaScriptFileOverride?: boolean;
        systemCommandResolutionStrategy?: 'path-first' | 'known-user-first-runnable';
    }>;
    install: Readonly<{
        managed?: PluginAgentCliManagedInstall | null;
        manual:
            | Readonly<{ kind: 'none' }>
            | Readonly<{
                kind: 'command' | 'vendor_recipe';
                recipes?: PluginAgentCliManualInstallRecipes;
            }>;
        recommendationOrder?: number;
        guideUrl?: string | null;
        docsUrl?: string | null;
    }>;
    auth: Readonly<{
        support: 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';
        machineLoginKey?: string;
        probe: Readonly<{
            parser:
                | 'none'
                | 'unknown'
                | 'envOnly'
                | 'claudeCredentialsFile'
                | 'codexLoginStatus'
                | 'geminiCredentialFiles'
                | 'opencodeAuthList'
                | 'piEnvOnly'
                | 'copilotGhAuth'
                | 'kiroWhoamiJson'
                | 'cursorAboutJson';
            backgroundChecks: 'safe' | 'manual_only';
            statusArgs?: readonly string[] | null;
            envVars?: readonly string[];
            credentialPaths?: readonly string[];
        }>;
        loginLaunches: readonly Readonly<{
            kind: 'primary' | 'device_code';
            args: readonly string[];
            initialInput?: string | null;
        }>[];
    }>;
}>;

type PluginAgentExternalSessionSourceWhen = Readonly<{
    field: string;
    equals: string;
}>;
type PluginAgentExternalSessionSourceField = Readonly<{
    name: string;
    optional?: boolean;
    nullish?: boolean;
    min?: number;
    max?: number;
}> & (
    | Readonly<{ kind: 'literal'; value: string }>
    | Readonly<{ kind: 'string' }>
    | Readonly<{ kind: 'enum'; values: readonly string[] }>
    | Readonly<{ kind: 'unknown' }>
);
type PluginAgentExternalSessionSourceSchema = Readonly<{
    fields: readonly PluginAgentExternalSessionSourceField[];
    refinements?: readonly (
        | Readonly<{
            kind: 'requiresWhenEquals';
            field: string;
            when: PluginAgentExternalSessionSourceWhen;
        }>
        | Readonly<{
            kind: 'forbidsWhenEquals';
            fields: readonly string[];
            when: PluginAgentExternalSessionSourceWhen;
        }>
    )[];
}>;
type PluginAgentExternalSessionSourceKey = Readonly<{
    segments: readonly (
        | Readonly<{ kind: 'literal'; value: string }>
        | Readonly<{ kind: 'field'; field: string }>
        | Readonly<{ kind: 'homeMode'; field: string }>
        | Readonly<{
            kind: 'conditionalField';
            field: string;
            when: PluginAgentExternalSessionSourceWhen;
        }>
        | Readonly<{
            kind: 'connectedServiceScope';
            groupField: string;
            profileField: string;
            when: PluginAgentExternalSessionSourceWhen;
        }>
    )[];
}>;
type PluginAgentExternalSessionSourceInstance =
    | Readonly<{
        kind: 'default';
        constants?: Readonly<Record<string, string | number | boolean | null>>;
    }>
    | Readonly<{
        kind: 'connectedServiceProfiles';
        serviceId:
            | 'openai-codex'
            | 'openai'
            | 'anthropic'
            | 'claude-subscription'
            | 'gemini'
            | 'github'
            | 'bitbucket';
        constants?: Readonly<Record<string, string | number | boolean | null>>;
        fields: Readonly<{ serviceId: string; profileId: string }>;
    }>
    | Readonly<{
        kind: 'agentSetting';
        settingId: string;
        byServerIdSettingId?: string;
        field: string;
        normalization: 'httpOrigin';
        constants?: Readonly<Record<string, string | number | boolean | null>>;
    }>
    | Readonly<{
        kind: 'agentSettingOverride';
        settingId: string;
        byServerIdSettingId?: string;
        field: string;
        normalization: 'configuredPath';
        constants?: Readonly<Record<string, string | number | boolean | null>>;
    }>;
type PluginAgentExternalSessionSourceDeclaration = Readonly<{
    sourceKind: string;
    schema: PluginAgentExternalSessionSourceSchema;
    key: PluginAgentExternalSessionSourceKey;
    instances?: readonly PluginAgentExternalSessionSourceInstance[];
    terminalFollow?: Readonly<{ userRowClassification: 'explicitV1' }>;
}>;
type PluginAgentSurfaces = Readonly<{
    externalSession?: Readonly<{
        sources: readonly PluginAgentExternalSessionSourceDeclaration[];
        externalLinkedTakeover?: Readonly<{
            writerSafety: 'native_prevention' | 'unsupported';
        }>;
    }>;
}>;

type PluginAgentDisplayDeclaration = Readonly<{
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    metadata?: Readonly<Record<string, JsonValue>>;
    connectedAccounts?: readonly PluginAgentConnectedAccountPurpose[];
    providerRequirements?: PluginAgentProviderRequirements;
    availability?: PluginAgentAvailabilityDescriptor;
    surfaces?: PluginAgentSurfaces;
    cli?: PluginAgentCliMetadata;
}>;
type PluginAgentSessionPrimaryDeclaration = PluginAgentDisplayDeclaration & Readonly<{
    primary: 'sessions';
    capabilities: Readonly<{
        surfaces?: PluginAgentAuxiliarySurfaces;
        sessions: PluginAgentSessionCapabilities;
        executionRuns?: PluginAgentExecutionRunCapabilities;
    }>;
}>;
type PluginAgentExecutionPrimaryDeclaration = PluginAgentDisplayDeclaration & Readonly<{
    primary: 'executionRuns';
    capabilities: Readonly<{
        surfaces?: PluginAgentAuxiliarySurfaces;
        executionRuns: PluginAgentExecutionRunCapabilities;
        sessions?: PluginAgentSessionCapabilities;
    }>;
}>;
type PluginAgentRuntimeAcpDeclaration = PluginAgentSessionPrimaryDeclaration & Readonly<{
    runtime: Readonly<{
        kind: 'acp';
        transport: PluginAgentAcpTransport;
    }>;
}>;
type PluginAgentRuntimeCustomSessionDeclaration = PluginAgentSessionPrimaryDeclaration & Readonly<{
    runtime: Readonly<{ kind: 'custom' }>;
}>;
type PluginAgentRuntimeCustomExecutionDeclaration = PluginAgentExecutionPrimaryDeclaration & Readonly<{
    runtime: Readonly<{ kind: 'custom' }>;
}>;
type PluginAgentExternalSessionsAuxiliaryDeclaration = PluginAgentDisplayDeclaration & Readonly<{
    primary?: never;
    runtime?: never;
    capabilities: Readonly<{
        surfaces: PluginAgentExternalSessionsSurfaces;
    }>;
}>;
type PluginAgentDeclaration =
    | PluginAgentRuntimeAcpDeclaration
    | PluginAgentRuntimeCustomSessionDeclaration
    | PluginAgentRuntimeCustomExecutionDeclaration
    | PluginAgentExternalSessionsAuxiliaryDeclaration;
export type PluginCustomAgentDeclaration = DistributiveOmit<
    Extract<AgentContribution, { runtime: { kind: 'custom' } }>,
    'id'
>;
export type PluginHostOwnedAgentDeclaration = DistributiveOmit<
    Exclude<AgentContribution, { runtime: { kind: 'custom' } }>,
    'id'
>;

export type PluginAgentDefinition = Readonly<{
    externalSessions?: AgentExternalSessionsContribution;
    externalSessionHooks?: AgentExternalSessionHooksContribution;
    externalSessionObservation?: AgentExternalSessionObservationContribution;
    externalSessionTakeover?: AgentExternalSessionTakeoverContribution;
}> & (
    | Readonly<{
        declaration: PluginCustomAgentDeclaration;
        factory: AgentRuntimeFactory;
        providerBinding?: AgentProviderBindingAdapter;
        sessionRunnerFactory?: AgentSessionRunnerFactoryLocatorV1;
    }>
    | Readonly<{
        declaration: PluginHostOwnedAgentDeclaration;
        factory?: never;
        providerBinding?: never;
        sessionRunnerFactory?: never;
    }>
);

type PluginPromptAssetDeclaration = Omit<PromptAssetContribution, 'id' | 'adapterDescriptor'>;
export type PluginPromptAssetDefinition =
    | Readonly<{
        declaration: Omit<PromptAssetContribution, 'id' | 'adapterDescriptor'>;
        adapter: PromptAssetAdapter;
    }>
    | Omit<PromptAssetContribution, 'id' | 'adapterDescriptor'>;

type PluginPromptAssetAdapterDefinition = Extract<
    PluginPromptAssetDefinition,
    Readonly<{ declaration: PluginPromptAssetDeclaration; adapter: PromptAssetAdapter }>
>;

export type PluginHookDefinition = Readonly<{
    declaration: Omit<HookContribution, 'id'>;
    handler: HookHandler;
}>;

type PluginEventDeclaration = DistributiveOmit<EventContribution, 'id'>;
export type PluginEventDefinition =
    | Readonly<{
        declaration: Extract<PluginEventDeclaration, { kind: 'event' }>;
    }>
    | Readonly<{
        declaration: Extract<PluginEventDeclaration, { kind: 'subscription' }>;
        handler: PluginEventHandler;
    }>;

type PluginMcpServerDeclaration = DistributiveOmit<McpServerContribution, 'id'>;
export type PluginMcpServerDefinition =
    | Readonly<{
        declaration: Extract<PluginMcpServerDeclaration, { kind: 'static' }>;
    }>
    | Readonly<{
        declaration: Extract<PluginMcpServerDeclaration, { kind: 'dynamic' }>;
        runtime: PluginMcpServerRuntime;
    }>;

export type PluginMcpDiscoverySourceDefinition = Readonly<{
    declaration: Omit<McpDiscoverySourceContribution, 'id'>;
    discover: PluginMcpDiscoveryHandler;
}>;

export type PluginMcpDefinition = Readonly<{
    servers?: Readonly<Record<PluginContributionLocalId, PluginMcpServerDefinition>>;
    discoverySources?: Readonly<Record<PluginContributionLocalId, PluginMcpDiscoverySourceDefinition>>;
}>;

type RuntimeContributionDefinition<
    TFamily extends keyof PluginManifestContributes,
    TRuntime,
    TRuntimeField extends string = 'runtime',
    TDeclaration = DistributiveOmit<ContributionRow<TFamily>, 'id'>,
> = Readonly<{
    declaration: TDeclaration;
}> & Readonly<Record<TRuntimeField, TRuntime>>;

type PluginProviderDeclaration = DistributiveOmit<ContributionRow<'providers'>, 'id'>;
type PluginManagedProviderDeclaration = Readonly<
    Omit<PluginProviderDeclaration, 'managedRuntime'>
    & {
        managedRuntime: NonNullable<PluginProviderDeclaration['managedRuntime']>;
    }
>;
type PluginDescriptorOnlyProviderDefinition = Readonly<{
    declaration: Omit<PluginProviderDeclaration, 'managedRuntime'> & Readonly<{
        managedRuntime?: never;
    }>;
    runtime?: never;
}>;
export type PluginProviderDefinition = RuntimeContributionDefinition<
    'providers',
    ManagedProviderRuntime,
    'runtime',
    PluginManagedProviderDeclaration
>;
type PluginProviderAuthorDefinition =
    | PluginProviderDefinition
    | PluginDescriptorOnlyProviderDefinition;

export type PluginNotificationChannelDefinition = RuntimeContributionDefinition<
    'notificationChannels',
    PluginNotificationSender,
    'sender'
>;
export type PluginScmHostingProviderDefinition = RuntimeContributionDefinition<
    'scmHostingProviders',
    HostingProviderRuntime
>;
export type PluginScmBackendDefinition = RuntimeContributionDefinition<
    'scmBackends',
    BackendRuntime
>;
export type PluginConnectedAccountDefinition = RuntimeContributionDefinition<
    'connectedAccountDescriptors',
    ConnectedAccountRuntime
>;
export type PluginRequestInterceptorDefinition = RuntimeContributionDefinition<
    'requestInterceptors',
    PluginRequestInterceptor,
    'interceptor'
>;
export type PluginComposerReferenceDefinition = Readonly<
    Omit<
        NonNullable<NonNullable<PluginManifest['contributes']>['composerReferences']>[number],
        'id'
    >
    & ComposerReferenceRuntime
>;

/** @preview A normalized renderer-chain declaration accepted by Composer author helpers. */
export type ComposerRendererChainAuthorInput =
    | string
    | Readonly<{
        renderer: string;
        fallbackRenderers?: readonly string[];
    }>;
/** @preview Static attachment display declaration before renderer shorthand projection. */
export type ComposerAttachmentAuthorDisplay =
    | Readonly<{ kind: 'badge' }>
    | Readonly<{
        kind: 'media';
        media: 'image' | 'video';
    }>
    | Readonly<{
        kind: 'surface';
        renderer: ComposerRendererChainAuthorInput;
        sizing: 'compact' | 'content';
    }>;
/** @preview Static attachment preview declaration before renderer shorthand projection. */
export type ComposerAttachmentAuthorPreview =
    | Readonly<{
        kind: 'host';
        presentation: 'image' | 'video';
    }>
    | Readonly<{
        kind: 'surface';
        renderer: ComposerRendererChainAuthorInput;
        presentation: 'auto' | 'popover' | 'dialog';
    }>;

/** @preview Static attachment declaration before value schemas/runtime are attached. */
export type ComposerAttachmentAuthorDeclaration = Readonly<{
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    icon: PluginUiIconTokenV1;
    cardinality: 'one' | 'many';
    picker?: ComposerRendererChainAuthorInput;
    display?: ComposerAttachmentAuthorDisplay;
    preview?: ComposerAttachmentAuthorPreview;
}>;

export interface PluginComposerAttachmentDefinition<
    TDraft extends JsonValue = JsonValue,
    TPrepared extends JsonValue = TDraft,
> extends ComposerAttachmentAuthorDeclaration {
    readonly value: ProtocolComposableSchema<unknown, TDraft>;
    readonly preparedValue?: ProtocolComposableSchema<unknown, TPrepared>;
    readonly runtime?: ComposerAttachmentRuntime<TDraft, TPrepared>;
}

/** @preview Closed control interaction declaration before renderer shorthand projection. */
export type ComposerControlAuthorInteraction =
    | Readonly<{
        kind: 'action';
        action: string | Readonly<{ pluginId: string; localId: string }>;
    }>
    | Readonly<{
        kind: 'attachmentPicker';
        attachment: string;
        presentation: 'popover' | 'dialog';
        layout: 'content' | 'list' | 'split';
    }>
    | Readonly<{
        kind: 'choices';
        selection: 'single' | 'multiple';
        options: readonly Readonly<{
            id: string;
            label: PluginLocalizedStringV2;
            description?: PluginLocalizedStringV2;
            icon?: PluginUiIconTokenV1;
            disabled?: boolean;
            effect:
                | Readonly<{
                    kind: 'action';
                    action: string | Readonly<{ pluginId: string; localId: string }>;
                    input?: JsonValue;
                }>
                | Readonly<{
                    kind: 'composerApply';
                    operations: readonly ComposerOperationV1[];
                }>;
        }>[];
    }>
    | Readonly<{
        kind: 'surface';
        renderer: ComposerRendererChainAuthorInput;
        presentation: 'popover' | 'dialog';
        layout: 'content' | 'list' | 'split';
    }>
    | Readonly<{
        kind: 'destination';
        destination: string | Readonly<{ pluginId: string; localId: string }>;
    }>;
export interface PluginComposerControlDefinition {
    readonly label: PluginLocalizedStringV2;
    readonly icon: PluginUiIconTokenV1;
    readonly scopes?: readonly (
        | 'session'
        | 'newSession'
        | 'pendingMessage'
        | 'participantMessage'
        | 'automationAuthoring'
    )[];
    readonly order?: number;
    readonly labelPolicy?: 'always' | 'auto-hide';
    readonly state?: Readonly<{ resource: string }>;
    readonly interaction: ComposerControlAuthorInteraction;
    readonly compactRenderer?: ComposerRendererChainAuthorInput;
    readonly overflow?: Readonly<{
        label: PluginLocalizedStringV2;
        icon: PluginUiIconTokenV1;
        accessibilityLabel?: PluginLocalizedStringV2;
        presentation?: Readonly<{
            presentation: 'popover' | 'dialog';
            layout?: 'content' | 'list' | 'split';
        }>;
    }>;
}
export type PluginComposerRegionDefinition = Readonly<{
    placement: 'beforeComposer' | 'afterComposer';
    renderer: ComposerRendererChainAuthorInput;
    scopes?: readonly (
        | 'session'
        | 'newSession'
        | 'pendingMessage'
        | 'participantMessage'
        | 'automationAuthoring'
    )[];
    order?: number;
}>;

/**
 * The Composer is one author namespace. Its individual manifest families are
 * projected together so an author cannot select a retired per-family input
 * spelling or make activation own the static declaration families.
 */
export type PluginComposerDefinition = Readonly<{
    references?: Readonly<Record<
        PluginContributionLocalId,
        PluginComposerReferenceDefinition
    >>;
    attachments?: Readonly<Record<
        PluginContributionLocalId,
        PluginComposerAttachmentDefinition
    >>;
    controls?: Readonly<Record<
        PluginContributionLocalId,
        PluginComposerControlDefinition
    >>;
    regions?: Readonly<Record<
        PluginContributionLocalId,
        PluginComposerRegionDefinition
    >>;
}>;

/**
 * Author-owned executable callbacks for one manifest-declared daemon database.
 * The manifest carries only stable migration and fixture identities; the host
 * receives these callbacks as an exact candidate projection before activation.
 */
export type PluginDaemonDatabaseDefinition = Readonly<{
    migrations?: readonly DaemonDatabaseMigration[];
    incumbentQueryFixture: DaemonDatabaseIncumbentQueryFixture;
}>;

/**
 * Static declaration for one daemon-local database. Its callback-bearing
 * counterpart is `PluginDaemonDatabaseDefinition`; this descriptor remains
 * the manifest/candidate identity used to bind those callbacks exactly.
 */
export type PluginDaemonDatabaseDeclaration = NonNullable<
    NonNullable<PluginManifest['contributes']>['daemonDatabases']
>[number];

/**
 * Candidate-local executable half of `contributes.daemonDatabases`. This is
 * deliberately separate from `PluginApi`: databases have no activation-time
 * registration right, and the host validates this map against static manifest
 * identities before candidate preparation can use a callback.
 */
export type PluginDaemonDatabaseRuntimeProjection = Readonly<Record<
    PluginContributionLocalId,
    Readonly<{
        migrations: readonly DaemonDatabaseMigration[];
        incumbentQueryFixture: DaemonDatabaseIncumbentQueryFixture;
    }>
>>;

/**
 * Candidate-local executable half of `contributes.accountCollections`.
 * `definePlugin` validates this map against parsed static identities before a
 * host can use a callback; it never becomes a PluginApi registration family.
 */
export type PluginAccountCollectionMigrationRuntimeProjection = Readonly<Record<
    PluginContributionLocalId,
    readonly PluginAccountCollectionMigration[]
>>;

type DefinePluginFamilyPolicyValue = typeof DEFINE_PLUGIN_FAMILY_POLICY_V2[
    keyof typeof DEFINE_PLUGIN_FAMILY_POLICY_V2
];
type AuthorKeyForInputShape<TPolicy, TShape extends string> = TPolicy extends Readonly<{
    authorKey: infer TAuthorKey;
    inputShape: TShape;
}> ? TAuthorKey : never;
type DefinePluginDescriptorAuthorKey = Extract<
    AuthorKeyForInputShape<DefinePluginFamilyPolicyValue, 'descriptor'>,
    keyof PluginManifestContributes
>;
// Structured authoring may intentionally group several manifest families under
// one public key. `composer` is such a key, so unlike descriptor-only inputs it
// must not be narrowed to a raw `contributes` property here.
type DefinePluginStructuredAuthorKey = AuthorKeyForInputShape<
    DefinePluginFamilyPolicyValue,
    'structured'
>;
export type PluginVoiceProviderDefinition =
    | Readonly<{
        declaration: Extract<
            VoiceProviderContribution extends infer TDeclaration
                ? TDeclaration extends unknown
                    ? Omit<TDeclaration, 'id'>
                    : never
                : never,
            { kind: 'conversation' }
        >;
        runtime: Extract<VoiceProviderRuntime, { kind: 'conversation' }>;
    }>
    | Readonly<{
        /**
         * Conversation providers execute in their declared client artifact.
         * They still project a manifest row, but have no daemon registration.
         */
        declaration: Extract<
            VoiceProviderContribution extends infer TDeclaration
                ? TDeclaration extends unknown
                    ? Omit<TDeclaration, 'id'>
                    : never
                : never,
            { kind: 'conversation' }
        >;
        runtime?: never;
    }>
    | Readonly<{
        declaration: Extract<
            VoiceProviderContribution extends infer TDeclaration
                ? TDeclaration extends unknown
                    ? Omit<TDeclaration, 'id'>
                    : never
                : never,
            { kind: 'speech' }
        >;
        runtime: Extract<VoiceProviderRuntime, { kind: 'speech' }>;
    }>;

type PluginStructuredContributionDefinitions<
    TActions extends Readonly<Record<string, PluginActionDeclaration>>,
    TAgents extends Readonly<Record<string, PluginAgentDefinition>>,
    TPromptAssets extends Readonly<Record<PluginContributionLocalId, PluginPromptAssetDefinition>>,
> = Readonly<{
    contributes?: never;
    actions?: ValidatedPluginActionDefinitions<TActions>;
    agents?: TAgents;
    promptAssets?: TPromptAssets;
    backgroundServices?: readonly BackgroundServiceDefinition[];
    hooks?: Readonly<Record<PluginContributionLocalId, PluginHookDefinition>>;
    events?: Readonly<Record<PluginContributionLocalId, PluginEventDefinition>>;
    mcp?: PluginMcpDefinition;
    ui?: NonNullable<NonNullable<PluginManifest['contributes']>['ui']> & Readonly<{
        surfaces?: readonly UiSurface[];
    }>;
    providers?: Readonly<Record<PluginContributionLocalId, PluginProviderAuthorDefinition>>;
    voiceProviders?: Readonly<Record<PluginContributionLocalId, PluginVoiceProviderDefinition>>;
    notificationChannels?: Readonly<Record<PluginContributionLocalId, PluginNotificationChannelDefinition>>;
    scmHostingProviders?: Readonly<Record<PluginContributionLocalId, PluginScmHostingProviderDefinition>>;
    scmBackends?: Readonly<Record<PluginContributionLocalId, PluginScmBackendDefinition>>;
    connectedAccountDescriptors?: Readonly<Record<PluginContributionLocalId, PluginConnectedAccountDefinition>>;
    requestInterceptors?: Readonly<Record<PluginContributionLocalId, PluginRequestInterceptorDefinition>>;
    composer?: PluginComposerDefinition;
}>;

type PluginStructuredContributionAuthorKey = Exclude<
    keyof PluginStructuredContributionDefinitions<never, never, never>,
    'contributes'
>;
type MissingPluginStructuredContributionType = Exclude<
    DefinePluginStructuredAuthorKey,
    PluginStructuredContributionAuthorKey
>;
type ExtraPluginStructuredContributionType = Exclude<
    PluginStructuredContributionAuthorKey,
    DefinePluginStructuredAuthorKey
>;
type AssertNoPluginStructuredContributionTypeMismatch<TMismatch extends never> = TMismatch;
type PluginStructuredContributionTypeClosure = AssertNoPluginStructuredContributionTypeMismatch<
    MissingPluginStructuredContributionType | ExtraPluginStructuredContributionType
>;

export type DefinePluginInput<
    TActions extends Readonly<Record<string, PluginActionDeclaration>> = Readonly<Record<string, never>>,
    TAgents extends Readonly<Record<string, PluginAgentDefinition>> = Readonly<Record<string, never>>,
    TPromptAssets extends Readonly<Record<PluginContributionLocalId, PluginPromptAssetDefinition>> = Readonly<Record<string, never>>,
    TAccountCollections extends Readonly<Record<
        PluginContributionLocalId,
        PluginAccountCollectionDefinition
    >> = Readonly<Record<PluginContributionLocalId, PluginAccountCollectionDefinition>>,
    TPluginId extends string = string,
    TContributionPoints extends Readonly<Record<
        PluginContributionLocalId,
        ContributionPointAuthorDefinition
    >> = Readonly<Record<string, never>>,
> = Readonly<
    Omit<
        PluginManifest,
        'schemaVersion' | 'id' | 'displayName' | 'engines' | 'runtime' | 'hostAccess' | 'contributes'
    >
    & Partial<Pick<PluginManifest, 'displayName' | 'engines' | 'runtime' | 'hostAccess'>>
    & Readonly<{
        id: TPluginId;
        contributes?: never;
        commands?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['commands']>[number], 'id'>
        >>;
        tools?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['tools']>[number], 'id'>
        >>;
        resources?: Readonly<Record<PluginContributionLocalId, PluginResourceDefinition>>;
        transcriptActivities?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['transcriptActivities']>[number], 'id'>
        >>;
        sessionHeaderActions?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['sessionHeaderActions']>[number], 'id'>
        >>;
        browserTargets?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['browserTargets']>[number], 'id'>
        >>;
        browserActions?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['browserActions']>[number], 'id'>
        >>;
        requestInterceptors?: Readonly<Record<PluginContributionLocalId, PluginRequestInterceptorDefinition>>;
        settings?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['settings']>[number], 'id'>
        >>;
        executionRunProfiles?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['executionRunProfiles']>[number], 'id'>
        >>;
        notifications?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['notifications']>[number], 'id'>
        >>;
        managedDependencies?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['managedDependencies']>[number], 'id'>
        >>;
        systemTools?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['systemTools']>[number], 'id'>
        >>;
        voiceModelPacks?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['voiceModelPacks']>[number], 'id'>
        >>;
        openableContentViewers?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['openableContentViewers']>[number], 'id'>
        >>;
        accountCollections?: TAccountCollections & Readonly<{
            [TLocalId in keyof TAccountCollections]: TLocalId extends string
                ? TAccountCollections[TLocalId] & Readonly<{ id: TLocalId }>
                : never;
        }>;
        daemonDatabases?: Readonly<Record<
            PluginContributionLocalId,
            PluginDaemonDatabaseDefinition
        >>;
        webhooks?: Readonly<Record<
            PluginContributionLocalId,
            Omit<NonNullable<NonNullable<PluginManifest['contributes']>['webhooks']>[number], 'id'>
        >>;
        /** Target-owned versioned capability points; raw host `contributes` stays private. */
        contributionPoints?: TContributionPoints;
        /** Contributor role bindings grouped by exact target plugin and point. */
        contributesTo?: ContributionAuthorTargets<Extract<keyof TActions, string>>;
        actions?: Readonly<{
            [TLocalId in keyof TActions]: Readonly<
                TActions[TLocalId]
                & {
                    run: ActionHandler<
                        TActions[TLocalId] extends { inputSchema: infer TSchema }
                            ? ProtocolActionSchemaInput<TSchema>
                            : JsonValue,
                        TActions[TLocalId] extends { resultSchema: infer TSchema }
                            ? ProtocolActionSchemaOutput<TSchema>
                            : JsonValue | void
                    >;
                }
            >;
        }>;
        agents?: TAgents;
        promptAssets?: TPromptAssets;
        backgroundServices?: readonly BackgroundServiceDefinition[];
        hooks?: Readonly<Record<PluginContributionLocalId, Readonly<{
            declaration: Omit<HookContribution, 'id'>;
            handler: HookHandler;
        }>>>;
        events?: Readonly<Record<PluginContributionLocalId,
            | Readonly<{
                declaration: Omit<Extract<EventContribution, { kind: 'event' }>, 'id'>;
            }>
            | Readonly<{
                declaration: Omit<Extract<EventContribution, { kind: 'subscription' }>, 'id'>;
                handler: PluginEventHandler;
            }>
        >>;
        mcp?: Readonly<{
            servers?: Readonly<Record<PluginContributionLocalId,
                | Readonly<{
                    declaration: Omit<Extract<McpServerContribution, { kind: 'static' }>, 'id'>;
                }>
                | Readonly<{
                    declaration: Omit<Extract<McpServerContribution, { kind: 'dynamic' }>, 'id'>;
                    runtime: PluginMcpServerRuntime;
                }>
            >>;
            discoverySources?: Readonly<Record<PluginContributionLocalId, Readonly<{
                declaration: Omit<McpDiscoverySourceContribution, 'id'>;
                discover: PluginMcpDiscoveryHandler;
            }>>>;
        }>;
        ui?: NonNullable<NonNullable<PluginManifest['contributes']>['ui']> & Readonly<{
            surfaces?: readonly UiSurface[];
        }>;
        providers?: Readonly<Record<PluginContributionLocalId,
            | Readonly<{
                declaration: Omit<
                    NonNullable<NonNullable<PluginManifest['contributes']>['providers']>[number],
                    'id' | 'managedRuntime'
                > & Readonly<{
                    managedRuntime: NonNullable<
                        NonNullable<NonNullable<PluginManifest['contributes']>['providers']>[number]['managedRuntime']
                    >;
                }>;
                runtime: ManagedProviderRuntime;
            }>
            | Readonly<{
                declaration: Omit<
                    NonNullable<NonNullable<PluginManifest['contributes']>['providers']>[number],
                    'id' | 'managedRuntime'
                > & Readonly<{ managedRuntime?: never }>;
                runtime?: never;
            }>
        >>;
        voiceProviders?: Readonly<Record<PluginContributionLocalId, PluginVoiceProviderDefinition>>;
        notificationChannels?: Readonly<Record<PluginContributionLocalId, Readonly<{
            declaration: Omit<
                NonNullable<NonNullable<PluginManifest['contributes']>['notificationChannels']>[number],
                'id'
            >;
            sender: PluginNotificationSender;
        }>>>;
        scmHostingProviders?: Readonly<Record<PluginContributionLocalId, Readonly<{
            declaration: Omit<
                NonNullable<NonNullable<PluginManifest['contributes']>['scmHostingProviders']>[number],
                'id'
            >;
            runtime: HostingProviderRuntime;
        }>>>;
        scmBackends?: Readonly<Record<PluginContributionLocalId, Readonly<{
            declaration: Omit<
                NonNullable<NonNullable<PluginManifest['contributes']>['scmBackends']>[number],
                'id'
            >;
            runtime: BackendRuntime;
        }>>>;
        connectedAccountDescriptors?: Readonly<Record<PluginContributionLocalId, Readonly<{
            declaration: Omit<
                NonNullable<NonNullable<PluginManifest['contributes']>['connectedAccountDescriptors']>[number],
                'id'
            >;
            runtime: ConnectedAccountRuntime;
        }>>>;
        composer?: PluginComposerDefinition;
    }>
    & {
        setup?: (api: PluginApi) => void | PluginCleanup | Promise<void | PluginCleanup>;
    }
>;

/**
 * The manifest `definePlugin` projects.
 *
 * Declared as an interface, not a `Readonly<...>`/intersection type alias, so
 * that it survives declaration emit as a *name*. A type alias whose right-hand
 * side is a utility-type application carries that utility's alias symbol
 * (`Readonly`), not its own, so TypeScript prints the structural expansion
 * instead of the alias when an author writes
 * `export const { manifest, activate } = definePlugin(...)`. That expansion
 * inlines the whole inferred manifest graph into the author's `.d.ts` and
 * then has to name a recursive host type through a private implementation
 * package — a specifier no consumer package can resolve.
 * An interface always prints as a reference to its own exported symbol, so the
 * author's declarations stay portable and reference only public SDK specifiers.
 */
export interface DefinedPluginManifest extends Readonly<
    Omit<ParsedPluginManifest, 'displayName' | 'engines' | 'runtime' | 'hostAccess' | 'contributes'>
> {
    readonly displayName: NonNullable<ParsedPluginManifest['displayName']>;
    readonly engines?: NonNullable<ParsedPluginManifest['engines']>;
    readonly runtime: NonNullable<ParsedPluginManifest['runtime']>;
    readonly hostAccess: Readonly<{
        required: NonNullable<NonNullable<ParsedPluginManifest['hostAccess']>['required']>;
        optional: NonNullable<NonNullable<ParsedPluginManifest['hostAccess']>['optional']>;
    }>;
    readonly contributes: PluginContributes;
}

/**
 * Runtime Action reference projection. Handler inference remains owned by the
 * composable schemas on the source declaration; references carry only identity.
 */
export type DefinedPluginActionContracts<
    TPluginId extends string = string,
    TActions extends Readonly<Record<string, PluginActionDeclaration>> = Readonly<Record<string, never>>,
> = Readonly<{
    [TLocalId in keyof TActions & string]: Readonly<{
        pluginId: TPluginId;
        localId: TLocalId;
    }>;
}>;

export interface DefinedPlugin<
    TPluginId extends string = string,
    TActionContracts extends Readonly<Record<string, ActionContract>> = Readonly<Record<string, never>>,
    TContributionPointProtocols extends Readonly<Record<
        PluginContributionLocalId,
        readonly unknown[]
    >> = Readonly<Record<string, never>>,
> {
    readonly manifest: DefinedPluginManifest;
    /**
     * The compiled activation callback remains structurally identical to the
     * host ABI without making authors inherit its emitted implementation graph.
     */
    readonly activate: (api: PluginApi) => void | PluginCleanup | Promise<void | PluginCleanup>;
    /**
     * Frozen qualified Action references derived from the same declaration map
     * used for manifest projection and activation. Values carry no runtime
     * schema, handler, or implementation data.
     */
    readonly actionContracts: TActionContracts;
    /**
     * Target-local typed contribution-point refs. These refs contain only the
     * stable point/protocol identity; the host supplies admitted, current
     * contributors through `TargetedContributionsService`.
     */
    readonly contributionPoints: DefinedContributionPoints<TPluginId, TContributionPointProtocols>;
    /**
     * Exact candidate callbacks for manifest-declared daemon databases. Authors
     * export this named value alongside `manifest` and `activate`; it is never
     * made available through PluginApi registration.
     */
    readonly daemonDatabases: PluginDaemonDatabaseRuntimeProjection;
    /**
     * Exact target-artifact callbacks for manifest-declared Collection schema
     * evolution. They remain candidate-local and never become a PluginApi
     * registration or manifest payload.
     */
    readonly collectionMigrations: PluginAccountCollectionMigrationRuntimeProjection;
}

function projectProtocolSchema(value: object | undefined): object | undefined {
    return readProtocolComposableSchema(value)?.jsonSchema ?? value;
}

function normalizeActionHandler(definition: PluginActionDefinition): ActionHandler {
    const inputSchema = readProtocolComposableSchema<JsonValue, JsonValue>(definition.inputSchema);
    const resultSchema = readProtocolComposableSchema<JsonValue, JsonValue>(definition.resultSchema);
    if (inputSchema === undefined && resultSchema === undefined) return definition.run;

    return async (input, context) => {
        const normalizedInput = inputSchema === undefined ? input : inputSchema.parse(input);
        const result = await definition.run(normalizedInput, context);
        return resultSchema === undefined ? result : resultSchema.parse(result);
    };
}

function projectAction(localId: string, definition: PluginActionDefinition): ActionContribution {
    const {
        run: _run,
        scopes,
        surfaces,
        placementBindings,
        dangerLevel,
        inputSchema,
        resultSchema,
        ...descriptor
    } = definition;
    const defaultScopes: ActionContribution['scopes'] = ['global'];
    const defaultSurfaces: ActionContribution['surfaces'] = ['cli'];
    const projectedSurfaces: ActionContribution['surfaces'] = surfaces === undefined
        ? defaultSurfaces
        : [...surfaces];
    // A plugin-only Action is programmatic. Supplying a human placement binding for it
    // makes the serialized declaration claim a UI destination it cannot use.
    const projectedPlacementBindings = placementBindings ?? (
        projectedSurfaces.length === 1 && projectedSurfaces[0] === 'plugin'
            ? undefined
            : ['commandPalette']
    );
    return Object.freeze({
        ...descriptor,
        ...(inputSchema === undefined ? {} : { inputSchema: projectProtocolSchema(inputSchema) }),
        ...(resultSchema === undefined ? {} : { resultSchema: projectProtocolSchema(resultSchema) }),
        scopes: scopes ?? defaultScopes,
        surfaces: projectedSurfaces,
        ...(projectedPlacementBindings === undefined
            ? {}
            : { placementBindings: [...projectedPlacementBindings] }),
        dangerLevel: dangerLevel ?? 'safe',
        id: localId,
    });
}

/**
 * Projects only qualified Action identity. Input/result evidence is carried by
 * the declaration type on `DefinedPlugin.actionContracts`; no schema, handler,
 * activation module, or implementation value crosses this boundary.
 */
function projectActionContracts(
    pluginId: string,
    definitions: unknown,
): Readonly<Record<string, ActionContract>> {
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
        return Object.freeze({});
    }
    const contracts = Object.fromEntries(
        Object.keys(definitions).map((localId) => [
            localId,
            Object.freeze({ pluginId, localId }) as ActionContract,
        ]),
    );
    return Object.freeze(contracts);
}

function projectAgent(localId: string, definition: PluginAgentDefinition) {
    return Object.freeze({ ...definition.declaration, id: localId });
}

function projectPromptAsset(
    localId: PluginContributionLocalId,
    definition: PluginPromptAssetDefinition,
): PromptAssetContribution {
    if (isPluginPromptAssetAdapterDefinition(definition)) {
        return Object.freeze({
            ...definition.declaration,
            adapterDescriptor: definition.adapter.descriptor,
            id: localId,
        });
    }
    return Object.freeze({ ...definition, id: localId });
}

function isPluginPromptAssetAdapterDefinition(
    definition: PluginPromptAssetDefinition,
): definition is PluginPromptAssetAdapterDefinition {
    return 'declaration' in definition
        && 'adapter' in definition
        && definition.adapter !== undefined;
}

function projectKeyedDeclarations(
    definitions: unknown,
): readonly Readonly<Record<string, unknown>>[] {
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) return [];
    return Object.entries(definitions).map(([localId, declaration]) => Object.freeze({
        ...(declaration as Readonly<Record<string, unknown>>),
        id: localId,
    }));
}

function assertAccountCollectionDeclarationIds(definitions: unknown): void {
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) return;
    for (const [localId, declaration] of Object.entries(definitions)) {
        if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
            throw new TypeError(`Account Collection '${localId}' must declare matching id '${localId}'`);
        }
        const declaredIdValue = (declaration as Readonly<Record<string, unknown>>).id;
        const declaredId = typeof declaredIdValue === 'string'
            ? declaredIdValue
            : '<missing>';
        if (declaredId !== localId) {
            throw new TypeError(
                `Account Collection '${localId}' id must match its map key; received '${declaredId}'`,
            );
        }
    }
}

function runtimeDefinitionDeclarations<TDefinition extends Readonly<{ declaration: object }>>(
    definitions: Readonly<Record<string, TDefinition>>,
): (Readonly<{ id: string }> & TDefinition['declaration'])[] {
    return Object.entries(definitions).map(([localId, definition]) => Object.freeze({
        ...definition.declaration,
        id: localId,
    }));
}

type ParsedAgentRuntimeFacts = Readonly<{
    customRuntime: boolean;
    sessionCapable: boolean;
    externalSessionsCapable: boolean;
}>;

function readParsedAgentRuntimeFacts(
    localId: string,
    declaration: unknown,
): ParsedAgentRuntimeFacts {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
        throw new TypeError(`Canonical Agent '${localId}' declaration is missing after manifest parsing`);
    }
    const parsedDeclaration = declaration as Readonly<Record<string, unknown>>;
    const capabilities = parsedDeclaration.capabilities;
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
        throw new TypeError(`Canonical Agent '${localId}' capabilities are missing after manifest parsing`);
    }
    const parsedCapabilities = capabilities as Readonly<Record<string, unknown>>;
    const runtime = parsedDeclaration.runtime;
    const runtimeKind = runtime && typeof runtime === 'object' && !Array.isArray(runtime)
        ? (runtime as Readonly<Record<string, unknown>>).kind
        : undefined;
    const surfaces = parsedCapabilities.surfaces;
    return {
        customRuntime: runtimeKind === 'custom',
        sessionCapable: parsedDeclaration.primary === 'sessions',
        externalSessionsCapable: Array.isArray(surfaces) && surfaces.includes('externalSessions'),
    };
}

function assertAgentRunnerAuthoring(
    localId: string,
    definition: PluginAgentDefinition,
    facts: ParsedAgentRuntimeFacts,
): void {
    if (facts.customRuntime && definition.factory === undefined) {
        throw new TypeError(`Custom Agent '${localId}' requires a runtime factory`);
    }
    if (!facts.customRuntime && definition.factory !== undefined) {
        throw new TypeError(`Agent '${localId}' cannot declare a runtime factory without runtime kind 'custom'`);
    }
    const requiresSessionRunnerFactory = facts.customRuntime && facts.sessionCapable;
    if (requiresSessionRunnerFactory && definition.sessionRunnerFactory === undefined) {
        throw new TypeError(
            `Session-capable Agent '${localId}' must use a package root with a distinct named runner leaf`,
        );
    }
    if (!requiresSessionRunnerFactory && definition.sessionRunnerFactory !== undefined) {
        throw new TypeError(
            `Agent '${localId}' cannot declare a custom Session runner leaf for this runtime contract`,
        );
    }
    if (facts.externalSessionsCapable && definition.externalSessions === undefined) {
        throw new TypeError(
            `Agent '${localId}' declares the External Sessions surface and requires an External Sessions contribution`,
        );
    }
    const hasAnyExternalSessionsRuntime = definition.externalSessions !== undefined
        || definition.externalSessionHooks !== undefined
        || definition.externalSessionObservation !== undefined
        || definition.externalSessionTakeover !== undefined;
    if (!facts.externalSessionsCapable && hasAnyExternalSessionsRuntime) {
        throw new TypeError(
            `Agent '${localId}' cannot register External Sessions runtime facets without declaring the External Sessions surface`,
        );
    }
}

function assertAgentRunnerDefinitions(
    definitions: Readonly<Record<PluginContributionLocalId, PluginAgentDefinition>> | undefined,
    parsedDeclarations: ParsedPluginManifest['contributes']['agents'],
): void {
    const parsedByLocalId = new Map(parsedDeclarations.map((declaration) => [declaration.id, declaration]));
    for (const [localId, definition] of Object.entries(definitions ?? {})) {
        const declaration = parsedByLocalId.get(localId);
        assertAgentRunnerAuthoring(
            localId,
            definition,
            readParsedAgentRuntimeFacts(localId, declaration),
        );
    }
}

type NormalizedPluginDaemonDatabaseDefinition = Readonly<{
    migrations: readonly DaemonDatabaseMigration[];
    incumbentQueryFixture: DaemonDatabaseIncumbentQueryFixture;
}>;

function readDaemonDatabaseDefinitionRecord(
    value: unknown,
    description: string,
): Readonly<Record<string, unknown>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${description} must be an object keyed by local database id`);
    }
    return value as Readonly<Record<string, unknown>>;
}

function assertDaemonDatabaseDefinitionKeys(
    value: Readonly<Record<string, unknown>>,
    localId: string,
): void {
    const unknownKeys = Object.keys(value).filter((key) => (
        key !== 'migrations' && key !== 'incumbentQueryFixture'
    ));
    if (unknownKeys.length > 0) {
        throw new TypeError(
            `Daemon database '${localId}' has unknown callback field(s): ${unknownKeys.join(', ')}`,
        );
    }
}

function normalizeDaemonDatabaseDefinition(
    value: unknown,
    localId: string,
): NormalizedPluginDaemonDatabaseDefinition {
    const definition = readDaemonDatabaseDefinitionRecord(value, `Daemon database '${localId}'`);
    assertDaemonDatabaseDefinitionKeys(definition, localId);
    const rawMigrations = definition.migrations ?? [];
    if (!Array.isArray(rawMigrations)) {
        throw new TypeError(`Daemon database '${localId}' migrations must be an array`);
    }
    const migrations = rawMigrations.map((rawMigration, index) => {
        const migration = readDaemonDatabaseDefinitionRecord(
            rawMigration,
            `Daemon database '${localId}' migration ${index}`,
        );
        const unknownKeys = Object.keys(migration).filter((key) => (
            key !== 'version' && key !== 'id' && key !== 'up'
        ));
        if (unknownKeys.length > 0) {
            throw new TypeError(
                `Daemon database '${localId}' migration ${index} has unknown field(s): ${unknownKeys.join(', ')}`,
            );
        }
        if (typeof migration.id !== 'string') {
            throw new TypeError(`Daemon database '${localId}' migration ${index} must have a string id`);
        }
        if (typeof migration.version !== 'number'
            || !Number.isSafeInteger(migration.version)
            || migration.version < 1) {
            throw new TypeError(
                `Daemon database '${localId}' migration ${index} must have a positive integer version`,
            );
        }
        if (typeof migration.up !== 'function') {
            throw new TypeError(`Daemon database '${localId}' migration ${index} must provide an up callback`);
        }
        return Object.freeze({
            id: migration.id,
            version: migration.version,
            up: migration.up as DaemonDatabaseMigration['up'],
        });
    });
    const fixture = readDaemonDatabaseDefinitionRecord(
        definition.incumbentQueryFixture,
        `Daemon database '${localId}' incumbent query fixture`,
    );
    const unknownFixtureKeys = Object.keys(fixture).filter((key) => key !== 'id' && key !== 'run');
    if (unknownFixtureKeys.length > 0) {
        throw new TypeError(
            `Daemon database '${localId}' incumbent query fixture has unknown field(s): ${unknownFixtureKeys.join(', ')}`,
        );
    }
    if (typeof fixture.id !== 'string') {
        throw new TypeError(`Daemon database '${localId}' incumbent query fixture must have a string id`);
    }
    if (typeof fixture.run !== 'function') {
        throw new TypeError(`Daemon database '${localId}' incumbent query fixture must provide a run callback`);
    }
    return Object.freeze({
        migrations: Object.freeze(migrations),
        incumbentQueryFixture: Object.freeze({
            id: fixture.id,
            run: fixture.run as DaemonDatabaseIncumbentQueryFixture['run'],
        }),
    });
}

function readDaemonDatabaseDefinitions(
    value: unknown,
): Readonly<Record<string, unknown>> {
    if (value === undefined) return Object.freeze({});
    return readDaemonDatabaseDefinitionRecord(value, 'Daemon databases');
}

function readAccountCollectionDefinitions(
    value: unknown,
): Readonly<Record<string, unknown>> {
    if (value === undefined) return Object.freeze({});
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Account Collections must be an object keyed by local collection id');
    }
    return value as Readonly<Record<string, unknown>>;
}

function projectPluginAccountCollectionMigrationRuntimeProjection(
    value: unknown,
): Readonly<Record<string, unknown>> {
    const definitions = readAccountCollectionDefinitions(value);
    return Object.freeze(Object.fromEntries(Object.entries(definitions).map(([localId, definition]) => {
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
            return [localId, definition] as const;
        }
        return [localId, (definition as Readonly<Record<string, unknown>>).migrations ?? []] as const;
    })));
}

function normalizePluginAccountCollectionMigrationProjection(
    value: unknown,
    localId: string,
): readonly PluginAccountCollectionMigration[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`Account Collection '${localId}' migration projection must be an array`);
    }
    return Object.freeze(value.map((rawMigration, index) => {
        if (!rawMigration || typeof rawMigration !== 'object' || Array.isArray(rawMigration)) {
            throw new TypeError(`Account Collection '${localId}' migration ${index} must be an object`);
        }
        const migration = rawMigration as Readonly<Record<string, unknown>>;
        if (typeof migration.migrate !== 'function') {
            throw new TypeError(`Account Collection '${localId}' migration ${index} must provide a migrate callback`);
        }
        return Object.freeze({
            id: migration.id,
            fromSchemaVersion: migration.fromSchemaVersion,
            toSchemaVersion: migration.toSchemaVersion,
            migrate: migration.migrate,
        }) as PluginAccountCollectionMigration;
    }));
}

/**
 * Candidate-local projection for Collection callbacks. Parsed manifest
 * identities remain the authority; every callback must match them in order
 * before a preparation host receives the projection.
 */
export function normalizePluginAccountCollectionMigrationRuntimeProjection(
    value: unknown,
    declarations: readonly PluginAccountCollectionDeclaration[],
): PluginAccountCollectionMigrationRuntimeProjection {
    const projection = readAccountCollectionDefinitions(value);
    const declarationIds = declarations.map((declaration) => declaration.id);
    const unknownIds = Object.keys(projection).filter((localId) => !declarationIds.includes(localId));
    const missingIds = declarationIds.filter((localId) => !Object.prototype.hasOwnProperty.call(projection, localId));
    if (unknownIds.length > 0 || missingIds.length > 0) {
        throw new TypeError([
            'Account Collection migration callbacks must match the manifest declarations exactly',
            ...(unknownIds.length > 0 ? [`unknown collection ids: ${unknownIds.join(', ')}`] : []),
            ...(missingIds.length > 0 ? [`missing collection ids: ${missingIds.join(', ')}`] : []),
        ].join('; '));
    }
    const normalized = declarations.map((declaration) => {
        const declaredMigrations = declaration.migrations;
        if (!Array.isArray(declaredMigrations)) {
            throw new TypeError(
                `Account Collection '${declaration.id}' manifest declaration is missing static migrations`,
            );
        }
        const migrations = normalizePluginAccountCollectionMigrationProjection(
            projection[declaration.id],
            declaration.id,
        );
        if (migrations.length !== declaredMigrations.length) {
            throw new TypeError(
                `Account Collection '${declaration.id}' migrations do not match the manifest declaration`,
            );
        }
        declaredMigrations.forEach((rawDeclaredMigration: unknown, index: number) => {
            if (!rawDeclaredMigration || typeof rawDeclaredMigration !== 'object' || Array.isArray(rawDeclaredMigration)) {
                throw new TypeError(
                    `Account Collection '${declaration.id}' manifest declaration has an invalid migration ${index}`,
                );
            }
            const declaredMigration = rawDeclaredMigration as Readonly<Record<string, unknown>>;
            const runtimeMigration = migrations[index];
            if (!runtimeMigration
                || runtimeMigration.id !== declaredMigration.id
                || runtimeMigration.fromSchemaVersion !== declaredMigration.fromSchemaVersion
                || runtimeMigration.toSchemaVersion !== declaredMigration.toSchemaVersion) {
                throw new TypeError(
                    `Account Collection '${declaration.id}' migration ${index} does not match the manifest declaration`,
                );
            }
        });
        return [declaration.id, migrations] as const;
    });
    return Object.freeze(Object.fromEntries(normalized));
}

/**
 * Normalizes candidate callbacks only after proving one-to-one correspondence
 * with the already parsed static manifest. The returned map retains callback
 * identity but exposes no registration API or host lifecycle authority.
 */
export function normalizePluginDaemonDatabaseRuntimeProjection(
    value: unknown,
    declarations: readonly Readonly<{
        id: PluginDaemonDatabaseDeclaration['id'];
        migrations: readonly Readonly<PluginDaemonDatabaseDeclaration['migrations'][number]>[];
        incumbentQueryFixtureId: PluginDaemonDatabaseDeclaration['incumbentQueryFixtureId'];
    }>[],
): PluginDaemonDatabaseRuntimeProjection {
    const definitions = readDaemonDatabaseDefinitions(value);
    const declarationIds = declarations.map((declaration) => declaration.id);
    const unknownIds = Object.keys(definitions).filter((localId) => !declarationIds.includes(localId));
    const missingIds = declarationIds.filter((localId) => !Object.prototype.hasOwnProperty.call(definitions, localId));
    if (unknownIds.length > 0 || missingIds.length > 0) {
        throw new TypeError([
            'Daemon database callbacks must match the manifest declarations exactly',
            ...(unknownIds.length > 0 ? [`unknown database ids: ${unknownIds.join(', ')}`] : []),
            ...(missingIds.length > 0 ? [`missing database ids: ${missingIds.join(', ')}`] : []),
        ].join('; '));
    }
    const normalized = declarations.map((declaration) => {
        const definition = normalizeDaemonDatabaseDefinition(definitions[declaration.id], declaration.id);
        if (definition.incumbentQueryFixture.id !== declaration.incumbentQueryFixtureId) {
            throw new TypeError(
                `Daemon database '${declaration.id}' incumbent query fixture does not match the manifest declaration`,
            );
        }
        if (definition.migrations.length !== declaration.migrations.length) {
            throw new TypeError(
                `Daemon database '${declaration.id}' migrations do not match the manifest declaration`,
            );
        }
        declaration.migrations.forEach((declaredMigration, index) => {
            const runtimeMigration = definition.migrations[index];
            if (!runtimeMigration
                || runtimeMigration.id !== declaredMigration.id
                || runtimeMigration.version !== declaredMigration.version) {
                throw new TypeError(
                    `Daemon database '${declaration.id}' migration ${index} does not match the manifest declaration`,
                );
            }
        });
        return [declaration.id, definition] as const;
    });
    return Object.freeze(Object.fromEntries(normalized));
}

function projectDaemonDatabaseDeclarations(
    input: Readonly<Record<string, unknown>>,
): DefinePluginFamilyProjection {
    const definitions = readDaemonDatabaseDefinitions(input.daemonDatabases);
    const declarations = Object.entries(definitions).map(([localId, rawDefinition]) => {
        const definition = normalizeDaemonDatabaseDefinition(rawDefinition, localId);
        return Object.freeze({
            id: localId,
            migrations: Object.freeze(definition.migrations.map((migration) => Object.freeze({
                version: migration.version,
                id: migration.id,
            }))),
            incumbentQueryFixtureId: definition.incumbentQueryFixture.id,
        });
    });
    return { daemonDatabases: Object.freeze(declarations) } as DefinePluginFamilyProjection;
}

type DefinePluginFamilyProjection = Partial<PluginManifestContributes>;
type DefinePluginFamilyAdapter = Readonly<{
    authorKey: string;
    project(input: Readonly<Record<string, unknown>>): DefinePluginFamilyProjection;
    activate?(input: Readonly<Record<string, unknown>>, api: PluginApi): void;
}>;

function descriptorFamilyAdapter<TFamily extends keyof PluginManifestContributes>(
    authorKey: TFamily,
): DefinePluginFamilyAdapter {
    return Object.freeze({
        authorKey,
        project(input: Readonly<Record<string, unknown>>): DefinePluginFamilyProjection {
            return {
                [authorKey]: projectKeyedDeclarations(input[authorKey]),
            } as unknown as DefinePluginFamilyProjection;
        },
    });
}

const ACTIONS_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'actions',
    project(input) {
        const definitions = input.actions as Readonly<Record<string, PluginActionDefinition>> | undefined;
        return {
            actions: Object.entries(definitions ?? {}).map(([localId, definition]) => (
                projectAction(localId, definition)
            )),
        };
    },
    activate(input, api) {
        const definitions = input.actions as Readonly<Record<string, PluginActionDefinition>> | undefined;
        for (const [localId, definition] of Object.entries(definitions ?? {})) {
            api.actions.register(localId, normalizeActionHandler(definition));
        }
    },
});

const AGENTS_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'agents',
    project(input) {
        const definitions = input.agents as Readonly<Record<string, PluginAgentDefinition>> | undefined;
        return {
            agents: Object.entries(definitions ?? {}).map(([localId, definition]) => (
                projectAgent(localId, definition)
            )),
        };
    },
    activate(input, api) {
        const definitions = input.agents as Readonly<Record<string, PluginAgentDefinition>> | undefined;
        for (const [localId, definition] of Object.entries(definitions ?? {})) {
            if (definition.factory !== undefined) {
                api.agents.register(
                    localId,
                    definition.factory,
                    definition.providerBinding === undefined
                        && definition.sessionRunnerFactory === undefined
                        ? undefined
                        : {
                            ...(definition.providerBinding === undefined
                                ? {}
                                : { providerBinding: definition.providerBinding }),
                            ...(definition.sessionRunnerFactory === undefined
                                ? {}
                                : { sessionRunnerFactory: definition.sessionRunnerFactory }),
                        },
                );
            }
            if (definition.externalSessions !== undefined) {
                api.agents.registerExternalSessions(localId, definition.externalSessions);
            }
            if (definition.externalSessionHooks !== undefined) {
                api.agents.registerExternalSessionHooks(localId, definition.externalSessionHooks);
            }
            if (definition.externalSessionObservation !== undefined) {
                api.agents.registerExternalSessionObservation(localId, definition.externalSessionObservation);
            }
            if (definition.externalSessionTakeover !== undefined) {
                api.agents.registerExternalSessionTakeover(localId, definition.externalSessionTakeover);
            }
        }
    },
});

const PROMPT_ASSETS_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'promptAssets',
    project(input) {
        const definitions = input.promptAssets as Readonly<
            Record<PluginContributionLocalId, PluginPromptAssetDefinition>
        > | undefined;
        return {
            promptAssets: Object.entries(definitions ?? {}).map(([localId, definition]) => (
                projectPromptAsset(localId, definition)
            )),
        };
    },
    activate(input, api) {
        const definitions = input.promptAssets as Readonly<
            Record<PluginContributionLocalId, PluginPromptAssetDefinition>
        > | undefined;
        for (const [localId, definition] of Object.entries(definitions ?? {})) {
            if ('adapter' in definition && definition.adapter !== undefined) {
                api.resources.registerPromptAssetAdapter(localId, definition.adapter);
            }
        }
    },
});

const BACKGROUND_SERVICES_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'backgroundServices',
    project(input) {
        const definitions = input.backgroundServices as readonly BackgroundServiceDefinition[] | undefined;
        return { backgroundServices: (definitions ?? []).map((definition) => definition.declaration) };
    },
    activate(input, api) {
        const definitions = input.backgroundServices as readonly BackgroundServiceDefinition[] | undefined;
        for (const definition of definitions ?? []) {
            api.backgroundServices.register(definition.declaration.id, definition.runner);
        }
    },
});

const HOOKS_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'hooks',
    project(input) {
        const definitions = input.hooks as Readonly<Record<PluginContributionLocalId, PluginHookDefinition>> | undefined;
        return {
            hooks: Object.entries(definitions ?? {}).map(([localId, definition]) => ({
                ...definition.declaration,
                id: localId,
            })),
        };
    },
    activate(input, api) {
        const definitions = input.hooks as Readonly<Record<PluginContributionLocalId, PluginHookDefinition>> | undefined;
        for (const [localId, definition] of Object.entries(definitions ?? {})) {
            api.hooks.register(localId, definition.handler);
        }
    },
});

/**
 * The discriminated `resources` family (§3.6.1). Packaged entries stay pure
 * descriptors; a dynamic entry additionally carries its runtime producer, which
 * is stripped from the projected manifest and bound at activation. Exactly one
 * family, one author key, one projection.
 */
const RESOURCES_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'resources',
    project(input) {
        return {
            resources: projectKeyedDeclarations(input.resources).map((declaration) => {
                const { runtime: _runtime, ...rest } = declaration as Readonly<Record<string, unknown>> & {
                    runtime?: unknown;
                };
                return Object.freeze(rest);
            }),
        } as unknown as DefinePluginFamilyProjection;
    },
    activate(input, api) {
        const definitions = input.resources as Readonly<
            Record<PluginContributionLocalId, Readonly<Record<string, unknown>>>
        > | undefined;
        for (const [localId, definition] of Object.entries(definitions ?? {})) {
            if (definition.source !== 'dynamic') continue;
            api.resources.registerDynamicResource(
                localId,
                definition.runtime as PluginDynamicResourceRuntime,
            );
        }
    },
});

const EVENTS_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'events',
    project(input) {
        const definitions = input.events as Readonly<Record<PluginContributionLocalId, PluginEventDefinition>> | undefined;
        return {
            events: Object.entries(definitions ?? {}).map(([localId, definition]) => ({
                ...definition.declaration,
                id: localId,
            })),
        };
    },
    activate(input, api) {
        const definitions = input.events as Readonly<Record<PluginContributionLocalId, PluginEventDefinition>> | undefined;
        for (const [localId, definition] of Object.entries(definitions ?? {})) {
            if ('handler' in definition) api.events.register(localId, definition.handler);
        }
    },
});

const MCP_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'mcp',
    project(input) {
        const definitions = input.mcp as PluginMcpDefinition | undefined;
        return {
            mcp: {
                servers: Object.entries(definitions?.servers ?? {}).map(([localId, definition]) => ({
                    ...definition.declaration,
                    id: localId,
                })),
                discoverySources: Object.entries(definitions?.discoverySources ?? {}).map(([
                    localId,
                    definition,
                ]) => ({
                    ...definition.declaration,
                    id: localId,
                })),
            },
        };
    },
    activate(input, api) {
        const definitions = input.mcp as PluginMcpDefinition | undefined;
        for (const [localId, definition] of Object.entries(definitions?.servers ?? {})) {
            if ('runtime' in definition) api.mcp.registerServer(localId, definition.runtime);
        }
        for (const [localId, definition] of Object.entries(definitions?.discoverySources ?? {})) {
            api.mcp.registerDiscoverySource(localId, definition.discover);
        }
    },
});

const UI_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'ui',
    project(input) {
        return input.ui === undefined
            ? {}
            : { ui: projectUiSurfaceDefinitions(input.ui as UiAuthoringInput) };
    },
});

function runtimeDefinitionAdapter<
    TDefinition extends Readonly<{ declaration: object }>,
>(input: Readonly<{
    authorKey: keyof PluginManifestContributes;
    register(api: PluginApi, localId: string, definition: TDefinition): void;
}>): DefinePluginFamilyAdapter {
    return Object.freeze({
        authorKey: input.authorKey,
        project(authorInput) {
            const definitions = authorInput[input.authorKey] as Readonly<Record<string, TDefinition>> | undefined;
            return {
                [input.authorKey]: runtimeDefinitionDeclarations(definitions ?? {}),
            } as unknown as DefinePluginFamilyProjection;
        },
        activate(authorInput, api) {
            const definitions = authorInput[input.authorKey] as Readonly<Record<string, TDefinition>> | undefined;
            for (const [localId, definition] of Object.entries(definitions ?? {})) {
                input.register(api, localId, definition);
            }
        },
    });
}

const NOTIFICATION_CHANNELS_ADAPTER = runtimeDefinitionAdapter<PluginNotificationChannelDefinition>({
    authorKey: 'notificationChannels',
    register: (api, localId, definition) => api.notifications.registerChannel(localId, definition.sender),
});
const SCM_HOSTING_PROVIDERS_ADAPTER = runtimeDefinitionAdapter<PluginScmHostingProviderDefinition>({
    authorKey: 'scmHostingProviders',
    register: (api, localId, definition) => api.scm.registerHostingProvider(localId, definition.runtime),
});
const SCM_BACKENDS_ADAPTER = runtimeDefinitionAdapter<PluginScmBackendDefinition>({
    authorKey: 'scmBackends',
    register: (api, localId, definition) => api.scm.registerBackend(localId, definition.runtime),
});
const CONNECTED_ACCOUNTS_ADAPTER = runtimeDefinitionAdapter<PluginConnectedAccountDefinition>({
    authorKey: 'connectedAccountDescriptors',
    register: (api, localId, definition) => api.connectedAccounts.register(localId, definition.runtime),
});
const REQUEST_INTERCEPTORS_ADAPTER = runtimeDefinitionAdapter<PluginRequestInterceptorDefinition>({
    authorKey: 'requestInterceptors',
    register: (api, localId, definition) => api.interceptors.register(localId, definition.interceptor),
});

const PROVIDERS_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'providers',
    project(input) {
        const definitions = input.providers as Readonly<
            Record<PluginContributionLocalId, PluginProviderAuthorDefinition>
        > | undefined;
        return {
            providers: Object.entries(definitions ?? {}).map(([localId, definition]) => Object.freeze({
                ...definition.declaration,
                id: localId,
            })),
        };
    },
    activate(input, api) {
        const definitions = input.providers as Readonly<
            Record<PluginContributionLocalId, PluginProviderAuthorDefinition>
        > | undefined;
        for (const [localId, definition] of Object.entries(definitions ?? {})) {
            if ('runtime' in definition && definition.runtime !== undefined) {
                api.providers.register(localId, definition.runtime);
            }
        }
    },
});
const VOICE_PROVIDERS_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'voiceProviders',
    project(input) {
        const definitions = input.voiceProviders as Readonly<
            Record<PluginContributionLocalId, PluginVoiceProviderDefinition>
        > | undefined;
        return {
            voiceProviders: runtimeDefinitionDeclarations(definitions ?? {}),
        };
    },
    activate(input, api) {
        const definitions = input.voiceProviders as Readonly<
            Record<PluginContributionLocalId, PluginVoiceProviderDefinition>
        > | undefined;
        for (const [localId, definition] of Object.entries(definitions ?? {})) {
            const declaration: unknown = definition.declaration;
            if (typeof declaration === 'object'
                && declaration !== null
                && 'kind' in declaration
                && declaration.kind === 'speech'
                && definition.runtime === undefined) {
                throw new TypeError(`invalid Voice provider runtime for speech '${localId}'`);
            }
            if (definition.runtime !== undefined) {
                api.voiceProviders.register(localId, definition.runtime);
            }
        }
    },
});

type ComposerAttachmentRuntimeDescriptor = NonNullable<
    ContributionRow<'composerAttachments'>['runtime']
>;
type ComposerAttachmentManifestProjection = NonNullable<
    PluginManifestContributes['composerAttachments']
>[number];
type ComposerControlManifestProjection = NonNullable<
    PluginManifestContributes['composerControls']
>[number];
type ComposerRegionManifestProjection = NonNullable<
    PluginManifestContributes['composerRegions']
>[number];

/**
 * Renderer-chain strings are ergonomic author sugar only. Every manifest
 * consumer receives the one Protocol-owned binding object; validation remains
 * at that manifest boundary rather than being copied into the SDK.
 */
function projectComposerRendererChain(
    renderer: ComposerRendererChainAuthorInput,
): Readonly<{
    renderer: string;
    fallbackRenderers?: readonly string[];
}> {
    return typeof renderer === 'string'
        ? Object.freeze({ renderer })
        : renderer;
}

function projectComposerAttachmentDisplay(
    display: ComposerAttachmentAuthorDisplay,
): Readonly<Record<string, unknown>> {
    if (display.kind !== 'surface') return display;
    return Object.freeze({
        ...display,
        renderer: projectComposerRendererChain(display.renderer),
    });
}

function projectComposerAttachmentPreview(
    preview: ComposerAttachmentAuthorPreview,
): Readonly<Record<string, unknown>> {
    if (preview.kind !== 'surface') return preview;
    return Object.freeze({
        ...preview,
        renderer: projectComposerRendererChain(preview.renderer),
    });
}

function projectComposerControlInteraction(
    interaction: ComposerControlAuthorInteraction,
): Readonly<Record<string, unknown>> {
    if (interaction.kind !== 'surface') return interaction;
    return Object.freeze({
        ...interaction,
        renderer: projectComposerRendererChain(interaction.renderer),
    });
}

function projectComposerAttachmentRuntimeDescriptor(
    runtime: ComposerAttachmentRuntime,
): ComposerAttachmentRuntimeDescriptor {
    const descriptor: {
        -readonly [TField in keyof ComposerAttachmentRuntimeDescriptor]:
            ComposerAttachmentRuntimeDescriptor[TField];
    } = {};
    for (const field of COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1) {
        if (runtime[field] !== undefined) {
            descriptor[field] = true;
        }
    }
    return Object.freeze(descriptor);
}

function projectComposerAttachmentDefinition(
    localId: string,
    definition: PluginComposerAttachmentDefinition,
): ComposerAttachmentManifestProjection {
    const {
        runtime,
        value,
        preparedValue,
        picker,
        display,
        preview,
        ...declaration
    } = definition;
    return Object.freeze({
        ...declaration,
        id: localId,
        valueSchema: value.jsonSchema,
        ...(preparedValue === undefined ? {} : { preparedValueSchema: preparedValue.jsonSchema }),
        ...(picker === undefined ? {} : { picker: projectComposerRendererChain(picker) }),
        ...(display === undefined ? {} : { display: projectComposerAttachmentDisplay(display) }),
        ...(preview === undefined ? {} : { preview: projectComposerAttachmentPreview(preview) }),
        ...(runtime === undefined
            ? {}
            : { runtime: projectComposerAttachmentRuntimeDescriptor(runtime) }),
    });
}

function projectComposerControlDefinition(
    localId: string,
    definition: PluginComposerControlDefinition,
): ComposerControlManifestProjection {
    const { compactRenderer, interaction, ...declaration } = definition;
    return Object.freeze({
        ...declaration,
        id: localId,
        interaction: projectComposerControlInteraction(interaction),
        ...(compactRenderer === undefined
            ? {}
            : { compactRenderer: projectComposerRendererChain(compactRenderer) }),
    });
}

function projectComposerRegionDefinition(
    localId: string,
    definition: PluginComposerRegionDefinition,
): ComposerRegionManifestProjection {
    const { renderer, ...declaration } = definition;
    return Object.freeze({
        ...declaration,
        id: localId,
        renderer: projectComposerRendererChain(renderer),
    });
}

const COMPOSER_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'composer',
    project(input) {
        const composer = input.composer as PluginComposerDefinition | undefined;
        return {
            composerReferences: Object.entries(composer?.references ?? {}).map(([localId, definition]) => {
                const { search: _search, resolve: _resolve, ...declaration } = definition;
                return Object.freeze({ ...declaration, id: localId });
            }),
            composerAttachments: Object.entries(composer?.attachments ?? {}).map(([localId, definition]) => (
                projectComposerAttachmentDefinition(localId, definition)
            )),
            composerControls: Object.entries(composer?.controls ?? {}).map(([localId, definition]) => (
                projectComposerControlDefinition(localId, definition)
            )),
            composerRegions: Object.entries(composer?.regions ?? {}).map(([localId, definition]) => (
                projectComposerRegionDefinition(localId, definition)
            )),
        };
    },
    activate(input, api) {
        const composer = input.composer as PluginComposerDefinition | undefined;
        for (const [localId, definition] of Object.entries(composer?.references ?? {})) {
            api.composerReferences.register(localId, {
                search: definition.search,
                resolve: definition.resolve,
            });
        }
        for (const [localId, definition] of Object.entries(composer?.attachments ?? {})) {
            if (definition.runtime !== undefined) {
                api.composerAttachments.register(localId, definition.runtime);
            }
        }
    },
});

const COMMANDS_ADAPTER = descriptorFamilyAdapter('commands');
const TOOLS_ADAPTER = descriptorFamilyAdapter('tools');
const TRANSCRIPT_ACTIVITIES_ADAPTER = descriptorFamilyAdapter('transcriptActivities');
const SESSION_HEADER_ACTIONS_ADAPTER = descriptorFamilyAdapter('sessionHeaderActions');
const BROWSER_TARGETS_ADAPTER = descriptorFamilyAdapter('browserTargets');
const BROWSER_ACTIONS_ADAPTER = descriptorFamilyAdapter('browserActions');
const SETTINGS_ADAPTER = descriptorFamilyAdapter('settings');
const EXECUTION_RUN_PROFILES_ADAPTER = descriptorFamilyAdapter('executionRunProfiles');
const NOTIFICATIONS_ADAPTER = descriptorFamilyAdapter('notifications');
const MANAGED_DEPENDENCIES_ADAPTER = descriptorFamilyAdapter('managedDependencies');
const SYSTEM_TOOLS_ADAPTER = descriptorFamilyAdapter('systemTools');
const VOICE_MODEL_PACKS_ADAPTER = descriptorFamilyAdapter('voiceModelPacks');
const OPENABLE_CONTENT_VIEWERS_ADAPTER = descriptorFamilyAdapter('openableContentViewers');
function isPluginAccountCollectionAuthorRecord(
    value: unknown,
): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Projects one executable Account Collection author definition into its static
 * manifest declaration. This is deliberately a projection only: callers keep
 * Protocol manifest admission and contract normalization at their existing
 * owners after the callback-bearing author value has been made JSON-safe.
 */
export function projectPluginAccountCollectionDeclaration(
    localId: string,
    definition: unknown,
): Readonly<Record<string, unknown>> {
    if (!isPluginAccountCollectionAuthorRecord(definition)) {
        return Object.freeze({ id: localId });
    }
    const { schema, migrations, ...declaration } = definition;
    return Object.freeze({
        ...declaration,
        id: localId,
        ...(migrations === undefined ? {} : {
            migrations: Array.isArray(migrations)
                ? migrations.map((migration) => {
                    if (!isPluginAccountCollectionAuthorRecord(migration)) return migration;
                    return Object.freeze({
                        id: migration.id,
                        fromSchemaVersion: migration.fromSchemaVersion,
                        toSchemaVersion: migration.toSchemaVersion,
                    });
                })
                : migrations,
        }),
        ...(schema === undefined ? {} : {
            schema: schema !== null && typeof schema === 'object'
                ? projectProtocolSchema(schema)
                : schema,
        }),
    });
}

function projectPluginAccountCollectionDeclarations(
    definitions: unknown,
): readonly Readonly<Record<string, unknown>>[] {
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) return [];
    return Object.entries(definitions).map(([localId, definition]) => (
        projectPluginAccountCollectionDeclaration(localId, definition)
    ));
}
const ACCOUNT_COLLECTIONS_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'accountCollections',
    project(input) {
        assertAccountCollectionDeclarationIds(input.accountCollections);
        return {
            accountCollections: projectPluginAccountCollectionDeclarations(input.accountCollections),
        } as unknown as DefinePluginFamilyProjection;
    },
});
const DAEMON_DATABASES_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'daemonDatabases',
    project: projectDaemonDatabaseDeclarations,
});
const WEBHOOKS_ADAPTER = descriptorFamilyAdapter('webhooks');
const CONTRIBUTION_POINTS_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'contributionPoints',
    project(input) {
        return {
            pluginContributionPoints: projectKeyedDeclarations(input.contributionPoints),
        } as unknown as DefinePluginFamilyProjection;
    },
});

/**
 * The targeted-contribution adapter is the sole boundary from helper-produced
 * author objects to the cold manifest. Trusted author values use ordinary
 * property access; the canonical manifest parser owns strict data admission
 * after this projection. Symbol-keyed helper evidence stays process-local.
 */
function projectTargetedContributionColdDeclaration(
    record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
    return Object.fromEntries(Object.entries(record));
}

const CONTRIBUTES_TO_ADAPTER: DefinePluginFamilyAdapter = Object.freeze({
    authorKey: 'contributesTo',
    project(input) {
        const targets = input.contributesTo;
        if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
            return { targetedPluginContributions: [] } as unknown as DefinePluginFamilyProjection;
        }
        const contributions = Object.entries(targets as Readonly<Record<string, unknown>>).flatMap(([
            targetPluginId,
            points,
        ]) => {
            if (!points || typeof points !== 'object' || Array.isArray(points)) return [];
            return Object.entries(points as Readonly<Record<string, unknown>>).flatMap(([pointId, definitions]) => {
                if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) return [];
                return Object.entries(definitions as Readonly<Record<string, unknown>>).map(([
                    localId,
                    definition,
                ]) => {
                    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
                        throw new TypeError(`Targeted contribution '${targetPluginId}/${pointId}/${localId}' must be an object`);
                    }
                    const record = definition as Readonly<Record<string, unknown>>;
                    if (Object.hasOwn(record, 'id') || Object.hasOwn(record, 'target')) {
                        throw new TypeError(`Targeted contribution '${targetPluginId}/${pointId}/${localId}' must derive id and target from its author path`);
                    }
                    return Object.freeze({
                        ...projectTargetedContributionColdDeclaration(record),
                        id: localId,
                        target: Object.freeze({ pluginId: targetPluginId, pointId }),
                    });
                });
            });
        });
        return {
            targetedPluginContributions: Object.freeze(contributions),
        } as unknown as DefinePluginFamilyProjection;
    },
});

type DefinePluginActiveFamilyPolicy = Readonly<{
    classification: 'adapter' | 'descriptor-only';
    authorKey: string;
    inputShape: 'structured' | 'descriptor';
    adapter: DefinePluginFamilyAdapter;
}>;
type DefinePluginFamilyPolicy = DefinePluginActiveFamilyPolicy;

/**
 * The one definePlugin family policy. Its keys are closed against the Protocol
 * catalog below; values also own accepted author keys, type classification,
 * cold projection, and generated activation.
 */
export const DEFINE_PLUGIN_FAMILY_POLICY_V2 = Object.freeze({
    actions: { classification: 'adapter', authorKey: 'actions', inputShape: 'structured', adapter: ACTIONS_ADAPTER },
    agents: { classification: 'adapter', authorKey: 'agents', inputShape: 'structured', adapter: AGENTS_ADAPTER },
    promptAssets: { classification: 'adapter', authorKey: 'promptAssets', inputShape: 'structured', adapter: PROMPT_ASSETS_ADAPTER },
    backgroundServices: { classification: 'adapter', authorKey: 'backgroundServices', inputShape: 'structured', adapter: BACKGROUND_SERVICES_ADAPTER },
    hooks: { classification: 'adapter', authorKey: 'hooks', inputShape: 'structured', adapter: HOOKS_ADAPTER },
    events: { classification: 'adapter', authorKey: 'events', inputShape: 'structured', adapter: EVENTS_ADAPTER },
    'mcp.servers': { classification: 'adapter', authorKey: 'mcp', inputShape: 'structured', adapter: MCP_ADAPTER },
    'mcp.discoverySources': { classification: 'adapter', authorKey: 'mcp', inputShape: 'structured', adapter: MCP_ADAPTER },
    'ui.views': { classification: 'adapter', authorKey: 'ui', inputShape: 'structured', adapter: UI_ADAPTER },
    'ui.renderers': { classification: 'adapter', authorKey: 'ui', inputShape: 'structured', adapter: UI_ADAPTER },
    'ui.settingsGroups': { classification: 'adapter', authorKey: 'ui', inputShape: 'structured', adapter: UI_ADAPTER },
    'ui.settingsPages': { classification: 'adapter', authorKey: 'ui', inputShape: 'structured', adapter: UI_ADAPTER },
    'ui.translations': { classification: 'adapter', authorKey: 'ui', inputShape: 'structured', adapter: UI_ADAPTER },
    notificationChannels: { classification: 'adapter', authorKey: 'notificationChannels', inputShape: 'structured', adapter: NOTIFICATION_CHANNELS_ADAPTER },
    scmHostingProviders: { classification: 'adapter', authorKey: 'scmHostingProviders', inputShape: 'structured', adapter: SCM_HOSTING_PROVIDERS_ADAPTER },
    scmBackends: { classification: 'adapter', authorKey: 'scmBackends', inputShape: 'structured', adapter: SCM_BACKENDS_ADAPTER },
    connectedAccountDescriptors: { classification: 'adapter', authorKey: 'connectedAccountDescriptors', inputShape: 'structured', adapter: CONNECTED_ACCOUNTS_ADAPTER },
    requestInterceptors: { classification: 'adapter', authorKey: 'requestInterceptors', inputShape: 'structured', adapter: REQUEST_INTERCEPTORS_ADAPTER },
    'settings.fields': { classification: 'adapter', authorKey: 'settings', inputShape: 'descriptor', adapter: SETTINGS_ADAPTER },
    providers: { classification: 'adapter', authorKey: 'providers', inputShape: 'structured', adapter: PROVIDERS_ADAPTER },
    voiceProviders: { classification: 'adapter', authorKey: 'voiceProviders', inputShape: 'structured', adapter: VOICE_PROVIDERS_ADAPTER },
    composerReferences: { classification: 'adapter', authorKey: 'composer', inputShape: 'structured', adapter: COMPOSER_ADAPTER },
    composerAttachments: { classification: 'adapter', authorKey: 'composer', inputShape: 'structured', adapter: COMPOSER_ADAPTER },
    composerControls: { classification: 'descriptor-only', authorKey: 'composer', inputShape: 'structured', adapter: COMPOSER_ADAPTER },
    composerRegions: { classification: 'descriptor-only', authorKey: 'composer', inputShape: 'structured', adapter: COMPOSER_ADAPTER },
    commands: { classification: 'descriptor-only', authorKey: 'commands', inputShape: 'descriptor', adapter: COMMANDS_ADAPTER },
    tools: { classification: 'descriptor-only', authorKey: 'tools', inputShape: 'descriptor', adapter: TOOLS_ADAPTER },
    resources: { classification: 'adapter', authorKey: 'resources', inputShape: 'descriptor', adapter: RESOURCES_ADAPTER },
    transcriptActivities: { classification: 'descriptor-only', authorKey: 'transcriptActivities', inputShape: 'descriptor', adapter: TRANSCRIPT_ACTIVITIES_ADAPTER },
    sessionHeaderActions: { classification: 'descriptor-only', authorKey: 'sessionHeaderActions', inputShape: 'descriptor', adapter: SESSION_HEADER_ACTIONS_ADAPTER },
    browserTargets: { classification: 'descriptor-only', authorKey: 'browserTargets', inputShape: 'descriptor', adapter: BROWSER_TARGETS_ADAPTER },
    browserActions: { classification: 'descriptor-only', authorKey: 'browserActions', inputShape: 'descriptor', adapter: BROWSER_ACTIONS_ADAPTER },
    settings: { classification: 'descriptor-only', authorKey: 'settings', inputShape: 'descriptor', adapter: SETTINGS_ADAPTER },
    executionRunProfiles: { classification: 'descriptor-only', authorKey: 'executionRunProfiles', inputShape: 'descriptor', adapter: EXECUTION_RUN_PROFILES_ADAPTER },
    notifications: { classification: 'descriptor-only', authorKey: 'notifications', inputShape: 'descriptor', adapter: NOTIFICATIONS_ADAPTER },
    managedDependencies: { classification: 'descriptor-only', authorKey: 'managedDependencies', inputShape: 'descriptor', adapter: MANAGED_DEPENDENCIES_ADAPTER },
    systemTools: { classification: 'descriptor-only', authorKey: 'systemTools', inputShape: 'descriptor', adapter: SYSTEM_TOOLS_ADAPTER },
    voiceModelPacks: { classification: 'descriptor-only', authorKey: 'voiceModelPacks', inputShape: 'descriptor', adapter: VOICE_MODEL_PACKS_ADAPTER },
    openableContentViewers: { classification: 'descriptor-only', authorKey: 'openableContentViewers', inputShape: 'descriptor', adapter: OPENABLE_CONTENT_VIEWERS_ADAPTER },
    accountCollections: { classification: 'descriptor-only', authorKey: 'accountCollections', inputShape: 'descriptor', adapter: ACCOUNT_COLLECTIONS_ADAPTER },
    daemonDatabases: { classification: 'descriptor-only', authorKey: 'daemonDatabases', inputShape: 'descriptor', adapter: DAEMON_DATABASES_ADAPTER },
    webhooks: { classification: 'descriptor-only', authorKey: 'webhooks', inputShape: 'descriptor', adapter: WEBHOOKS_ADAPTER },
    pluginContributionPoints: { classification: 'descriptor-only', authorKey: 'contributionPoints', inputShape: 'descriptor', adapter: CONTRIBUTION_POINTS_ADAPTER },
    targetedPluginContributions: { classification: 'descriptor-only', authorKey: 'contributesTo', inputShape: 'descriptor', adapter: CONTRIBUTES_TO_ADAPTER },
} as const satisfies Readonly<Record<string, DefinePluginFamilyPolicy>>);

type DefinePluginCatalogClosureEntry = Readonly<{
    manifestKey: string;
    allowedRuntimeRegistration: string | null;
}>;
type DefinePluginCatalogClosurePolicy = Readonly<Record<string, Readonly<{
    classification: string;
    authorKey?: string;
    inputShape?: string;
}>>>;

export function assertDefinePluginCatalogFamilyPolicyClosure(
    catalog: readonly DefinePluginCatalogClosureEntry[],
    policy: DefinePluginCatalogClosurePolicy,
): void {
    const catalogFamilies = catalog.map((entry) => entry.manifestKey);
    const policyFamilies = Object.keys(policy);
    const missingPolicies = catalogFamilies.filter((family) => !(family in policy));
    const extraPolicies = policyFamilies.filter((family) => !catalogFamilies.includes(family));
    const runtimeBearingOrNested = new Set(catalog.flatMap((entry) => (
        entry.allowedRuntimeRegistration !== null || entry.manifestKey.includes('.')
            ? [entry.manifestKey]
            : []
    )));
    const expectedAdapters = [...runtimeBearingOrNested];
    const actualAdapters = policyFamilies.filter((family) => policy[family]?.classification === 'adapter');
    const missingAdapters = expectedAdapters.filter((family) => !actualAdapters.includes(family));
    const extraAdapters = actualAdapters.filter((family) => !runtimeBearingOrNested.has(family));
    const expectedDescriptors = catalogFamilies.filter((family) => !runtimeBearingOrNested.has(family));
    const actualDescriptors = policyFamilies.filter((family) => policy[family]?.classification === 'descriptor-only');
    const missingDescriptors = expectedDescriptors.filter((family) => !actualDescriptors.includes(family));
    const extraDescriptors = actualDescriptors.filter((family) => !expectedDescriptors.includes(family));
    const duplicateCatalogFamilies = catalogFamilies.filter((family, index) => (
        catalogFamilies.indexOf(family) !== index
    ));
    if (missingPolicies.length > 0
        || extraPolicies.length > 0
        || missingAdapters.length > 0
        || extraAdapters.length > 0
        || missingDescriptors.length > 0
        || extraDescriptors.length > 0
        || duplicateCatalogFamilies.length > 0) {
        throw new Error([
            'definePlugin family policy does not close over the Protocol contribution catalog',
            ...(missingPolicies.length > 0 ? [`missing family policies: ${missingPolicies.join(', ')}`] : []),
            ...(extraPolicies.length > 0 ? [`extra family policies: ${extraPolicies.join(', ')}`] : []),
            ...(missingAdapters.length > 0 ? [`missing adapters: ${missingAdapters.join(', ')}`] : []),
            ...(extraAdapters.length > 0 ? [`extra adapters: ${extraAdapters.join(', ')}`] : []),
            ...(missingDescriptors.length > 0 ? [`missing descriptor-only policies: ${missingDescriptors.join(', ')}`] : []),
            ...(extraDescriptors.length > 0 ? [`extra descriptor-only policies: ${extraDescriptors.join(', ')}`] : []),
            ...(duplicateCatalogFamilies.length > 0
                ? [`duplicate catalog families: ${[...new Set(duplicateCatalogFamilies)].join(', ')}`]
                : []),
        ].join('; '));
    }
}

function listDefinePluginAuthorAdapters(): readonly DefinePluginFamilyAdapter[] {
    const adapters = new Map<string, DefinePluginFamilyAdapter>();
    for (const familyPolicy of Object.values(DEFINE_PLUGIN_FAMILY_POLICY_V2)) {
        if (familyPolicy.adapter.authorKey !== familyPolicy.authorKey) {
            throw new Error(`definePlugin adapter for '${familyPolicy.authorKey}' declares a different author key`);
        }
        const existing = adapters.get(familyPolicy.authorKey);
        if (existing !== undefined && existing !== familyPolicy.adapter) {
            throw new Error(`definePlugin author key '${familyPolicy.authorKey}' has competing adapters`);
        }
        adapters.set(familyPolicy.authorKey, familyPolicy.adapter);
    }
    return Object.freeze([...adapters.values()]);
}

const DEFINE_PLUGIN_AUTHOR_ADAPTERS = listDefinePluginAuthorAdapters();

export function deriveDefinePluginDescriptorOnlyContributionFamilies(
    catalog: readonly DefinePluginCatalogClosureEntry[],
): readonly (keyof PluginManifestContributes)[] {
    assertDefinePluginCatalogFamilyPolicyClosure(catalog, DEFINE_PLUGIN_FAMILY_POLICY_V2);
    return Object.freeze([
        ...new Set(Object.values(DEFINE_PLUGIN_FAMILY_POLICY_V2).flatMap((familyPolicy) => (
            familyPolicy.inputShape === 'descriptor'
                ? [familyPolicy.authorKey as keyof PluginManifestContributes]
                : []
        ))),
    ]);
}

const DEFINE_PLUGIN_BASE_KEYS = Object.freeze([
    'id',
    'version',
    'displayName',
    'description',
    'engines',
    'runtime',
    'entrypoints',
    'brand',
    'activation',
    'hostAccess',
    'metadata',
    'setup',
] as const);
const DEFINE_PLUGIN_ALLOWED_KEYS = new Set<string>([
    ...DEFINE_PLUGIN_BASE_KEYS,
    ...DEFINE_PLUGIN_AUTHOR_ADAPTERS.map((adapter) => adapter.authorKey),
]);

function assertDefinePluginOwnKeys(input: object): void {
    for (const key of Object.keys(input)) {
        if (key === 'contributes') {
            throw new TypeError("Raw contributes belongs to the manual named ABI and is not accepted by definePlugin");
        }
        if (!DEFINE_PLUGIN_ALLOWED_KEYS.has(key)) {
            throw new TypeError(`definePlugin input contains unknown field '${key}'`);
        }
    }
}

function invalidManifestMessage(
    result: Exclude<PluginManifestParseResult, { ok: true }>,
): string {
    return formatPluginManifestIngestionDiagnostics(result.diagnostics);
}

function definePluginImplementation<
    const TActions extends Readonly<Record<string, PluginActionDeclaration>> = Readonly<Record<string, never>>,
    const TAgents extends Readonly<Record<string, PluginAgentDefinition>> = Readonly<Record<string, never>>,
    const TPromptAssets extends Readonly<Record<PluginContributionLocalId, PluginPromptAssetDefinition>> = Readonly<
        Record<string, never>
    >,
    const TPluginId extends string = string,
    const TContributionPoints extends Readonly<Record<
        PluginContributionLocalId,
        ContributionPointAuthorDefinition
    >> = Readonly<Record<string, never>>,
>(input: DefinePluginInput<
    TActions,
    TAgents,
    TPromptAssets,
    Readonly<Record<PluginContributionLocalId, PluginAccountCollectionDefinition>>,
    TPluginId,
    TContributionPoints
>): DefinedPlugin<
    TPluginId,
    DefinedPluginActionContracts<TPluginId, TActions>,
    DefinedContributionPointProtocolMap<TContributionPoints>
> {
    assertDefinePluginOwnKeys(input);
    const authorInput = input as Readonly<Record<string, unknown>>;
    const contributes = Object.assign(
        {},
        ...DEFINE_PLUGIN_AUTHOR_ADAPTERS.map((adapter) => adapter.project(authorInput)),
    ) as PluginManifestContributes;

    const authoredManifest: PluginManifest = {
        schemaVersion: 2,
        id: input.id,
        version: input.version,
        displayName: input.displayName ?? input.id,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.engines === undefined ? {} : { engines: input.engines }),
        runtime: input.runtime ?? { apiVersion: 1 },
        ...(input.entrypoints === undefined ? {} : { entrypoints: input.entrypoints }),
        ...(input.brand === undefined ? {} : { brand: input.brand }),
        ...(input.activation === undefined ? {} : { activation: input.activation }),
        hostAccess: input.hostAccess ?? { required: [], optional: [] },
        contributes,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    const parsed = parsePluginManifest(authoredManifest);
    if (!parsed.ok) {
        throw new TypeError(`Plugin definition is invalid: ${invalidManifestMessage(parsed)}`);
    }
    const manifest = parsed.manifest;
    assertAgentRunnerDefinitions(input.agents, manifest.contributes.agents);
    const daemonDatabases = normalizePluginDaemonDatabaseRuntimeProjection(
        authorInput.daemonDatabases,
        manifest.contributes.daemonDatabases,
    );
    const collectionMigrations = normalizePluginAccountCollectionMigrationRuntimeProjection(
        projectPluginAccountCollectionMigrationRuntimeProjection(authorInput.accountCollections),
        manifest.contributes.accountCollections,
    );
    const actionContracts = projectActionContracts(input.id, authorInput.actions) as DefinedPlugin<
        TPluginId,
        DefinedPluginActionContracts<TPluginId, TActions>,
        DefinedContributionPointProtocolMap<TContributionPoints>
    >['actionContracts'];
    const contributionPoints = projectDefinedTargetedContributionPoints(
        input.id,
        input.contributionPoints,
    );
    const semanticPointRefs: TargetedContributionPointRef<unknown>[] = [];
    // The mapped generic retains its tuple lengths through Object.values,
    // while this boundary needs only the runtime single-vs-epoch-group shape
    // guaranteed by projectDefinedTargetedContributionPoints above.
    for (const point of Object.values(contributionPoints) as unknown as readonly (
        TargetedContributionPointRef<unknown>
        | Readonly<{ protocols: readonly TargetedContributionPointRef<unknown>[] }>
    )[]) {
        if ('protocols' in point) {
            semanticPointRefs.push(...point.protocols);
        } else {
            semanticPointRefs.push(point);
        }
    }
    attachTargetedContributionPointSemanticRefs(
        manifest.contributes.pluginContributionPoints,
        semanticPointRefs,
    );

    const activate: PluginActivationModule['activate'] = async (api) => {
        for (const adapter of DEFINE_PLUGIN_AUTHOR_ADAPTERS) {
            adapter.activate?.(authorInput, api);
        }
        return await input.setup?.(api);
    };

    return Object.freeze({
        manifest,
        activate,
        actionContracts,
        contributionPoints,
        daemonDatabases,
        collectionMigrations,
    });
}

export const definePlugin: <
    const TActions extends Readonly<Record<string, PluginActionDeclaration>> = Readonly<Record<string, never>>,
    const TAgents extends Readonly<Record<string, PluginAgentDefinition>> = Readonly<Record<string, never>>,
    const TPromptAssets extends Readonly<Record<PluginContributionLocalId, PluginPromptAssetDefinition>> = Readonly<
        Record<string, never>
    >,
    const TAccountCollections extends Readonly<Record<
        PluginContributionLocalId,
        PluginAccountCollectionDefinition
    >> = Readonly<Record<PluginContributionLocalId, PluginAccountCollectionDefinition>>,
    const TPluginId extends string = string,
    const TContributionPoints extends Readonly<Record<
        PluginContributionLocalId,
        ContributionPointAuthorDefinition
    >> = Readonly<Record<string, never>>,
>(
    input: DefinePluginInput<
        TActions,
        TAgents,
        TPromptAssets,
        TAccountCollections,
        TPluginId,
        TContributionPoints
    >,
) => DefinedPlugin<
    TPluginId,
    DefinedPluginActionContracts<TPluginId, TActions>,
    DefinedContributionPointProtocolMap<TContributionPoints>
> = function definePlugin(input) {
    return definePluginImplementation(input);
};
