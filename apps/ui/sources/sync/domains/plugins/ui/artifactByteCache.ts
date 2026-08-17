import type { PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type PluginUiPersistentArtifactIdentity = Readonly<{
    accountScope: ServerAccountScope;
    releaseVersion: string;
    pluginId: string;
    contributionId: string;
    tier: 'declarative' | 'hostedWeb' | 'reactNative';
    platform: string;
    artifactDigest: PluginUiArtifactDigestV1;
}>;

export type PluginUiPersistentArtifactFile = Readonly<{
    relativePath: string;
    digest: PluginUiArtifactDigestV1;
    byteSize: number;
    bytes: Uint8Array;
}>;

export type PluginUiPersistentArtifactRecord = Readonly<{
    persistentIdentity: PluginUiPersistentArtifactIdentity;
    bytes: Uint8Array;
    entryRelativePath?: string;
    files?: readonly PluginUiPersistentArtifactFile[];
}>;

/**
 * A native frame receives only this opaque cache locator. It never receives an
 * app-private URI, an Account coordinate, or Artifact bytes.
 */
export type PluginUiPersistentArtifactNativeStorageLocator = Readonly<{
    namespace: 'happier-plugin-ui-artifacts-v1';
    accountKeyHash: string;
    artifactKeyHash: string;
}>;

/** A native handler's private stored-file reference, never a manifest path. */
export type PluginUiPersistentArtifactNativeStoredResource = Readonly<{
    storedFileName: string;
    digest: PluginUiArtifactDigestV1;
    byteSize: number;
}>;

export type PluginUiPersistentArtifactNativeResourceDescriptor = Readonly<{
    locator: PluginUiPersistentArtifactNativeStorageLocator;
    /** Aligned with the Artifact-owned declared-file input order. */
    resources: readonly PluginUiPersistentArtifactNativeStoredResource[];
}>;

export type PluginUiPersistentArtifactStore = Readonly<{
    read: (
        identity: PluginUiPersistentArtifactIdentity,
    ) => Promise<PluginUiPersistentArtifactRecord | null>;
    write: (record: PluginUiPersistentArtifactRecord) => Promise<void>;
    remove: (identity: PluginUiPersistentArtifactIdentity) => Promise<void>;
    removeAccount: (scope: ServerAccountScope) => Promise<void>;
}>;

/**
 * Native-only extension of the one verified persistent Artifact cache. The
 * descriptor deliberately exposes hashed cache coordinates and stored names,
 * never an absolute path or file bytes.
 */
export type PluginUiPersistentArtifactNativeResourceStore = PluginUiPersistentArtifactStore & Readonly<{
    describeNativeResource: (input: Readonly<{
        identity: PluginUiPersistentArtifactIdentity;
        files: readonly Readonly<{
            relativePath: string;
            digest: PluginUiArtifactDigestV1;
            byteSize: number;
        }>[];
    }>) => Promise<PluginUiPersistentArtifactNativeResourceDescriptor | null>;
}>;

function encodeIdentityPart(value: string): string {
    return `${new TextEncoder().encode(value).byteLength}:${value}`;
}

export function derivePluginUiPersistentArtifactKey(
    identity: PluginUiPersistentArtifactIdentity,
): string {
    return [
        identity.accountScope.serverId,
        identity.accountScope.accountId,
        identity.pluginId,
        identity.releaseVersion,
        identity.contributionId,
        identity.tier,
        identity.platform,
        identity.artifactDigest,
    ].map(encodeIdentityPart).join('');
}

export function derivePluginUiPersistentArtifactAccountKey(scope: ServerAccountScope): string {
    return [scope.serverId, scope.accountId].map(encodeIdentityPart).join('');
}
