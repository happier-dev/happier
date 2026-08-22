import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import type { PluginInvocationSurface } from '@happier-dev/plugin-sdk/interactions';

export type PluginDaemonModuleNamespace = Readonly<Record<string, unknown>> & Readonly<{
    default?: unknown;
}>;

declare const PreparedPluginActivationGraphBrand: unique symbol;

/** One process-local TypeScript graph evaluated from an owned immutable generation. */
export type PreparedPluginActivationGraph = Readonly<{
    [PreparedPluginActivationGraphBrand]: true;
    module: PluginDaemonModuleNamespace;
    generationScope: object;
    immutableGenerationId: string;
    rootPath: string;
    entryPath: string;
}>;

export function createPreparedPluginActivationGraph(input: Readonly<{
    module: PluginDaemonModuleNamespace;
    generationScope: object;
    immutableGenerationId: string;
    rootPath: string;
    entryPath: string;
}>): PreparedPluginActivationGraph {
    return Object.freeze({ ...input }) as PreparedPluginActivationGraph;
}

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
    daemonEntryPath: string;
    registration: ResolvedActivatedHookRegistration;
    handler: PluginRuntimeHookHandler;
}>;

export type ResolvedPluginHookHandlerRegistry = Readonly<{
    handlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;
