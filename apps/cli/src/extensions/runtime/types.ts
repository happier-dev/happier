import type { PluginCompatibilityDiagnostic } from '@/extensions/plugins/shared/pluginDiagnostics';
import type { ResolvedHookRegistration } from '@/extensions/registry/types';

export type PluginDaemonModuleNamespace = Readonly<Record<string, unknown>> & Readonly<{
    default?: unknown;
}>;

export type PluginHookHandler = (...args: readonly unknown[]) => unknown | Promise<unknown>;

export type ResolvedPluginHookHandler = Readonly<{
    pluginId: string;
    hookId: string;
    priority: number;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    exportName: string;
    registration: ResolvedHookRegistration;
    handler: PluginHookHandler;
}>;

export type ResolvedPluginHookHandlerRegistry = Readonly<{
    handlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;
