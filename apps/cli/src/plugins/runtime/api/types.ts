import type { PluginPermissionCapabilityV1, PluginRuntimeCapabilityFamilyV1 } from '@happier-dev/protocol';
import type {
    PluginApiV1,
    PluginApiActionRegistrationV1,
    PluginApiBackendEngineRegistrationV1,
    PluginApiCommandRegistrationV1,
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
    id?: string;
    canonicalId?: string;
    event: PluginApiLifecycleHandlerRegistrationV1['event'];
}>;

export type PluginApiHostPolicy = Readonly<{
    pluginId?: string;
    runtimeCapabilities?: readonly (PluginRuntimeCapabilityFamilyV1 | string)[];
    permissions?: readonly PluginPermissionCapabilityV1[];
    declaredBackendIds?: readonly string[];
    declaredActionIds?: readonly string[];
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

export type PluginApiBackendEngineRegistration = PluginApiBackendEngineRegistrationV1;
export type PluginApiActionRegistration = PluginApiActionRegistrationV1;
export type PluginApiToolRegistration = PluginApiToolRegistrationV1;
export type PluginApiCommandRegistration = PluginApiCommandRegistrationV1;
export type PluginApiHookRegistration = PluginApiHookRegistrationV1;
export type PluginApiLifecycleHandlerRegistration = PluginApiLifecycleHandlerRegistrationV1;
export type PluginApiNotificationCategoryRegistration = PluginApiNotificationCategoryRegistrationV1;
export type PluginApiNotificationChannelRegistration = PluginApiNotificationChannelRegistrationV1;
export type PluginApiRequestInterceptorRegistration = PluginApiRequestInterceptorRegistrationV1;
export type PluginApiScmHostingProviderRegistration = ScmHostingProviderRuntimeRegistration;
export type PluginApiScmBackendRegistration = ScmBackendRuntimeRegistration;
export type PluginApiMcpServerRegistration = PluginApiMcpServerRegistrationV1;
export type PluginApiMcpDiscoveryProviderRegistration = PluginApiMcpDiscoveryProviderRegistrationV1;

export type PluginApiRegistrations = Readonly<{
    backendEngines: readonly PluginApiBackendEngineRegistration[];
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
