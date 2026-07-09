import type { PluginSourceTrustPolicyV1 } from '@happier-dev/protocol';

export type FileBackedPluginActivationSource = Readonly<{
    kind: 'file_backed';
    entryPath: string;
    devEntryPath?: string | null;
    trustPolicy?: PluginSourceTrustPolicyV1;
}>;

export type BundledPluginActivationSource<TModule> = Readonly<{
    kind: 'bundled';
    /**
     * Stable identity for caching/diagnostics. In PS-04 this should come from the
     * generated bundled entry map (for example a package subpath).
     */
    moduleId: string;
    load: () => Promise<TModule>;
}>;

export type PluginActivationSource<TModule> =
    | FileBackedPluginActivationSource
    | BundledPluginActivationSource<TModule>;
