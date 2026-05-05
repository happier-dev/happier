import type { PluginPermissionCapabilityV1, PluginRuntimeCapabilityFamilyV1 } from '@happier-dev/protocol';
import type {
    PluginApiV1,
    PluginApiActionRegistrationV1,
    PluginApiBackendEngineRegistrationV1,
    PluginApiCommandRegistrationV1,
    PluginApiHookRegistrationV1,
    PluginApiLifecycleHandlerRegistrationV1,
    PluginApiNotificationCategoryRegistrationV1,
    PluginApiNotificationChannelRegistrationV1,
    PluginApiRequestInterceptorRegistrationV1,
    PluginApiRegisterMethodV1,
    PluginApiResourceRegistrationV1,
    ScmHostingProviderRuntimeRegistration,
    PluginApiToolRegistrationV1,
    PluginApiUiDescriptorRegistrationV1,
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

export type PluginApiHostPolicy = Readonly<{
    pluginId?: string;
    runtimeCapabilities?: readonly (PluginRuntimeCapabilityFamilyV1 | string)[];
    permissions?: readonly PluginPermissionCapabilityV1[];
    declaredBackendIds?: readonly string[];
    declaredNotificationCategoryIds?: readonly string[];
    declaredNotificationChannelIds?: readonly string[];
    declaredScmHostingProviderIds?: readonly string[];
    registerMethods?: Readonly<Record<string, PluginApiHostRegisterMethod>>;
}>;

export type PluginApiHostRegisterMethodMap = Readonly<Record<string, PluginApiRegisterMethodV1<never>>>;

export type PluginApi = PluginApiV1<PluginApiHostRegisterMethodMap>;

export type PluginApiBackendEngineRegistration = PluginApiBackendEngineRegistrationV1;
export type PluginApiActionRegistration = PluginApiActionRegistrationV1;
export type PluginApiToolRegistration = PluginApiToolRegistrationV1;
export type PluginApiCommandRegistration = PluginApiCommandRegistrationV1;
export type PluginApiResourceRegistration = PluginApiResourceRegistrationV1;
export type PluginApiUiDescriptorRegistration = PluginApiUiDescriptorRegistrationV1;
export type PluginApiHookRegistration = PluginApiHookRegistrationV1;
export type PluginApiLifecycleHandlerRegistration = PluginApiLifecycleHandlerRegistrationV1;
export type PluginApiNotificationCategoryRegistration = PluginApiNotificationCategoryRegistrationV1;
export type PluginApiNotificationChannelRegistration = PluginApiNotificationChannelRegistrationV1;
export type PluginApiRequestInterceptorRegistration = PluginApiRequestInterceptorRegistrationV1;
export type PluginApiScmHostingProviderRegistration = ScmHostingProviderRuntimeRegistration;

export type PluginApiRegistrations = Readonly<{
    backendEngines: readonly PluginApiBackendEngineRegistration[];
    actions: readonly PluginApiActionRegistration[];
    tools: readonly PluginApiToolRegistration[];
    commands: readonly PluginApiCommandRegistration[];
    resources: readonly PluginApiResourceRegistration[];
    uiDescriptors: readonly PluginApiUiDescriptorRegistration[];
    notificationCategories: readonly PluginApiNotificationCategoryRegistration[];
    notificationChannels: readonly PluginApiNotificationChannelRegistration[];
    scmHostingProviders: readonly PluginApiScmHostingProviderRegistration[];
    requestInterceptors: readonly PluginApiRequestInterceptorRegistration[];
    hooks: readonly PluginApiHookRegistration[];
    lifecycleHandlers: readonly PluginApiLifecycleHandlerRegistration[];
    disposables: readonly PluginDisposable[];
    diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;
