import type {
    PluginActionContributionV2,
    PluginCommandContributionV2,
    PluginHookContributionV2,
    PluginHookIdV1,
    PluginNotificationCategoryContributionV2,
    PluginNotificationChannelContributionV2,
    PluginToolContributionV2,
} from '@happier-dev/protocol';

import type { RegisterBackendEngineV1 } from './engine';
import type { PluginApiRequestInterceptorRegistrationV1 } from './fetch';
import type {
    McpDiscoveryProviderReturnV1,
    McpResolveForSessionInputV1,
    McpServerSpecV1,
} from './mcp';
import type { ScmBackendRuntimeRegistration } from './scm/backend';
import type { ScmHostingProviderRuntimeRegistration } from './scm/hostingProvider';

export type { PluginApiRequestInterceptorRegistrationV1 } from './fetch';
export type {
    ScmBackendCommandRunResult,
    ScmBackendRuntimeRegistration,
    ScmBackendRuntimeServices,
} from './scm/backend';

export type PluginDisposable = (() => void | Promise<void>) | Readonly<{
    dispose: () => void | Promise<void>;
}>;

export type PluginHookHandler = (...args: readonly unknown[]) => unknown | Promise<unknown>;

export type PluginActionSurface = 'cli' | 'mcp' | 'session_agent';

export type PluginActionHandlerRequest = Readonly<{
    actionId: string;
    pluginId: string;
    input: unknown;
    context: Readonly<{
        defaultSessionId?: string;
        surface: PluginActionSurface;
    }>;
    provenance: Readonly<{
        manifestPath?: string;
        manifestDigest?: string;
        sourceKind?: string;
    }>;
}>;

export type PluginActionHandler = (request: PluginActionHandlerRequest) => unknown | Promise<unknown>;

export type PluginLifecycleEvent = 'activated' | 'deactivating';

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

export type PluginApiHookRegistrationV1 = Readonly<{
    hookId: PluginHookIdV1;
    priority?: number;
    category?: PluginHookContributionV2['category'];
    scope?: PluginHookContributionV2['scope'];
    filters?: PluginHookContributionV2['filters'];
    executionKind?: PluginHookContributionV2['executionKind'];
    handler: PluginHookHandler;
}>;

export type PluginApiBackendEngineRegistrationV1 = RegisterBackendEngineV1;

export type PluginApiActionRegistrationV1 = Readonly<{
    id: string;
    title: string;
    description?: string | null;
    safety?: PluginActionContributionV2['dangerLevel'];
    scopes?: PluginActionContributionV2['scopes'];
    surfaces?: PluginActionContributionV2['surfaces'];
    surface?: PluginActionContributionV2['surfaces'][number];
    placement?: PluginActionContributionV2['placement'];
    inputSchema?: PluginActionContributionV2['inputSchema'];
    outputSchema?: PluginActionContributionV2['resultSchema'];
    inputHints?: PluginToolContributionV2['inputHints'];
    compatibility?: PluginToolContributionV2['compatibility'];
    examples?: PluginToolContributionV2['examples'];
    handler: PluginActionHandler;
}>;

export type PluginApiToolRegistrationV1 = Readonly<{
    id: string;
    name: string;
    title: string;
    description?: string | null;
    safety?: PluginToolContributionV2['safety'];
    surfaces?: Partial<Record<PluginActionSurface, boolean>>;
    inputSchema?: PluginToolContributionV2['inputSchema'];
    outputSchema?: PluginToolContributionV2['outputSchema'];
    inputHints?: PluginToolContributionV2['inputHints'];
    compatibility?: PluginToolContributionV2['compatibility'];
    examples?: PluginToolContributionV2['examples'];
    handler: PluginActionHandler;
}>;

export type PluginCommandVisibilityV1 = 'default' | 'advanced' | 'internal';

export type PluginApiCommandRegistrationV1 = Readonly<{
    id: string;
    command: string;
    rootHelpLabel?: PluginCommandContributionV2['rootHelpLabel'];
    rootHelpDescription?: PluginCommandContributionV2['rootHelpDescription'];
    rootHelpDetail?: PluginCommandContributionV2['rootHelpDetail'];
    allowTmux: PluginCommandContributionV2['allowTmux'];
    visibility?: PluginCommandVisibilityV1;
    featureGate?: PluginCommandContributionV2['featureGate'];
    actionId?: string;
    handler: PluginActionHandler;
}>;

export type PluginApiLifecycleHandlerRegistrationV1 = Readonly<{
    id?: string;
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
    registerBackendEngine: (registration: PluginApiBackendEngineRegistrationV1) => PluginDisposable;
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
    registerHook: (registration: PluginApiHookRegistrationV1) => PluginDisposable;
    registerLifecycleHandler: (registration: PluginApiLifecycleHandlerRegistrationV1) => PluginDisposable;
    registerDisposable: (disposable: PluginDisposable) => PluginDisposable;
    onDispose: (disposable: PluginDisposable) => PluginDisposable;
}>;

export type PluginApiV1<
    TRegisterMethods extends PluginApiRegisterMethodMapV1 = Record<never, never>,
> = Readonly<PluginApiCoreV1 & TRegisterMethods>;
