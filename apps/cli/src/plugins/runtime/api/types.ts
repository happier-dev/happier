import type {
    PluginHookIdV1,
    PluginActionContributionV2,
    PluginPermissionCapabilityV1,
    PluginRuntimeCapabilityFamilyV1,
} from '@happier-dev/protocol';
import type {
    PluginApiV1,
    PluginApiActionRegistrationV1,
    PluginApiAgentRuntimeRegistrationV1,
    PluginApiCommandRegistrationV1,
    PluginApiDaemonAuthBridgeRegistrationV1,
    PluginApiHookRegistrationV1,
    PluginApiLifecycleHandlerRegistrationV1,
    PluginApiMcpDiscoveryProviderRegistrationV1,
    PluginApiMcpServerRegistrationV1,
    PluginApiNotificationCategoryRegistrationV1,
    PluginApiNotificationChannelRegistrationV1,
    PluginApiRequestInterceptorRegistrationV1,
    PluginApiRegisterMethodV1,
    ScmBackendRuntimeRegistration,
    ScmHostingProviderRuntimeRegistration,
    PluginApiToolRegistrationV1,
} from '@happier-dev/plugin-sdk';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

export type PluginDisposable = import('@happier-dev/plugin-sdk').PluginDisposable;

export type PluginApiHostRegisterMethodContext = Readonly<{
    pluginId?: string;
    addDisposable: (disposable: PluginDisposable) => PluginDisposable;
    appendDiagnostic: (diagnostic: PluginCompatibilityDiagnostic) => PluginDisposable;
}>;

export type PluginApiHostRegisterMethod = Readonly<{
    family: string;
    requiredPermission?: PluginPermissionCapabilityV1;
    register: (
        registration: unknown,
        context: PluginApiHostRegisterMethodContext,
    ) => PluginDisposable;
}>;

export type PluginApiHostLifecycleHandlerDeclaration = Readonly<{
    id: string;
    event: PluginApiLifecycleHandlerRegistrationV1['event'];
}>;

export type PluginApiHostPolicy = Readonly<{
    pluginId?: string;
    runtimeCapabilities?: readonly (PluginRuntimeCapabilityFamilyV1 | string)[];
    permissions?: readonly PluginPermissionCapabilityV1[];
    declaredAgentIds?: readonly string[];
    declaredActionIds?: readonly string[];
    declaredActions?: readonly PluginActionContributionV2[];
    declaredToolIds?: readonly string[];
    declaredCommandIds?: readonly string[];
    declaredHookIds?: readonly string[];
    declaredLifecycleHandlerIds?: readonly string[];
    declaredLifecycleHandlers?: readonly PluginApiHostLifecycleHandlerDeclaration[];
    declaredNotificationCategoryIds?: readonly string[];
    declaredNotificationChannelIds?: readonly string[];
    declaredScmHostingProviderIds?: readonly string[];
    declaredScmBackendIds?: readonly string[];
    declaredRequestInterceptorIds?: readonly string[];
    declaredMcpServerIds?: readonly string[];
    declaredMcpDiscoveryProviderIds?: readonly string[];
    registerMethods?: Readonly<Record<string, PluginApiHostRegisterMethod>>;
}>;

export type PluginApiHostRegisterMethodMap = Readonly<Record<string, PluginApiRegisterMethodV1<never>>>;

export type PluginApi = PluginApiV1<PluginApiHostRegisterMethodMap>;

export type PluginApiAgentRuntimeRegistration = PluginApiAgentRuntimeRegistrationV1;
export type PluginApiDaemonAuthBridgeRegistration = PluginApiDaemonAuthBridgeRegistrationV1;
export type PluginApiActionRegistration = PluginApiActionRegistrationV1;
export type PluginApiToolRegistration = PluginApiToolRegistrationV1;
export type PluginApiCommandRegistration = PluginApiCommandRegistrationV1;
export type PluginApiHookRegistration<THookId extends PluginHookIdV1 = PluginHookIdV1> =
    THookId extends PluginHookIdV1 ? PluginApiHookRegistrationV1<THookId> : never;
export type PluginApiLifecycleHandlerRegistration = PluginApiLifecycleHandlerRegistrationV1;
export type PluginApiNotificationCategoryRegistration = PluginApiNotificationCategoryRegistrationV1;
export type PluginApiNotificationChannelRegistration = PluginApiNotificationChannelRegistrationV1;
export type PluginApiRequestInterceptorRegistration = PluginApiRequestInterceptorRegistrationV1;
export type PluginApiScmHostingProviderRegistration = ScmHostingProviderRuntimeRegistration;
export type PluginApiScmBackendRegistration = ScmBackendRuntimeRegistration;
export type PluginApiMcpServerRegistration = PluginApiMcpServerRegistrationV1;
export type PluginApiMcpDiscoveryProviderRegistration = PluginApiMcpDiscoveryProviderRegistrationV1;

export type PluginApiRegistrations = Readonly<{
    agentRuntimes: readonly PluginApiAgentRuntimeRegistration[];
    daemonAuthBridges: readonly PluginApiDaemonAuthBridgeRegistration[];
    actions: readonly PluginApiActionRegistration[];
    tools: readonly PluginApiToolRegistration[];
    commands: readonly PluginApiCommandRegistration[];
    notificationCategories: readonly PluginApiNotificationCategoryRegistration[];
    notificationChannels: readonly PluginApiNotificationChannelRegistration[];
    scmHostingProviders: readonly PluginApiScmHostingProviderRegistration[];
    scmBackends: readonly PluginApiScmBackendRegistration[];
    mcpServers: readonly PluginApiMcpServerRegistration[];
    mcpDiscoveryProviders: readonly PluginApiMcpDiscoveryProviderRegistration[];
    requestInterceptors: readonly PluginApiRequestInterceptorRegistration[];
    hooks: readonly PluginApiHookRegistration[];
    lifecycleHandlers: readonly PluginApiLifecycleHandlerRegistration[];
    disposables: readonly PluginDisposable[];
    diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;
