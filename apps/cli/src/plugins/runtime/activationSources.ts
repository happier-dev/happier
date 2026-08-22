import type { PluginSourceTrustPolicyV1 } from '@happier-dev/protocol';
import type { PluginDistributionIdentity, PluginTrustRecord } from '@/plugins/store/install/trustIdentity';

export type PluginRelativeModuleResolution<TModule> = Readonly<{
    module: TModule;
    normalizedModulePath: string;
    loadMode: 'immutable-js' | 'source-ts';
}>;

export type PluginRelativeModuleResolver<TModule> = (
    module: string,
) => Promise<PluginRelativeModuleResolution<TModule>>;

export type ValidatedAgentSessionRunnerFactoryFactV1 = Readonly<{
    localAgentId: string;
    locator: Readonly<{
        module: string;
        export: string;
        runtimeApiVersion: 1;
        externalSessionsExport?: string;
    }>;
    normalizedModulePath: string;
    loadMode: 'immutable-js' | 'source-ts';
}>;

export type CommittedPluginExecutionAuthorization = Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    distribution: PluginDistributionIdentity;
    trust: PluginTrustRecord;
    isCurrent: () => Promise<boolean>;
}>;

export type FileBackedPluginActivationSource = Readonly<{
    kind: 'file_backed';
    entryPath: string;
    devEntryPath?: string | null;
    useDevelopmentEntry?: boolean;
    trustPolicy?: PluginSourceTrustPolicyV1;
    committedAuthorization?: CommittedPluginExecutionAuthorization;
    generationScope?: object;
    resolveRelativeModule?: PluginRelativeModuleResolver<Record<string, unknown>>;
    persistValidatedAgentSessionRunnerFactories?: (
        facts: readonly ValidatedAgentSessionRunnerFactoryFactV1[],
    ) => Promise<void>;
}>;

export type BundledPluginActivationSource<TModule> = Readonly<{
    kind: 'bundled';
    /**
     * Stable identity for caching/diagnostics. In PS-04 this should come from the
     * generated bundled entry map (for example a package subpath).
     */
    moduleId: string;
    /**
     * Optional retry-safe work that must complete before module top-level code
     * can execute. Activation lifecycle owners may retry this phase without
     * risking duplicate module or activate() side effects.
     */
    prepare?: () => Promise<void>;
    load: () => Promise<TModule>;
    resolveRelativeModule?: PluginRelativeModuleResolver<Record<string, unknown>>;
    persistValidatedAgentSessionRunnerFactories?: (
        facts: readonly ValidatedAgentSessionRunnerFactoryFactV1[],
    ) => Promise<void>;
}>;

export type PreparedPluginActivationSource<TModule> = Readonly<{
    kind: 'prepared';
    module: TModule;
    committedAuthorization: CommittedPluginExecutionAuthorization;
    resolveRelativeModule?: PluginRelativeModuleResolver<Record<string, unknown>>;
    persistValidatedAgentSessionRunnerFactories?: (
        facts: readonly ValidatedAgentSessionRunnerFactoryFactV1[],
    ) => Promise<void>;
}>;

export type PluginActivationSource<TModule> =
    | FileBackedPluginActivationSource
    | BundledPluginActivationSource<TModule>
    | PreparedPluginActivationSource<TModule>;
