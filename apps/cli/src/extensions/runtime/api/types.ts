import type { ExtensionPermissionCapabilityV1, ExtensionRuntimeCapabilityFamilyV1 } from '@happier-dev/protocol';
import type {
    ExtensionApiV1,
    ExtensionApiActionRegistrationV1,
    ExtensionApiBackendEngineRegistrationV1,
    ExtensionApiBackendRegistrationV1,
    ExtensionApiCommandRegistrationV1,
    ExtensionApiHookRegistrationV1,
    ExtensionApiLifecycleHandlerRegistrationV1,
    ExtensionApiProviderRegistrationV1,
    ExtensionApiResourceRegistrationV1,
    ExtensionApiRuntimeAdapterRegistrationV1,
    ExtensionApiToolRegistrationV1,
    ExtensionApiUiDescriptorRegistrationV1,
} from '@happier-dev/extension-sdk';

import type { PluginCompatibilityDiagnostic } from '@/extensions/diagnostics/types';

export type PluginDisposable = import('@happier-dev/extension-sdk').PluginDisposable;
export type PluginExtensionApiHostPolicy = Readonly<{
    pluginId?: string;
    runtimeCapabilities?: readonly ExtensionRuntimeCapabilityFamilyV1[];
    permissions?: readonly ExtensionPermissionCapabilityV1[];
}>;

export type PluginExtensionApi = ExtensionApiV1;

export type PluginExtensionApiProviderRegistration = ExtensionApiProviderRegistrationV1;
export type PluginExtensionApiBackendRegistration = ExtensionApiBackendRegistrationV1;
export type PluginExtensionApiBackendEngineRegistration = ExtensionApiBackendEngineRegistrationV1;
export type PluginExtensionApiActionRegistration = ExtensionApiActionRegistrationV1;
export type PluginExtensionApiToolRegistration = ExtensionApiToolRegistrationV1;
export type PluginExtensionApiCommandRegistration = ExtensionApiCommandRegistrationV1;
export type PluginExtensionApiResourceRegistration = ExtensionApiResourceRegistrationV1;
export type PluginExtensionApiUiDescriptorRegistration = ExtensionApiUiDescriptorRegistrationV1;
export type PluginExtensionApiHookRegistration = ExtensionApiHookRegistrationV1;
export type PluginExtensionApiLifecycleHandlerRegistration = ExtensionApiLifecycleHandlerRegistrationV1;
export type PluginExtensionApiRuntimeAdapterRegistration = ExtensionApiRuntimeAdapterRegistrationV1;

export type PluginExtensionApiRegistrations = Readonly<{
    providers: readonly PluginExtensionApiProviderRegistration[];
    backends: readonly PluginExtensionApiBackendRegistration[];
    backendEngines: readonly PluginExtensionApiBackendEngineRegistration[];
    actions: readonly PluginExtensionApiActionRegistration[];
    tools: readonly PluginExtensionApiToolRegistration[];
    commands: readonly PluginExtensionApiCommandRegistration[];
    resources: readonly PluginExtensionApiResourceRegistration[];
    uiDescriptors: readonly PluginExtensionApiUiDescriptorRegistration[];
    hooks: readonly PluginExtensionApiHookRegistration[];
    lifecycleHandlers: readonly PluginExtensionApiLifecycleHandlerRegistration[];
    runtimeAdapters: readonly PluginExtensionApiRuntimeAdapterRegistration[];
    disposables: readonly PluginDisposable[];
    diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;
