import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import type { PluginInvocationSurface } from '@happier-dev/plugin-sdk/runtime';

export type PluginDaemonModuleNamespace = Readonly<Record<string, unknown>> & Readonly<{
    default?: unknown;
}>;

export type PluginHookHandler = (...args: readonly unknown[]) => unknown | Promise<unknown>;

export type PluginRuntimeHookHandler = (event?: unknown, context?: unknown) => unknown | Promise<unknown>;

export type PluginActionSurface = PluginInvocationSurface;

export type ResolvedPluginHookHandler = Readonly<{
    pluginId: string;
    /** Canonical manifest-local registration identity for activation-owned hooks. */
    localId?: string;
    hookId: string;
    priority: number;
    registrationIndex: number;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    registration: ResolvedActivatedHookRegistration;
    handler: PluginRuntimeHookHandler;
}>;

export type ResolvedPluginHookHandlerRegistry = Readonly<{
    handlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;
