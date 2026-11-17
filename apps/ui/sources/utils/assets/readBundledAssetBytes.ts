import { Asset } from 'expo-asset';

type ExpoFileSystemFile = Readonly<{
    exists: boolean;
    bytes: () => Promise<Uint8Array>;
}>;

type ExpoFileSystemModule = Readonly<{
    File: new (uri: string) => ExpoFileSystemFile;
}>;

class BundledAssetReadError extends Error {
    constructor(
        readonly code: 'bundled_asset_http_error' | 'bundled_asset_uri_missing' | 'bundled_asset_read_failed',
        readonly status?: number,
        cause?: unknown,
    ) {
        super(code, { cause });
    }
}

async function readLocalFileBytes(uri: string): Promise<Uint8Array | null> {
    try {
        const FileSystem = await import('expo-file-system') as ExpoFileSystemModule;
        const file = new FileSystem.File(uri);
        if (!file.exists) return null;
        return new Uint8Array(await file.bytes());
    } catch {
        // The existing fetch fallback can still acquire this packaged asset.
        return null;
    }
}

/** Reads exact packaged bytes; acquisition failures retain their code and cause. */
export async function readBundledAssetBytes(
    assetModule: Parameters<typeof Asset.fromModule>[0],
): Promise<Uint8Array> {
    try {
        const asset = Asset.fromModule(assetModule);
        await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        if (!uri) throw new BundledAssetReadError('bundled_asset_uri_missing');
        if (uri.startsWith('file:')) {
            const localBytes = await readLocalFileBytes(uri);
            if (localBytes) return localBytes;
        }
        const response = await fetch(uri);
        if (!response.ok) throw new BundledAssetReadError('bundled_asset_http_error', response.status);
        return new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
        if (cause instanceof BundledAssetReadError) throw cause;
        throw new BundledAssetReadError('bundled_asset_read_failed', undefined, cause);
    }
}
