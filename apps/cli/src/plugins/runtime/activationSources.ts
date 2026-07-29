import type { PluginSourceTrustPolicyV1 } from '@happier-dev/protocol';
import type { PluginDistributionIdentity, PluginTrustRecord } from '@/plugins/store/install/trustIdentity';

export type CommittedPluginExecutionAuthorization = Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    distribution: PluginDistributionIdentity;
    trust: PluginTrustRecord;
    admittedIntegrity: string;
    packageDigest: string;
    isCurrent: () => Promise<boolean>;
}>;

export type FileBackedPluginActivationSource = Readonly<{
    kind: 'file_backed';
    entryPath: string;
    devEntryPath?: string | null;
    useDevelopmentEntry?: boolean;
    trustPolicy?: PluginSourceTrustPolicyV1;
    committedAuthorization?: CommittedPluginExecutionAuthorization;
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
}>;

export type PluginActivationSource<TModule> =
    | FileBackedPluginActivationSource
    | BundledPluginActivationSource<TModule>;
