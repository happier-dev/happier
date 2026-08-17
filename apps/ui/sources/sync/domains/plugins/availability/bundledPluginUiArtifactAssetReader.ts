import { Asset } from 'expo-asset';

import type { BundledPluginUiAppArtifactFile } from './bundledPluginUiArtifactInventory';

type ExpoFileSystemFile = Readonly<{
    exists: boolean;
    bytes: () => Promise<Uint8Array>;
}>;

type ExpoFileSystemModule = Readonly<{
    File: new (uri: string) => ExpoFileSystemFile;
}>;

async function readLocalFileBytes(uri: string): Promise<Uint8Array | null> {
    try {
        const FileSystem = await import('expo-file-system') as ExpoFileSystemModule;
        const file = new FileSystem.File(uri);
        if (!file.exists) return null;
        return new Uint8Array(await file.bytes());
    } catch {
        return null;
    }
}

/**
 * Reads an already-packaged static app asset. This is intentionally neither a
 * cache nor a source selector: the caller supplies a generated exact asset
 * module, and any failure simply leaves this source unavailable.
 */
export async function readBundledPluginUiAppArtifactAssetBytes(
    assetModule: BundledPluginUiAppArtifactFile['asset'],
): Promise<Uint8Array | null> {
    try {
        const asset = Asset.fromModule(assetModule);
        await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        if (!uri) return null;
        if (uri.startsWith('file:')) {
            const localBytes = await readLocalFileBytes(uri);
            if (localBytes) return localBytes;
        }
        const response = await fetch(uri);
        if (!response.ok) return null;
        return new Uint8Array(await response.arrayBuffer());
    } catch {
        return null;
    }
}
