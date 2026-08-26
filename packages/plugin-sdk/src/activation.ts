/** @moduleRealm daemon */
import type {
    AgentCliAuthContributionV1,
    AgentRuntimeFactory,
    AgentRuntimeRegistrationOptions,
} from './agentRuntime/index.js';
import type {
    ActionHandler,
    PluginClientActionHandler,
} from './actions/service.js';
import type {
    JsonValue,
    PluginContributionLocalId,
    PluginJsonValueV2,
    PluginReference,
} from './identity.js';
import type { BackgroundServicesRegistrationApi } from './backgroundServices.js';
import type {
    ComposerReferenceCandidatePageV1,
    ComposerReferenceResolutionV1,
} from './composerReferenceProviders.js';
import type { ComposerStagedMediaContentV1 } from './composer.js';
import type { PluginInvocationContext } from './invocation.js';
import type { Disposable } from './lifecycle.js';
import type { BackendRuntimeRegistration } from './scm/backend.js';
import type { HostingProviderRuntimeRegistration } from './scm/hostingProvider.js';
import type { ProvidersRegistrationApi } from './managed-services/contract.js';
import type {
    PluginConnectedAccountRegistrationApi,
} from './services/index.js';
import type { HttpMethod } from './services/io.js';
import type {
    PluginMcpDiscoveredServer,
    PluginMcpGetPromptResult,
    PluginMcpPromptPage,
    PluginMcpReadResourceResult,
    PluginMcpResourcePage,
    PluginMcpResourceTemplatePage,
    PluginMcpResourceUpdatedEvent,
    PluginMcpTool,
    PluginMcpToolPage,
    PluginNotificationSendResult as NotificationSendResult,
    PluginDynamicResourceRuntime,
} from './services/resources.js';
import type { PromptAssetAdapter } from './resources.js';
import type { AgentExternalSessionsContribution } from './externalSessions.js';
import type { AgentExternalSessionObservationContribution } from './externalSessionObservation.js';
import type {
    AgentExternalSessionHooksContribution,
} from './externalSessionHooks.js';
import type {
    AgentExternalSessionTakeoverContribution,
} from './sessions/externalSessionTakeover.js';
import type { PluginUiIconTokenV1 } from './ui.js';
import type { VoiceProvidersRegistrationApi } from './voice/projections.js';

/** SDK author projection of one exact attachment callback instance. */
export type ComposerAttachmentPrepareRequestV1<
    TDraft extends JsonValue = JsonValue,
> = Readonly<{
    sessionId: string;
    localId: string;
    attachments: readonly Readonly<{
        instanceId: string;
        key: string;
        value: TDraft;
        content?: ComposerStagedMediaContentV1;
    }>[];
}>;

/** SDK author projection of one prepare callback outcome. */
export type ComposerAttachmentPrepareOutcomeV1<
    TPrepared extends JsonValue = PluginJsonValueV2,
> =
    | Readonly<{
        instanceId: string;
        status: 'ready';
        value: TPrepared;
        content?: ComposerStagedMediaContentV1;
        presentation?: {
            label: string;
            description?: string;
            icon?: PluginUiIconTokenV1;
            tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
        };
    }>
    | Readonly<{
        instanceId: string;
        status: 'invalid' | 'unavailable' | 'failed';
        retryable: boolean;
        message?: string;
    }>;

/** SDK author projection of the exact prepare callback result batch. */
export type ComposerAttachmentPrepareResultV1<
    TPrepared extends JsonValue = PluginJsonValueV2,
> = Readonly<{
    attachments: readonly ComposerAttachmentPrepareOutcomeV1<TPrepared>[];
}>;

/** SDK author projection of one fresh pre-dispatch attachment batch. */
export type ComposerAttachmentResolveRequestV1<
    TPrepared extends JsonValue = JsonValue,
> = Readonly<{
    sessionId: string;
    localId: string;
    attachments: readonly Readonly<{
        instanceId: string;
        key: string;
        value: TPrepared;
    }>[];
}>;

/** SDK author projection of the exact pre-dispatch resolution result batch. */
export type ComposerAttachmentResolveResultV1 = Readonly<{
    attachments: readonly (
        | Readonly<{
            instanceId: string;
            status: 'ready';
            context?: string;
            data?: PluginJsonValueV2;
        }>
        | Readonly<{
            instanceId: string;
            status: 'unavailable' | 'notFound' | 'invalid' | 'failed';
            retryable: boolean;
            message?: string;
        }>
    )[];
}>;

/** SDK author projection of the post-durable-admission attachment notification batch. */
export type ComposerAttachmentMessageAcceptedV1<
    TPrepared extends JsonValue = JsonValue,
> = Readonly<{
    sessionId: string;
    localId: string;
    attachments: readonly Readonly<{
        instanceId: string;
        key: string;
        value: TPrepared;
    }>[];
}>;
export type {
    AgentExternalSessionCandidate,
    AgentExternalSessionLinkData,
    AgentExternalSessionLinkDataValue,
    AgentExternalSessionSource,
    AgentExternalSessionTranscriptItem,
    AgentExternalSessionsContribution,
    AgentExternalSessionsFailureCode,
    AgentExternalSessionsInvocation,
    AgentExternalSessionsListCandidatesRequest,
    AgentExternalSessionsListCandidatesResult,
    AgentExternalSessionsPageTranscriptRequest,
    AgentExternalSessionsReadAfterTranscriptRequest,
    AgentExternalSessionsResult,
    AgentExternalSessionsResolvedIdentity,
    AgentExternalSessionsResolveLinkedIdentityRequest,
    AgentExternalSessionsResolveLinkIdentityRequest,
    AgentExternalSessionsResolveSourceRequest,
    AgentExternalSessionsResolveSourceResult,
    AgentExternalSessionsTranscriptPage,
} from './externalSessions.js';
export type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionObservationDescribeResourceRequest,
    AgentExternalSessionObservationObserveResourceRequest,
    AgentExternalSessionObservationReconcileLink,
    AgentExternalSessionObservationReconcileResourceRequest,
} from './externalSessionObservation.js';
export type { ActionHandler } from './actions/service.js';
export type HookHandler<TPayload extends JsonValue = JsonValue, TResult extends JsonValue | void = JsonValue | void> =
    (payload: TPayload, context: PluginInvocationContext) => TResult | Promise<TResult>;
/** @realm any */
export type PluginEventHandler<TPayload extends JsonValue = JsonValue> =
    (payload: TPayload, context: PluginInvocationContext) => void | Promise<void>;
export type PluginNotificationSendRequest = Readonly<{
    clientRequestId: string;
    deliveryId: string;
    categoryId: string;
    channelId: string;
    title: string;
    body?: string;
    data?: JsonValue;
}>;
export type PluginNotificationSendResult = NotificationSendResult;
export type PluginNotificationSender = (
    request: PluginNotificationSendRequest,
    context: PluginInvocationContext,
) => PluginNotificationSendResult | Promise<PluginNotificationSendResult>;
export interface PluginNotificationRegistrationApi {
    registerChannel(id: string, sender: PluginNotificationSender): void;
}

/** @realm daemon */
export type ComposerReferenceRuntime = Readonly<{
    search(query: string, context: PluginInvocationContext): Promise<ComposerReferenceCandidatePageV1>;
    resolve(candidateId: string, context: PluginInvocationContext): Promise<ComposerReferenceResolutionV1>;
}>;
/** @realm daemon */
export interface ComposerReferencesRegistrationApi {
    register(id: string, runtime: ComposerReferenceRuntime): void;
}

/** @realm daemon */
export type ComposerAttachmentRuntime<
    TDraft extends JsonValue = JsonValue,
    TPrepared extends JsonValue = TDraft,
> = Readonly<{
    prepareForSend?(
        request: ComposerAttachmentPrepareRequestV1<TDraft>,
        context: PluginInvocationContext,
    ): Promise<ComposerAttachmentPrepareResultV1<TPrepared>>;
    resolveForDispatch?(
        request: ComposerAttachmentResolveRequestV1<TPrepared>,
        context: PluginInvocationContext,
    ): Promise<ComposerAttachmentResolveResultV1>;
    /** Best-effort post-durable-admission notification; it receives only sessionId plus localId. */
    afterMessageAccepted?(
        event: ComposerAttachmentMessageAcceptedV1<TPrepared>,
        context: PluginInvocationContext,
    ): Promise<void>;
}>;
/** @realm daemon */
export interface ComposerAttachmentsRegistrationApi {
    register(id: string, runtime: ComposerAttachmentRuntime): void;
}

export type HostingProviderRuntime = Omit<HostingProviderRuntimeRegistration, 'id'>;
export type BackendRuntime = Omit<BackendRuntimeRegistration, 'id'>;
export interface PluginScmRegistrationApi {
    registerHostingProvider(id: string, runtime: HostingProviderRuntime): void;
    registerBackend(id: string, runtime: BackendRuntime): void;
}

export type PluginMcpListToolsRequest = Readonly<{ cursor?: string; limit?: number }>;
export type PluginMcpListToolsResult = PluginMcpToolPage;
export type PluginMcpToolCallRequest = Readonly<{ name: string; input: JsonValue }>;
export type PluginMcpPageRequest = Readonly<{ cursor?: string }>;
export type PluginMcpReadResourceRequest = Readonly<{ uri: string }>;
export type PluginMcpSubscribeResourceRequest = Readonly<{ uri: string }>;
export type PluginMcpGetPromptRequest = Readonly<{ name: string; args?: Readonly<Record<string, string>> }>;
export type PluginMcpToolCallContent =
    | Readonly<{ kind: 'text'; text: string }>
    | Readonly<{ kind: 'resource'; resource: PluginReference; contentType?: string }>
    | Readonly<{ kind: 'json'; value: JsonValue }>;
export type PluginMcpToolCallResult = Readonly<{
    content: readonly PluginMcpToolCallContent[];
    isError?: boolean;
}>;
export interface PluginMcpServerRuntime extends Disposable {
    listTools(request: PluginMcpListToolsRequest, context: PluginInvocationContext, options?: { signal?: AbortSignal }): Promise<PluginMcpToolPage>;
    callTool(request: PluginMcpToolCallRequest, context: PluginInvocationContext, options?: { signal?: AbortSignal }): Promise<PluginMcpToolCallResult>;
    listResources(request: PluginMcpPageRequest, context: PluginInvocationContext, options?: { signal?: AbortSignal }): Promise<PluginMcpResourcePage>;
    listResourceTemplates(request: PluginMcpPageRequest, context: PluginInvocationContext, options?: { signal?: AbortSignal }): Promise<PluginMcpResourceTemplatePage>;
    readResource(request: PluginMcpReadResourceRequest, context: PluginInvocationContext, options?: { signal?: AbortSignal }): Promise<PluginMcpReadResourceResult>;
    subscribeResource(
        request: PluginMcpSubscribeResourceRequest,
        listener: (event: PluginMcpResourceUpdatedEvent) => void | Promise<void>,
        context: PluginInvocationContext,
        options?: { signal?: AbortSignal },
    ): Promise<Disposable>;
    listPrompts(request: PluginMcpPageRequest, context: PluginInvocationContext, options?: { signal?: AbortSignal }): Promise<PluginMcpPromptPage>;
    getPrompt(request: PluginMcpGetPromptRequest, context: PluginInvocationContext, options?: { signal?: AbortSignal }): Promise<PluginMcpGetPromptResult>;
}
export type PluginMcpDiscoveryRequest = Readonly<{
    query?: string;
    cursor?: string;
    limit?: number;
    sessionId?: string;
    accountId?: string | null;
    workspaceId?: string | null;
    directory?: string | null;
}>;
export type PluginMcpDiscoveredEndpoint = Readonly<{
    id: string;
    name: string;
    kind: 'http' | 'sse';
    url: string;
}>;
export type PluginMcpDiscoveryResult = Readonly<{
    items: readonly PluginMcpDiscoveredServer[];
    nextCursor?: string;
    endpoints?: readonly PluginMcpDiscoveredEndpoint[];
    warnings?: readonly Readonly<{
        code: 'read_failed' | 'parse_failed' | 'unsupported';
        path?: string;
        detail?: string;
    }>[];
}>;
export type PluginMcpDiscoveryHandler = (
    request: PluginMcpDiscoveryRequest,
    context: PluginInvocationContext,
) => PluginMcpDiscoveryResult | Promise<PluginMcpDiscoveryResult>;
export interface PluginMcpRegistrationApi {
    registerServer(id: string, runtime: PluginMcpServerRuntime): void;
    registerDiscoverySource(
        id: string,
        discover: PluginMcpDiscoveryHandler,
    ): void;
}

export type PluginInterceptedRequest = Readonly<{
    url: string;
    method: HttpMethod;
    headers: Readonly<Record<string, string>>;
}>;
export type PluginInterceptorResult =
    | Readonly<{ decision: 'continue'; request: PluginInterceptedRequest }>
    | Readonly<{ decision: 'deny'; code: string }>;
export type PluginRequestInterceptor = (request: PluginInterceptedRequest, context: PluginInvocationContext) =>
    PluginInterceptorResult | Promise<PluginInterceptorResult>;
export interface PluginInterceptorRegistrationApi { register(id: string, interceptor: PluginRequestInterceptor): void }

export interface ResourcesRegistrationApi {
    registerPromptAssetAdapter(
        localId: PluginContributionLocalId,
        adapter: PromptAssetAdapter,
    ): void;
    /**
     * Bind the runtime producer for one manifest-declared dynamic resource
     * (`contributes.resources[].source === 'dynamic'`). Packaged resources are
     * package bytes and must not be registered.
     */
    registerDynamicResource(
        localId: PluginContributionLocalId,
        runtime: PluginDynamicResourceRuntime,
    ): void;
}

export type PluginCleanup = () => void | Promise<void>;

/** The daemon/root activation API. */
export interface PluginApi {
    readonly actions: {
        register<I extends JsonValue = JsonValue, O extends JsonValue | void = JsonValue | void>(
            id: string,
            handler: ActionHandler<I, O>,
        ): void;
    };
    readonly hooks: { register(id: string, handler: HookHandler): void };
    readonly events: { register<TPayload extends JsonValue = JsonValue>(subscriptionId: string, handler: PluginEventHandler<TPayload>): void };
    readonly agents: {
        register(
            id: string,
            factory: AgentRuntimeFactory,
            options?: AgentRuntimeRegistrationOptions,
        ): void;
        /**
         * Registers the focused auth interpretation for a declarative Agent
         * whose runtime remains host-owned (for example an ACP Agent).
         */
        registerCliAuth(id: string, contribution: AgentCliAuthContributionV1): void;
        registerExternalSessions(id: string, contribution: AgentExternalSessionsContribution): void;
        registerExternalSessionHooks(
            id: string,
            contribution: AgentExternalSessionHooksContribution,
        ): void;
        registerExternalSessionObservation(
            id: string,
            contribution: AgentExternalSessionObservationContribution,
        ): void;
        registerExternalSessionTakeover(
            id: string,
            contribution: AgentExternalSessionTakeoverContribution,
        ): void;
    };
    readonly notifications: PluginNotificationRegistrationApi;
    readonly connectedAccounts: PluginConnectedAccountRegistrationApi;
    readonly providers: ProvidersRegistrationApi;
    readonly scm: PluginScmRegistrationApi;
    readonly mcp: PluginMcpRegistrationApi;
    readonly interceptors: PluginInterceptorRegistrationApi;
    readonly voiceProviders: VoiceProvidersRegistrationApi;
    readonly composerReferences: ComposerReferencesRegistrationApi;
    readonly composerAttachments: ComposerAttachmentsRegistrationApi;
    readonly resources: ResourcesRegistrationApi;
    readonly backgroundServices: BackgroundServicesRegistrationApi;
}

/**
 * The client-artifact activation API. Client targets may register only the
 * two manifest families the catalog authorizes in a client realm.
 * @realm client
 */
export interface PluginClientApi {
    readonly actions: {
        register<I extends JsonValue = JsonValue, O extends JsonValue | void = JsonValue | void>(
            id: string,
            handler: PluginClientActionHandler<I, O>,
        ): void;
    };
    readonly voiceProviders: VoiceProvidersRegistrationApi;
}

/** @realm any */
export type PluginActivationModule = Readonly<{
    activate(api: PluginApi): void | PluginCleanup | Promise<void | PluginCleanup>;
}>;

/**
 * The ordinary activation ABI for one exact client artifact/module target.
 * It names only `PluginClientApi`, so it shares that owner's client realm
 * rather than this module's daemon default.
 * @realm client
 */
export type PluginClientActivationModule = Readonly<{
    activate(api: PluginClientApi): void | PluginCleanup | Promise<void | PluginCleanup>;
}>;
