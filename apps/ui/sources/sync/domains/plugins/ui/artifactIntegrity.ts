import { Platform } from 'react-native';
import {
    computePluginUiArtifactSha256DigestV1 as computeBytesDigest,
    computePluginUiArtifactFileSetSha256DigestV1 as computeFileSetDigest,
    type PluginUiArtifactDigestV1,
    type PluginUiArtifactFileSetEntryV1,
} from '@happier-dev/protocol/plugins/ui';
import { digest } from '@/platform/digest';

const sha256Bytes = (bytes: Uint8Array) => digest('SHA-256', bytes);

function hasPlatformDigest(): boolean {
    // Preserve loading on existing insecure web origins, where WebCrypto is
    // unavailable. Native and secure web hosts use the existing platform owner.
    return Platform.OS !== 'web' || typeof globalThis.crypto?.subtle?.digest === 'function';
}

export async function computePluginUiArtifactSha256Digest(bytes: Uint8Array): Promise<PluginUiArtifactDigestV1> {
    return hasPlatformDigest() ? computeBytesDigest(bytes, sha256Bytes) : computeBytesDigest(bytes);
}

export async function computePluginUiArtifactFileSetSha256Digest(files: readonly PluginUiArtifactFileSetEntryV1[]): Promise<PluginUiArtifactDigestV1> {
    return hasPlatformDigest() ? computeFileSetDigest(files, sha256Bytes) : computeFileSetDigest(files);
}
