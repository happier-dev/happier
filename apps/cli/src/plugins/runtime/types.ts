import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { ResolvedHookRegistration } from '@/plugins/projection/registry/types';

export type PluginDaemonModuleNamespace = Readonly<Record<string, unknown>> & Readonly<{
    default?: unknown;
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
    handler: PluginHookHandler;
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
