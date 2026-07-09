import type {
    PluginActionContributionV2,
    PluginCommandContributionV2,
    PluginHookContributionV2,
    PluginHookIdV1,
    PluginHookPayloadSchemaMapV1,
    PluginNotificationCategoryContributionV2,
    PluginNotificationChannelContributionV2,
    PluginToolContributionV2,
} from '@happier-dev/protocol';

import type { RegisterAgentRuntimeV1 } from './engine.js';
import type { RegisterDaemonAuthBridgeV1 } from './agentRuntime/authBridge.js';
import type { PluginApiRequestInterceptorRegistrationV1 } from './fetch.js';
import type {
    McpDiscoveryProviderReturnV1,
    McpResolveForSessionInputV1,
    McpServerSpecV1,
} from './mcp.js';
import type { ScmBackendRuntimeRegistration } from './scm/backend.js';
import type { ScmHostingProviderRuntimeRegistration } from './scm/hostingProvider.js';
import type { PluginHandlerServicesV1 } from './context.js';

export type { PluginApiRequestInterceptorRegistrationV1 } from './fetch.js';
export type {
    ScmBackendCommandRunResult,
    ScmBackendRuntimeRegistration,
    ScmBackendRuntimeServices,
} from './scm/backend.js';

export type PluginDisposable = (() => void | Promise<void>) | Readonly<{
    dispose: () => void | Promise<void>;
}>;

type InferProtocolSchemaOutput<TSchema> = TSchema extends { parse(input: unknown): infer TOutput }
    ? TOutput
    : never;

export type PluginHookPayloadMapV1 = Readonly<{
    [THookId in PluginHookIdV1]: InferProtocolSchemaOutput<PluginHookPayloadSchemaMapV1[THookId]>;
}>;

type PluginHookLifecycleResultV1 = void;
type PluginHookAugmentationResultV1 = Readonly<Record<string, unknown>> | void;
type PluginHookDecisionResultV1 = unknown;

export type PluginHookResultMapV1 = Readonly<{
    'session.spawned': PluginHookLifecycleResultV1;
    'session.message.send': PluginHookLifecycleResultV1;
    'session.input.transform': PluginHookPayloadMapV1['session.input.transform'] | void;
    'executionRun.started': PluginHookLifecycleResultV1;
    'executionRun.messageSent': PluginHookLifecycleResultV1;
    'executionRun.stopped': PluginHookLifecycleResultV1;
    'executionRun.completed': PluginHookLifecycleResultV1;
    'agent.resolvePrerequisites': PluginHookDecisionResultV1;
    'agent.spawnEnv.augment': PluginHookAugmentationResultV1;
    'agent.response.after': PluginHookLifecycleResultV1;
    'agent.context.before': PluginHookPayloadMapV1['agent.context.before'] | void;
    'agent.request.before': PluginHookPayloadMapV1['agent.request.before'] | void;
    'agent.stream.token': PluginHookLifecycleResultV1;
    'tool.call.before': PluginHookDecisionResultV1;
    'tool.result.after': PluginHookLifecycleResultV1;
    'resource.discovery': PluginHookAugmentationResultV1;
    'plugin.reload.before': PluginHookLifecycleResultV1;
    'plugin.reload.after': PluginHookLifecycleResultV1;
    'session.attached': PluginHookLifecycleResultV1;
    'session.detached': PluginHookLifecycleResultV1;
    'voice.session.started': PluginHookLifecycleResultV1;
    'voice.session.ended': PluginHookLifecycleResultV1;
    'voice.turn.started': PluginHookLifecycleResultV1;
    'voice.turn.ended': PluginHookLifecycleResultV1;
    'voice.transcript.partial': PluginHookLifecycleResultV1;
    'voice.transcript.final': PluginHookLifecycleResultV1;
    'memory.shard.generated': PluginHookLifecycleResultV1;
    'memory.search.performed': PluginHookLifecycleResultV1;
    'memory.index.updated': PluginHookLifecycleResultV1;
    'memory.gc.performed': PluginHookLifecycleResultV1;
    'automation.scheduled': PluginHookLifecycleResultV1;
    'automation.claimed': PluginHookLifecycleResultV1;
    'automation.run.started': PluginHookLifecycleResultV1;
    'automation.run.succeeded': PluginHookLifecycleResultV1;
    'automation.run.failed': PluginHookLifecycleResultV1;
    'automation.run.expired': PluginHookLifecycleResultV1;
    'approval.decision.made': PluginHookLifecycleResultV1;
    'subagent.started': PluginHookLifecycleResultV1;
    'subagent.ended': PluginHookLifecycleResultV1;
}>;

export type PluginHookHandlerContextV1<THookId extends PluginHookIdV1 = PluginHookIdV1> = Readonly<{
    hookId: THookId;
    signal?: AbortSignal;
} & PluginHandlerServicesV1>;

export type PluginHookHandler<THookId extends PluginHookIdV1 = PluginHookIdV1> = (
    payload: PluginHookPayloadMapV1[THookId],
    context: PluginHookHandlerContextV1<THookId>,
) => PluginHookResultMapV1[THookId] | Promise<PluginHookResultMapV1[THookId]>;

export type PluginHookPayloadEnvelopeV1 = Readonly<{
    payload?: unknown;
}>;

export function toPluginHookPayloadEnvelope<TEnvelope extends PluginHookPayloadEnvelopeV1 = PluginHookPayloadEnvelopeV1>(
    value: unknown,
): TEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {} as TEnvelope;
    }
    const record = value as Readonly<Record<string, unknown>>;
    return (
        Object.prototype.hasOwnProperty.call(record, 'payload')
            ? { payload: record.payload }
            : { payload: value }
    ) as TEnvelope;
}

export function toPluginHookObjectContext<TContext>(value: unknown): TContext | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as TContext
        : undefined;
}

export type PluginActionSurface = 'cli' | 'mcp' | 'agent';

export type PluginActionHandlerRequest = Readonly<{
    actionId: string;
    pluginId: string;
    input: unknown;
    context: Readonly<{
        defaultSessionId?: string;
        surface: PluginActionSurface;
    } & PluginHandlerServicesV1>;
    provenance: Readonly<{
        manifestPath?: string;
        manifestDigest?: string;
        sourceKind?: string;
    }>;
}>;

export type PluginActionDiagnosticV1 = Readonly<{
    code: string;
    message?: string;
    details?: unknown;
}>;

export type PluginActionUiHintsV1 = Readonly<Record<string, unknown>>;

export type PluginActionErrorV1 = Readonly<{
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
}>;

export type PluginActionResultV1<TData = unknown> =
    | Readonly<{
        ok: true;
        data?: TData;
        diagnostics?: readonly PluginActionDiagnosticV1[];
        ui?: PluginActionUiHintsV1;
    }>
    | Readonly<{
        ok: false;
        error: PluginActionErrorV1;
        diagnostics?: readonly PluginActionDiagnosticV1[];
        ui?: PluginActionUiHintsV1;
    }>;

export type PluginActionHandler<TInput = unknown, TData = unknown> = (
    request: PluginActionHandlerRequest & Readonly<{ input: TInput }>,
) => PluginActionResultV1<TData> | Promise<PluginActionResultV1<TData>>;

export type PluginLifecycleEvent = 'activated' | 'deactivating' | 'deactivated';

export type PluginLifecycleHandlerRequest = Readonly<{
    event: PluginLifecycleEvent;
    pluginId: string;
    generation: number;
    provenance: Readonly<{
        manifestPath?: string;
        manifestDigest?: string;
        sourceKind?: string;
    }>;
}>;

export type PluginLifecycleHandler = (request: PluginLifecycleHandlerRequest) => unknown | Promise<unknown>;

export type PluginApiHookRegistrationV1<THookId extends PluginHookIdV1 = PluginHookIdV1> = Readonly<{
    hookId: THookId;
    priority?: number;
    category?: PluginHookContributionV2['category'];
    scope?: PluginHookContributionV2['scope'];
    filters?: PluginHookContributionV2['filters'];
    executionKind?: PluginHookContributionV2['executionKind'];
    handler: PluginHookHandler<THookId>;
}>;

export type PluginApiAgentRuntimeRegistrationV1 = RegisterAgentRuntimeV1;
export type PluginApiDaemonAuthBridgeRegistrationV1 = RegisterDaemonAuthBridgeV1;

export type PluginApiActionRegistrationV1 = Readonly<{
    id: string;
    handler: PluginActionHandler;
}>;

export type PluginApiToolRegistrationV1 = Readonly<{
    id: string;
    handler: PluginActionHandler;
}>;

export type PluginCommandVisibilityV1 = 'default' | 'advanced' | 'internal';

export type PluginApiCommandRegistrationV1 = Readonly<{
    id: string;
    handler: PluginActionHandler;
}>;

export type PluginApiLifecycleHandlerRegistrationV1 = Readonly<{
    id: string;
    event: PluginLifecycleEvent;
    priority?: number;
    handler: PluginLifecycleHandler;
}>;

export type PluginNotificationChannelSendRequestV1 = Readonly<{
    categoryId: string;
    channelId: string;
    title: string;
    body?: string | null;
    payload?: unknown;
}>;

export type PluginNotificationChannelSendResultV1 = Readonly<{
    delivered: boolean;
}>;

export type PluginNotificationChannelSenderV1 = (
    request: PluginNotificationChannelSendRequestV1,
) => Promise<PluginNotificationChannelSendResultV1> | PluginNotificationChannelSendResultV1;

export type PluginApiNotificationCategoryRegistrationV1 = Readonly<{
    id: string;
    kind: PluginNotificationCategoryContributionV2['kind'];
    title: string;
    description?: string | null;
    eventIds?: PluginNotificationCategoryContributionV2['eventIds'];
    defaultChannelIds?: PluginNotificationCategoryContributionV2['defaultChannelIds'];
}>;

export type PluginApiNotificationChannelRegistrationV1 = Readonly<{
    id: string;
    kind: PluginNotificationChannelContributionV2['kind'];
    title: string;
    description?: string | null;
    configurable?: PluginNotificationChannelContributionV2['configurable'];
    defaultEnabled?: PluginNotificationChannelContributionV2['defaultEnabled'];
    send: PluginNotificationChannelSenderV1;
}>;

export type PluginApiMcpServerRegistrationV1 = McpServerSpecV1;

export type PluginApiMcpDiscoveryProviderRegistrationV1 = Readonly<{
    id: string;
    discover(input?: McpResolveForSessionInputV1): Promise<McpDiscoveryProviderReturnV1> | McpDiscoveryProviderReturnV1;
}>;

export type PluginApiRegisterMethodV1<TRegistration = unknown> = (
    registration: TRegistration,
) => PluginDisposable;

export type PluginApiRegisterMethodMapV1 = Readonly<Record<string, PluginApiRegisterMethodV1<never>>>;

export type PluginApiCoreV1 = Readonly<{
    registerAgentRuntime: (registration: PluginApiAgentRuntimeRegistrationV1) => PluginDisposable;
    registerDaemonAuthBridge: (registration: PluginApiDaemonAuthBridgeRegistrationV1) => PluginDisposable;
    registerAction: (registration: PluginApiActionRegistrationV1) => PluginDisposable;
    registerTool: (registration: PluginApiToolRegistrationV1) => PluginDisposable;
    registerCommand: (registration: PluginApiCommandRegistrationV1) => PluginDisposable;
    registerNotificationCategory: (registration: PluginApiNotificationCategoryRegistrationV1) => PluginDisposable;
    registerNotificationChannel: (registration: PluginApiNotificationChannelRegistrationV1) => PluginDisposable;
    registerScmHostingProvider: (registration: ScmHostingProviderRuntimeRegistration) => PluginDisposable;
    registerScmBackend: (registration: ScmBackendRuntimeRegistration) => PluginDisposable;
    registerMcpServer: (registration: PluginApiMcpServerRegistrationV1) => PluginDisposable;
    registerMcpDiscoveryProvider: (registration: PluginApiMcpDiscoveryProviderRegistrationV1) => PluginDisposable;
    registerRequestInterceptor: (registration: PluginApiRequestInterceptorRegistrationV1) => PluginDisposable;
    registerHook: <THookId extends PluginHookIdV1>(
        registration: PluginApiHookRegistrationV1<THookId>,
    ) => PluginDisposable;
    registerLifecycleHandler: (registration: PluginApiLifecycleHandlerRegistrationV1) => PluginDisposable;
    onDispose: (disposable: PluginDisposable) => PluginDisposable;
}>;

export type PluginApiV1<
    TRegisterMethods extends PluginApiRegisterMethodMapV1 = Record<never, never>,
> = Readonly<PluginApiCoreV1 & TRegisterMethods>;
