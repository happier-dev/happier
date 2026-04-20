import type { ExtensionSourceTrustPolicyV1 } from '@happier-dev/protocol';

export type FileBackedExtensionActivationSource = Readonly<{
    kind: 'file_backed';
    entryPath: string;
    trustPolicy?: ExtensionSourceTrustPolicyV1;
}>;

export type BundledExtensionActivationSource<TModule> = Readonly<{
    kind: 'bundled';
    /**
     * Stable identity for caching/diagnostics. In PS-04 this should come from the
     * generated bundled entry map (for example a package subpath).
     */
    moduleId: string;
    load: () => Promise<TModule>;
}>;

export type ExtensionActivationSource<TModule> =
    | FileBackedExtensionActivationSource
    | BundledExtensionActivationSource<TModule>;
