import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { ResolvedHookRegistration } from '@/plugins/projection/registry/types';
import type {
    PluginActionHandler as SdkPluginActionHandler,
    PluginActionHandlerRequest as SdkPluginActionHandlerRequest,
    PluginActionResultV1 as SdkPluginActionResultV1,
    PluginActionSurface as SdkPluginActionSurface,
    PluginHandlerServicesV1,
} from '@happier-dev/plugin-sdk';

export type PluginDaemonModuleNamespace = Readonly<Record<string, unknown>> & Readonly<{
    default?: unknown;
}>;

export type PluginHookHandler = (...args: readonly unknown[]) => unknown | Promise<unknown>;

export type PluginRuntimeHookHandler = (event?: unknown, context?: unknown) => unknown | Promise<unknown>;

export type PluginActionSurface = SdkPluginActionSurface;
export type PluginActionHandlerRequest = Omit<SdkPluginActionHandlerRequest, 'context'> & Readonly<{
    context: Omit<SdkPluginActionHandlerRequest['context'], keyof PluginHandlerServicesV1>;
}>;
export type PluginActionResult = SdkPluginActionResultV1;
export type PluginActionHandler = (
    request: PluginActionHandlerRequest,
) => PluginActionResult | Promise<PluginActionResult>;
export type PluginSdkActionHandler = SdkPluginActionHandler;

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

export type ResolvedPluginHookHandler = Readonly<{
    pluginId: string;
    hookId: string;
    priority: number;
    registrationIndex: number;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    exportName: string;
    registration: ResolvedHookRegistration;
    handler: PluginRuntimeHookHandler;
}>;

export type ResolvedPluginLifecycleHandler = Readonly<{
    pluginId: string;
    lifecycleEvent: PluginLifecycleEvent;
    registrationId: string;
    priority: number;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    sourceKind?: string;
    handler: PluginLifecycleHandler;
}>;

export type ResolvedPluginHookHandlerRegistry = Readonly<{
    handlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;
